import type { TrpcAuthenticationContext, TrpcContext } from "../src/index.ts";
import { actorAuthentication, createTrpcContext } from "../src/index.ts";
import { trpcContextFactory, trpcContext } from "../src/wire.ts";
import { success } from "@openknot-ts/behavior";
import { ActorAuthenticationError, expose } from "@openknot-ts/flow";
import { actorResolver, executionActorResolver, provideFlow } from "@openknot-ts/flow/wire";
import type { Tracing } from "@openknot-ts/tracing";
import { trace } from "@openknot-ts/tracing/wire";
import { composeModule, defineApplication, optional, providePlugs, runApplication, unit } from "@openknot-ts/wire";
import type { Resolved } from "@openknot-ts/wire";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { initTRPC } from "@trpc/server";
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";

test("connection params authenticate only tRPC's WebSocket adapter, never an HTTP request with an upgrade header", async () => {
  const createContext = createTrpcContext();
  const signal = new AbortController().signal;
  const tokens: string[] = [];
  const resolve = async (token: string) => {
    tokens.push(token);
    return "actor";
  };
  // tRPC's HTTP adapters read `?connectionParams=` from the URL; its WebSocket adapter supplies no URL.
  const http = await createContext({
    req: { headers: { upgrade: "websocket" } },
    info: { signal, connectionParams: { token: "from-url" }, url: new URL("http://localhost/trpc/who") },
  });
  const socket = await createContext({
    req: { headers: { upgrade: "websocket" } },
    info: { signal, connectionParams: { token: "from-socket" }, url: null },
  });
  assert.equal(await http.authenticate(resolve), undefined);
  assert.equal(await socket.authenticate(resolve), "actor");
  assert.deepEqual(tokens, ["from-socket"]);
});

test("a verification that could not finish is retried within the context, while a rejected credential is not", async () => {
  const parent = initTRPC.context<TrpcAuthenticationContext>().create();
  const answers: (() => string | undefined)[] = [
    () => {
      throw new Error("key set unreachable");
    },
    () => "admin",
    () => undefined,
  ];
  let verifications = 0;
  const procedure = parent.procedure.use(
    actorAuthentication(async () => {
      const answer = answers[verifications++];
      return answer?.();
    }),
  );
  const router = parent.router({ who: procedure.query(({ ctx }) => ctx.actor) });
  const signal = new AbortController().signal;
  const context = (): TrpcAuthenticationContext => ({
    actor: undefined,
    signal,
    propagation: {},
    authenticate: async (resolve) => resolve("token", { signal }),
  });
  // One context, as a WebSocket connection keeps for all of its procedures.
  const connection = parent.createCallerFactory(router)(context());
  await assert.rejects(connection.who(), { code: "INTERNAL_SERVER_ERROR" });
  assert.equal(await connection.who(), "admin");
  assert.equal(await connection.who(), "admin");
  const rejected = parent.createCallerFactory(router)(context());
  await assert.rejects(rejected.who(), { code: "UNAUTHORIZED" });
  await assert.rejects(rejected.who(), { code: "UNAUTHORIZED" });
  assert.equal(verifications, 3);
});

test("the library module supplies context without a native tRPC parent or optional capabilities", async () => {
  const app = await runApplication(defineApplication({ modules: [trpcContext] }));
  try {
    const context = app.resolve(trpcContextFactory);
    const signal = new AbortController().signal;
    const { authenticate, ...fields } = await context({ req: { headers: {} }, info: { signal } });
    assert.equal(await authenticate(async () => "unexpected"), undefined);
    assert.deepEqual(fields, {
      actor: undefined,
      signal,
      propagation: {},
    });
  } finally {
    await app.stop();
  }
});

test("the same library module resolves independent context factories and identities in each application", async (t) => {
  const firstIdentity = actorResolver({ resolve: async () => ({ subject: "first" }) });
  const secondIdentity = actorResolver({ resolve: async () => ({ subject: "second" }) });
  const first = await runApplication(defineApplication({ modules: [trpcContext, providePlugs([firstIdentity])] }));
  t.after(() => first.stop());
  const second = await runApplication(defineApplication({ modules: [trpcContext, providePlugs([secondIdentity])] }));
  t.after(() => second.stop());
  const firstContext = first.resolve(trpcContextFactory);
  const secondContext = second.resolve(trpcContextFactory);
  assert.notEqual(firstContext, secondContext);
  const request = {
    req: { headers: { authorization: "Bearer valid" } },
    info: { signal: new AbortController().signal },
  };
  assert.deepEqual(await (await firstContext(request)).authenticate(first.resolve(executionActorResolver)), {
    subject: "first",
  });
  assert.deepEqual(await (await secondContext(request)).authenticate(second.resolve(executionActorResolver)), {
    subject: "second",
  });
});

test("the library module preserves startup failures from explicitly selected capability providers", async () => {
  const failure = new Error("native capability failed");
  const identity = unit({
    provides: executionActorResolver,
    factory: () => {
      throw failure;
    },
  });
  const tracing = unit({
    provides: trace,
    factory: () => {
      throw failure;
    },
  });
  for (const capability of [identity, tracing]) {
    await assert.rejects(
      runApplication(defineApplication({ modules: [trpcContext, providePlugs([capability])] })),
      (cause) => cause === failure,
    );
  }
});

test("native tRPC awaits actor resolution, preserves Flow scopes, and works without optional integrations", async () => {
  for (const authenticated of [false, true]) {
    let resolutions = 0;
    let scopes = 0;
    const seenScopes: number[] = [];
    const session = unit({ lifetime: "scoped", factory: () => ++scopes });
    const parent = unit({ factory: () => initTRPC.context<TrpcAuthenticationContext>().create() });
    const identity = actorResolver({
      resolve: async (token: string) => {
        resolutions++;
        if (token !== "valid") {
          throw ActorAuthenticationError();
        }
        return { subject: "auth0|123", tenant: "airport" };
      },
    });
    const inspect = expose({
      requirements: { session },
      run: (_, ctx) => {
        seenScopes.push(ctx.session);
        return success({ actor: ctx.actor, signalAborted: ctx.signal.aborted });
      },
    });
    const router = unit({
      requirements: { parent, inspect, resolve: optional(executionActorResolver) },
      factory: ({ parent, inspect, resolve }) => {
        const procedure = resolve === undefined ? parent.procedure : parent.procedure.use(actorAuthentication(resolve));
        return parent.router({
          who: procedure.query(async ({ ctx }) => {
            assert.equal(Object.hasOwn(ctx, "token"), false);
            const result = await inspect({
              input: undefined,
              actor: ctx.actor,
              signal: ctx.signal,
              propagation: ctx.propagation,
            });
            return { ...result, propagation: ctx.propagation };
          }),
        });
      },
    });
    const context = unit({ requirements: { context: trpcContextFactory }, factory: ({ context }) => context });
    const app = await runApplication(
      defineApplication({
        modules: [
          trpcContext,
          provideFlow([inspect]),
          providePlugs([parent, router, context]),
          ...(authenticated ? [providePlugs([identity])] : []),
        ],
      }),
    );
    const server = createHTTPServer({ router: app.resolve(router), createContext: app.resolve(context) });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/who`;
    try {
      const request = (authorization?: string) =>
        fetch(url, {
          headers: {
            ...(authorization === undefined ? {} : { authorization }),
            "x-openknot-actor-id": "untrusted",
            traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          },
        });
      const response = await request("Bearer valid");
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        result: {
          data: {
            ...(authenticated ? { actor: { subject: "auth0|123", tenant: "airport" } } : {}),
            signalAborted: false,
            propagation: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
          },
        },
      });
      const anonymous = await request();
      assert.equal(anonymous.status, authenticated ? 401 : 200);
      await anonymous.body?.cancel();
      const client = createTRPCClient<Resolved<typeof router>>({
        links: [httpBatchLink({ url: `http://127.0.0.1:${address.port}`, headers: { authorization: "Bearer valid" } })],
      });
      const before = resolutions;
      const batch = await Promise.all([client.who.query(), client.who.query()]);
      assert.equal(batch.length, 2);
      assert.equal(resolutions, before + (authenticated ? 1 : 0));
      assert.equal(
        new Set(seenScopes).size,
        authenticated ? 3 : 4,
        "Each procedure keeps its own Flow scope even in one authenticated HTTP batch.",
      );
      if (authenticated) {
        for (const authorization of ["Bearer invalid", "Basic invalid"]) {
          const invalid = await request(authorization);
          assert.equal(invalid.status, 401);
          await invalid.body?.cancel();
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await app.stop();
    }
  }
});

test("telemetry is independent of identity and only configured propagator fields enter the context", async () => {
  const parent = unit({ factory: () => initTRPC.context<TrpcContext>().create() });
  const tracing: Tracing = {
    propagationFields: ["baggage"],
    run: async (_, work) => work(),
    capture: () => undefined,
    bind: (work) => work,
  };
  const integration = unit({ provides: trace, factory: () => tracing });
  const app = await runApplication(
    defineApplication({ modules: [trpcContext, composeModule({ providers: { parent, integration } })] }),
  );
  const trpc = app.resolve(parent);
  const server = createHTTPServer({
    router: trpc.router({
      inspect: trpc.procedure.query(({ ctx }) => ({ propagation: ctx.propagation, keys: Object.keys(ctx) })),
    }),
    createContext: app.resolve(trpcContextFactory),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/inspect`, {
      headers: { baggage: "sample=value", traceparent: "unselected", authorization: "Bearer private" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      result: {
        data: {
          propagation: { baggage: "sample=value" },
          keys: ["actor", "signal", "propagation", "authenticate"],
        },
      },
    });
    assert.equal(app.resolve(trace), tracing);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await app.stop();
  }
});
