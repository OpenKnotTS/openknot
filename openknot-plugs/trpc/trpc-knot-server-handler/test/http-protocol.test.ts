import { trpcHandler } from "../src/index.ts";
import { success } from "@openknot-ts/behavior";
import { expose, query, topic } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import { nodeHttpServer } from "@openknot-ts/knot-http-node";
import { composeModule, defineApplication, plug, runApplication, unit } from "@openknot-ts/wire";
import { createTRPCClient, createWSClient, httpBatchLink, httpBatchStreamLink, wsLink } from "@trpc/client";
import { initTRPC, TRPCError } from "@trpc/server";
import type { CreateHTTPContextOptions } from "@trpc/server/adapters/standalone";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import { WebSocketServer } from "ws";

const env = { PORT: "0" };

test(
  "native tRPC options, context, batching, errors and large bodies pass through the HTTP host",
  {
    timeout: 10_000,
  },
  async () => {
    const trpc = initTRPC.context<{ token: string | undefined }>().create();
    const router = trpc.router({
      echo: trpc.procedure
        .input((value: unknown) => {
          assert.equal(typeof value, "string");
          return String(value);
        })
        .mutation(({ input, ctx }) => ({ input, token: ctx.token })),
      token: trpc.procedure.query(({ ctx }) => ctx.token),
      fail: trpc.procedure.query(() => {
        throw new TRPCError({ code: "FORBIDDEN", message: "denied" });
      }),
    });
    const errors: string[] = [];
    const handler = trpcHandler({
      router: unit({ factory: () => router }),
      basePath: "/custom/rpc/",
      maxBodySize: 64,
      createContext: unit({
        factory:
          () =>
          ({ req }: CreateHTTPContextOptions) => ({
            token: req.headers.authorization,
          }),
      }),
      onError: ({ error }) => {
        errors.push(error.code);
      },
      responseMeta: () => ({ headers: { "x-application": "native" } }),
      middleware: (_request, response, next) => {
        response.setHeader("x-middleware", "native");
        next();
      },
    });
    const server = nodeHttpServer({ handler });
    const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { server } })] }), {
      env: { ...env, TRPC_MAX_BODY_SIZE: "Infinity" },
    });
    const url = `${app.resolve(server).url}/custom/rpc`;
    let requests = 0;
    const client = createTRPCClient<typeof router>({
      links: [
        httpBatchLink({
          url,
          headers: { authorization: "token" },
        }),
      ],
    });
    app.resolve(server).native.on("request", () => {
      requests++;
    });
    try {
      assert.deepEqual(await Promise.all([client.token.query(), client.token.query()]), ["token", "token"]);
      assert.equal(requests, 1, "Native tRPC batching remains enabled.");
      for (const path of ["/wrongx/rpc/token", "/custom/rpcXtoken"]) {
        const response = await fetch(`${app.resolve(server).url}${path}`);
        assert.equal(response.status, 404, path);
        await response.body?.cancel();
      }
      const response = await fetch(`${url}/token`);
      assert.equal(response.headers.get("x-application"), "native");
      assert.equal(response.headers.get("x-middleware"), "native");
      await response.text();
      const body = "x".repeat(100_000);
      assert.deepEqual(await client.echo.mutate(body), { input: body, token: "token" });
      await assert.rejects(client.fail.query(), /denied/);
      assert.deepEqual(errors, ["FORBIDDEN"]);
    } finally {
      await app.stop();
    }
  },
);

test(
  "tRPC batch streaming delivers a fast result before the slow operation completes",
  {
    timeout: 10_000,
  },
  async () => {
    const release = Promise.withResolvers<string>();
    const trpc = initTRPC.create();
    const router = trpc.router({
      fast: trpc.procedure.query(() => "fast"),
      slow: trpc.procedure.query(() => release.promise),
    });
    const handler = trpcHandler({ router: unit({ factory: () => router }), basePath: "/rpc/" });
    const server = nodeHttpServer({ handler });
    const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { server } })] }), {
      env,
    });
    const client = createTRPCClient<typeof router>({
      links: [httpBatchStreamLink({ url: `${app.resolve(server).url}/rpc` })],
    });
    try {
      const fast = client.fast.query();
      const slow = client.slow.query();
      assert.equal(await fast, "fast");
      release.resolve("slow");
      assert.equal(await slow, "slow");
    } finally {
      release.resolve("slow");
      await app.stop();
    }
  },
);

test(
  "native tRPC SSE stays streaming and client cancellation releases the subscription",
  {
    timeout: 10_000,
  },
  async () => {
    const closed = Promise.withResolvers<void>();
    const trpc = initTRPC.create();
    const router = trpc.router({
      events: trpc.procedure.subscription(async function* ({ signal }) {
        assert.ok(signal);
        try {
          yield "ready";
          await once(signal, "abort");
        } finally {
          closed.resolve();
        }
      }),
    });
    const handler = trpcHandler({ router: unit({ factory: () => router }), basePath: "/rpc/" });
    const server = nodeHttpServer({ handler });
    const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { server } })] }), {
      env,
    });
    const cancellation = new AbortController();
    try {
      const response = await fetch(`${app.resolve(server).url}/rpc/events`, { signal: cancellation.signal });
      assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
      assert.ok(response.body);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let received = "";
      while (!received.includes("ready")) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        received += decoder.decode(chunk.value, { stream: true });
      }
      cancellation.abort();
      await reader.cancel().catch(() => {});
      await closed.promise;
    } finally {
      cancellation.abort();
      await app.stop();
    }
  },
);

test(
  "the native server hosts tRPC WebSocket queries and subscriptions alongside HTTP",
  {
    timeout: 10_000,
  },
  async () => {
    const trpc = initTRPC.create();
    const router = trpc.router({
      greeting: trpc.procedure.query(() => "hello"),
      events: trpc.procedure.subscription(async function* () {
        yield "event";
      }),
    });
    const handler = trpcHandler({ router: unit({ factory: () => router }), basePath: "/rpc/" });
    const server = nodeHttpServer({ handler });
    const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { server } })] }), {
      env,
    });
    const http = app.resolve(server);
    const wss = new WebSocketServer({ server: http.native, path: "/socket" });
    applyWSSHandler({ wss, router });
    const socket = createWSClient({ url: `${http.url.replace("http:", "ws:")}/socket` });
    const client = createTRPCClient<typeof router>({ links: [wsLink({ client: socket })] });
    try {
      assert.equal(await client.greeting.query(), "hello");
      const message = Promise.withResolvers<string>();
      const subscription = client.events.subscribe(undefined, { onData: message.resolve, onError: message.reject });
      assert.equal(await message.promise, "event");
      subscription.unsubscribe();
      const httpClient = createTRPCClient<typeof router>({ links: [httpBatchLink({ url: `${http.url}/rpc` })] });
      assert.equal(await httpClient.greeting.query(), "hello");
    } finally {
      await socket.close();
      await new Promise<void>((resolve, reject) => wss.close((error) => (error ? reject(error) : resolve())));
      await app.stop();
    }
  },
);

test(
  "a Flow subscription a client keeps open over SSE ends when the application stops instead of holding it",
  {
    timeout: 10_000,
  },
  async () => {
    const changes = topic<"roles", string>()({});
    const output = plug({
      port: changes,
      bind: () => ({
        publish: () => undefined,
        // A native stream that lives until its signal aborts.
        subscribe: async function* (_key, { signal }) {
          yield "ready";
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        },
      }),
    });
    const trpc = initTRPC.create();
    const router = unit({
      requirements: { changes },
      factory: ({ changes }) =>
        trpc.router({
          events: trpc.procedure.subscription(({ signal }) =>
            changes.subscribe({ input: "roles", ...(signal === undefined ? {} : { signal }) }),
          ),
        }),
    });
    const server = nodeHttpServer({ handler: trpcHandler({ router, basePath: "/rpc/" }) });
    const app = await runApplication(
      defineApplication({ modules: [provideFlow([changes]), composeModule({ providers: { server, output } })] }),
      { env, stopOn: [] },
    );
    const response = await fetch(`${app.resolve(server).url}/rpc/events`);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes("ready")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      received += decoder.decode(chunk.value, { stream: true });
    }
    // The client keeps reading; stopping ends the subscription, its response, and then the host.
    const draining = (async () => {
      while (!(await reader.read()).done) {
        // Native keep-alive pings may arrive until the stream ends.
      }
    })().catch(() => undefined);
    await app.stop();
    await draining;
  },
);

test("a request the host admitted before the application began stopping still executes its exposure", async () => {
  const echo = query<string, string>()({ run: (value) => success(value) });
  const endpoint = expose({ handler: echo });
  const trpc = initTRPC.create();
  const router = unit({
    requirements: { endpoint },
    factory: ({ endpoint }) =>
      trpc.router({
        echo: trpc.procedure.input((value: unknown) => String(value)).mutation(({ input }) => endpoint({ input })),
      }),
  });
  const server = nodeHttpServer({ handler: trpcHandler({ router, basePath: "/rpc/" }) });
  const app = await runApplication(
    defineApplication({ modules: [provideFlow([endpoint]), composeModule({ providers: { server } })] }),
    { env, stopOn: [] },
  );
  const { native, url } = app.resolve(server);
  const body = JSON.stringify("drained");
  const call = httpRequest(`${url}/rpc/echo`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
  });
  const response = once(call, "response");
  // The host admits the request once its headers arrive; its body arrives after stopping has begun.
  const admitted = once(native, "request");
  call.flushHeaders();
  await admitted;
  const stopping = app.stop();
  call.end(body);
  const [message] = (await response) as [IncomingMessage];
  let text = "";
  for await (const chunk of message) {
    text += chunk;
  }
  await stopping;
  assert.equal(message.statusCode, 200, text);
  assert.deepEqual(JSON.parse(text), { result: { data: "drained" } });
});
