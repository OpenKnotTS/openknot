import { trpcRouter } from "../src/index.ts";
import { error, failure, success } from "@openknot-ts/behavior";
import { broadcast, command, expose, guard, topic } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import type { TrpcAuthenticationContext } from "@openknot-ts/trpc-context";
import { defineApplication, optional, override, plug, providePlugs, runApplication } from "@openknot-ts/wire";
import { TRPCError } from "@trpc/server";
import assert from "node:assert/strict";
import { test } from "node:test";

const Denied = error("Denied");
const access = guard<string>()({ run: (token) => (token === "ok" ? success() : failure(Denied())) });
const saveRole = command<{ readonly id: string }, string>()({ run: ({ id }) => success(`saved ${id}`) });
const roleInput = (value: unknown) => value as { readonly id: string; readonly token: string };

async function collected<T>(stream: AsyncIterable<T>): Promise<readonly T[]> {
  const values: T[] = [];

  for await (const value of stream) {
    values.push(value);
  }

  return values;
}

const context = (fields: Partial<TrpcAuthenticationContext> = {}): TrpcAuthenticationContext => ({
  signal: new AbortController().signal,
  actor: undefined,
  propagation: {},
  authenticate: async () => undefined,
  ...fields,
});

test("an exposure is a native resolver inside routes and keeps its own form everywhere else", async () => {
  const actors: unknown[] = [];
  const signedIn = guard({
    run: (_input, ctx) => {
      actors.push(ctx.actor);
      return success();
    },
  });
  const createRole = expose({ handler: saveRole, guards: { signedIn } });
  const router = trpcRouter({
    requirements: { createRole },
    routes: ({ trpc, createRole }) => ({ create: trpc.procedure.input(roleInput).mutation(createRole) }),
  });
  const app = await runApplication(defineApplication({ modules: [provideFlow([createRole]), providePlugs([router])] }));
  try {
    const caller = app.resolve(router).createCaller(context({ actor: { userId: "u1" } }));
    assert.equal(await caller.create({ id: "r1", token: "unused" }), "saved r1");
    assert.deepEqual(actors, [{ userId: "u1" }]);
    assert.equal(await app.resolve(createRole)({ input: { id: "r2" } }), "saved r2");
  } finally {
    await app.stop();
  }
});

test("a procedure supplies named guard inputs itself, and an authored failure reaches tRPC unchanged", async () => {
  const createRole = expose({ handler: saveRole, guards: { access } });
  const router = trpcRouter({
    requirements: { createRole },
    routes: ({ trpc, createRole }) => ({
      create: trpc.procedure
        .input(roleInput)
        .mutation(({ input, ctx }) => createRole({ input, ctx, access: input.token })),
    }),
  });
  const app = await runApplication(defineApplication({ modules: [provideFlow([createRole]), providePlugs([router])] }));
  try {
    const caller = app.resolve(router).createCaller(context());
    assert.equal(await caller.create({ id: "r1", token: "ok" }), "saved r1");
    await assert.rejects(
      caller.create({ id: "r1", token: "wrong" }),
      (cause) => cause instanceof TRPCError && cause.code === "INTERNAL_SERVER_ERROR" && Denied.is(cause.cause),
    );
  } finally {
    await app.stop();
  }
});

test("a resolver forwards only what Flow reads", async () => {
  const requests: object[] = [];
  const createRole = expose({ handler: saveRole });
  const router = trpcRouter({
    requirements: { createRole },
    routes: ({ trpc, createRole }) => ({
      create: trpc.procedure
        .input(roleInput)
        .mutation((options) => createRole({ ...options, traceAttributes: { "role.id": options.input.id } })),
    }),
  });
  const app = await runApplication(defineApplication({ modules: [providePlugs([router])] }), {
    overrides: [
      override(createRole, async (request) => {
        requests.push(request);
        return "stub";
      }),
    ],
  });
  try {
    const signal = new AbortController().signal;
    const input = { id: "r1", token: "unused" };
    await app
      .resolve(router)
      .createCaller(context({ signal, actor: "u1" }))
      .create(input);
    assert.deepEqual(requests, [{ input, traceAttributes: { "role.id": "r1" }, signal, actor: "u1", propagation: {} }]);
  } finally {
    await app.stop();
  }
});

test("a query or mutation follows the context's signal, and a subscription also its own", async () => {
  const createRole = expose({ handler: saveRole });
  const logs = broadcast<string>()({});
  const delivery = plug({
    port: logs,
    bind: () => ({
      publish() {},
      async *subscribe() {
        yield "logged";
      },
    }),
  });
  const router = trpcRouter({
    requirements: { createRole, logs },
    routes: ({ trpc, createRole, logs }) => ({
      create: trpc.procedure.input(roleInput).mutation(createRole),
      logs: trpc.procedure.subscription(logs.subscribe),
    }),
  });
  const app = await runApplication(
    defineApplication({ modules: [provideFlow([createRole]), providePlugs([router, delivery])] }),
  );
  const cancelled = (cause: unknown) => cause instanceof TRPCError && cause.code === "CLIENT_CLOSED_REQUEST";
  try {
    const native = app.resolve(router);
    const aborted = native.createCaller(context({ signal: AbortSignal.abort() }));
    const leaving = native.createCaller(context(), { signal: AbortSignal.abort() });
    await assert.rejects(aborted.create({ id: "r1", token: "unused" }), cancelled);
    await assert.rejects(aborted.logs(), cancelled);
    await assert.rejects(leaving.logs(), cancelled);
  } finally {
    await app.stop();
  }
});

test("a topic or broadcast subscribes through a resolver, and publishes as before", async () => {
  const subscribed: string[] = [];
  const published: string[] = [];
  const changes = topic<string, string>()({ guards: { access } });
  const logs = broadcast<string>()({});
  const changesDelivery = plug({
    port: changes,
    bind: () => ({
      publish() {},
      async *subscribe(key: string) {
        subscribed.push(key);
        yield `${key} changed`;
      },
    }),
  });
  const logsDelivery = plug({
    port: logs,
    bind: () => ({
      publish(message: string) {
        published.push(message);
      },
      async *subscribe() {
        yield "logged";
      },
    }),
  });
  const router = trpcRouter({
    requirements: { changes, logs },
    routes: ({ trpc, changes, logs }) => ({
      changes: trpc.procedure
        .input(String)
        .subscription(({ input, ctx }) => changes.subscribe({ input, ctx, access: input === "secret" ? "no" : "ok" })),
      logs: trpc.procedure.subscription(logs.subscribe),
      log: trpc.procedure.mutation(() => logs.publish("published")),
    }),
  });
  const app = await runApplication(
    defineApplication({ modules: [providePlugs([router, changesDelivery, logsDelivery])] }),
  );
  try {
    const caller = app.resolve(router).createCaller(context());
    assert.deepEqual(await collected(await caller.changes("roles")), ["roles changed"]);
    assert.deepEqual(await collected(await caller.logs()), ["logged"]);
    await assert.rejects(caller.changes("secret"));
    assert.deepEqual(subscribed, ["roles"]);
    await caller.log();
    assert.deepEqual(published, ["published"]);
  } finally {
    await app.stop();
  }
});

test("an optional exposure stays absent or arrives as a resolver", async () => {
  const createRole = expose({ handler: saveRole });
  const router = trpcRouter({
    requirements: { createRole: optional(createRole) },
    routes: ({ trpc, createRole }) => ({
      create: trpc.procedure.input(roleInput).mutation((options) => createRole?.(options) ?? "absent"),
    }),
  });
  for (const [modules, expected] of [
    [[providePlugs([router])], "absent"],
    [[provideFlow([createRole]), providePlugs([router])], "saved r1"],
  ] as const) {
    const app = await runApplication(defineApplication({ modules: [...modules] }));
    try {
      const caller = app.resolve(router).createCaller(context());
      assert.equal(await caller.create({ id: "r1", token: "unused" }), expected);
    } finally {
      await app.stop();
    }
  }
});

test("a guard named after a tRPC resolver option fails at startup instead of receiving tRPC's value", async () => {
  for (const name of ["ctx", "path", "batchIndex"]) {
    const createRole = expose({ handler: saveRole, guards: { [name]: access } });
    const router = trpcRouter({
      requirements: { createRole },
      routes: ({ trpc }) => ({ ping: trpc.procedure.query(() => "pong") }),
    });
    await assert.rejects(
      runApplication(defineApplication({ modules: [provideFlow([createRole]), providePlugs([router])] })),
      new RegExp(`Guard name '${name}' collides`),
    );
  }
});
