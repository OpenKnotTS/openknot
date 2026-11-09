import type { RoleEvent, LogEvent } from "../src/app/behavior/events.ts";
import { behavior } from "../src/app/behavior/index.ts";
import { Log } from "../src/app/behavior/models/log.ts";
import { Role } from "../src/app/behavior/models/role.ts";
import { createRoleOp, createLogFromRoleOp } from "../src/app/behavior/operations.ts";
import { createRoleExposure } from "../src/app/flow/exposures.ts";
import { flow } from "../src/app/flow/index.ts";
import { roleChangedListener } from "../src/app/flow/listeners.ts";
import { saveLogWriter, saveRoleWriter, userHasAccessToRole } from "../src/app/flow/ports.ts";
import { application } from "../src/container/application.ts";
import { eventBus, logPublishing } from "../src/plugs/channels/index.ts";
import {
  accessConfig,
  database,
  databaseHealth,
  transaction,
  roles,
  logs,
  io,
  storage,
} from "../src/plugs/io/index.ts";
import { trpcRouter } from "../src/plugs/transport/index.ts";
import type { AppRouter } from "../src/plugs/transport/index.ts";
import { standalone, success } from "@openknot-ts/behavior";
import type { UowActive, UowCommitted } from "@openknot-ts/flow";
import {
  defaultUnitOfWork,
  hook,
  InputCancelledError,
  InternalFlowError,
  unitOfWork,
  upserted,
} from "@openknot-ts/flow";
import { executionActorResolver as actorResolver } from "@openknot-ts/flow/wire";
import { httpServer } from "@openknot-ts/knot-http-node";
import type { PropagationCarrier, TraceSpan, Tracing } from "@openknot-ts/tracing";
import { trace } from "@openknot-ts/tracing/wire";
import { createTrpcContext } from "@openknot-ts/trpc-context";
import { trpcContextFactory } from "@openknot-ts/trpc-context/wire";
import { trpc } from "@openknot-ts/trpc-router";
import type { Application } from "@openknot-ts/wire";
import {
  plug,
  composeModule,
  defineApplication,
  hook as lifecycleHook,
  override,
  runApplication,
  unit,
} from "@openknot-ts/wire";
import { TRPCClientError, createTRPCClient, httpLink } from "@trpc/client";
import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";

const input = { id: "r1", name: "Dispatcher", active: true };
function client(url: string, token = "example-token", headers: Record<string, string> = {}) {
  return createTRPCClient<AppRouter>({
    links: [httpLink({ url: `${url}/trpc`, headers: { authorization: `Bearer ${token}`, ...headers } })],
  });
}
async function status(url: string, path: string): Promise<number> {
  const response = await fetch(`${url}${path}`);
  await response.body?.cancel();
  return response.status;
}
function code(expected: string) {
  return (error: unknown) => error instanceof TRPCClientError && error.data?.code === expected;
}

// Tests run with their own environment: an ephemeral port and the example defaults otherwise.
const testEnv = { PORT: "0" };

test("models validate and normalize state, and expose mutations directly", () => {
  const created = Role.create({ ...input, name: "  Dispatcher  " });
  assert.ok(!created.isError);
  assert.deepEqual(created.value, input);
  assert.ok(Object.isFrozen(created.value));
  const renamed = Role.rename(created.value, "  Manager  ");
  assert.ok(!renamed.isError);
  assert.deepEqual(renamed.value, { ...input, name: "Manager" });
  assert.equal(created.value.name, "Dispatcher");
  assert.equal(Role.rename(created.value, " ").isError, true);
  const log = Log.createFromRole(created.value);
  assert.ok(!log.isError);
  assert.deepEqual(log.value, { id: "r1", action: 'Created role "Dispatcher"' });
});

test("pure operations return created state and their declared events", async () => {
  const role = await standalone(createRoleOp)(input);
  assert.ok(!role.isError);
  assert.deepEqual(role.value.output, { changeType: "created", next: input });
  assert.deepEqual(role.value.events, [{ type: "RoleChanged", role: input }]);
  const log = await standalone(createLogFromRoleOp)(role.value.events[0]!);
  assert.ok(!log.isError);
  assert.deepEqual(log.value.output.next, { id: "r1", action: 'Created role "Dispatcher"' });
  assert.deepEqual(log.value.events, [{ type: "LogCreated", log: log.value.output.next }]);
  const invalid = await standalone(createRoleOp)({ ...input, name: " " });
  assert.ok(invalid.isError && invalid.error.name === "ModelValidationError");
});

test("native persistence writers return upsert results for inserts and updates", async () => {
  const app = await runApplication(application, { env: testEnv });
  try {
    await app.withScope(async (scope) => {
      const saveRole = scope.resolve(saveRoleWriter);
      const inserted = await saveRole(input);
      assert.deepEqual(inserted, upserted(input));
      assert.ok(Object.isFrozen(inserted));
      assert.notEqual(inserted.next, input, "The result is the native returned row, not the submitted object.");
      const changed = { ...input, name: "Manager" };
      const updated = await saveRole(changed);
      assert.deepEqual(updated, upserted(changed));
      assert.deepEqual(await app.resolve(database).select().from(roles), [updated.next]);
      const log = { id: input.id, action: "Stored log" };
      assert.deepEqual(await scope.resolve(saveLogWriter)(log), upserted(log));
      assert.deepEqual(await app.resolve(database).select().from(logs), [log]);
    });
  } finally {
    await app.stop();
  }
});

test("the log listener saves and publishes LogCreated in a partial composition", async () => {
  const app = await runApplication(
    defineApplication({
      modules: [
        behavior,
        flow.includeOnly([roleChangedListener]),
        composeModule({ modules: [io], providers: { logPublishing } }),
      ],
    }),
    { env: testEnv },
  );
  const published: LogEvent[] = [];
  app.resolve(eventBus).on("logCreated", (event) => {
    published.push(event);
  });
  try {
    const log = await app.resolve(roleChangedListener)({ input: { type: "RoleChanged", role: input } });
    assert.deepEqual(await app.resolve(database).select().from(logs), [log]);
    assert.deepEqual(published, [{ type: "LogCreated", log }]);
  } finally {
    await app.stop();
  }
});

test("tRPC create role saves and publishes, then the listener creates the log", { timeout: 5_000 }, async () => {
  const app = await runApplication(application, { env: testEnv });
  const data = app.resolve(database),
    bus = app.resolve(eventBus),
    server = app.resolve(httpServer);
  const received: (RoleEvent | LogEvent)[] = [];
  bus.on("roleChanged", (event) => {
    assert.equal(app.resolve(transaction).session, undefined, "The native transaction closes before publication.");
    received.push(event);
  });
  bus.on("logCreated", (event) => {
    assert.equal(app.resolve(transaction).session, undefined);
    received.push(event);
  });
  try {
    const api = client(server.url, app.resolve(accessConfig).ACCESS_TOKEN);
    assert.equal(await status(server.url, "/health"), 200);
    for (const path of ["/fake/getState", "/trpcxgetState"]) {
      const response = await fetch(`${server.url}${path}`, {
        headers: { authorization: `Bearer ${app.resolve(accessConfig).ACCESS_TOKEN}` },
      });
      assert.equal(response.status, 404, path);
      await response.body?.cancel();
    }
    const anonymous = await fetch(`${server.url}/trpc/getState`);
    assert.equal(anonymous.status, 401);
    assert.partialDeepStrictEqual(await anonymous.json(), {
      error: { data: { code: "UNAUTHORIZED", authenticationError: { type: "ActorAuthenticationError" } } },
    });
    await assert.rejects(client(server.url, "").createRole.mutate(input), code("UNAUTHORIZED"));
    await assert.rejects(client(server.url, "invalid").getState.query(), code("UNAUTHORIZED"));
    await assert.rejects(api.createRole.mutate({ ...input, name: " " }), code("INTERNAL_SERVER_ERROR"));
    // @ts-expect-error The network boundary must reject a wrong primitive type.
    await assert.rejects(api.createRole.mutate({ ...input, active: "yes" }), code("BAD_REQUEST"));
    assert.deepEqual(await data.select().from(roles), []);
    assert.equal(received.length, 0);
    const logged = once(bus, "logCreated");
    assert.deepEqual(await api.createRole.mutate({ ...input, name: "  Dispatcher  " }), input);
    await logged;
    const log = { id: "r1", action: 'Created role "Dispatcher"' };
    assert.deepEqual(await api.getState.query(), { roles: [input], logs: [log] });
    assert.deepEqual(received, [
      { type: "RoleChanged", role: input },
      { type: "LogCreated", log },
    ]);
  } finally {
    await app.stop();
  }
  assert.equal(server.listening, false);
  assert.equal(data.$client.closed, true);
  assert.equal(bus.listenerCount("roleChanged"), 1, "Only the test observer remains after plug cleanup.");
  bus.removeAllListeners();
});

test("HTTP probes follow the lifecycle, and a failing database turns only health down", async () => {
  let databaseUp = true;
  const readiness: string[] = [];
  const observe = (phase: string) =>
    lifecycleHook({
      requirements: { httpServer },
      async run({ httpServer }) {
        readiness.push(`${phase}: ${await status(httpServer.url, "/readyz")}`);
      },
    });
  const { startupTasks, shutdownTasks } = application.options;
  const app = await runApplication(
    defineApplication({
      ...application.options,
      // The host listens before startup tasks and drains after shutdown tasks.
      startupTasks: [...startupTasks, observe("starting")],
      shutdownTasks: [observe("stopping"), ...shutdownTasks],
    }),
    {
      env: testEnv,
      overrides: [override(databaseHealth, { name: "database", check: async () => (databaseUp ? "up" : "down") })],
    },
  );
  try {
    const url = app.resolve(httpServer).url;
    const probes = () => Promise.all(["/livez", "/readyz", "/health"].map((path) => status(url, path)));
    assert.deepEqual(await probes(), [200, 200, 200]);
    databaseUp = false;
    // A failing dependency turns health down without withdrawing readiness or restarting the process.
    assert.deepEqual(await probes(), [200, 200, 503]);
  } finally {
    await app.stop();
  }
  assert.deepEqual(readiness, ["starting: 503", "stopping: 503"]);
});

test("a listener failure stays with the listener: the role is created and the log rolls back", async (t) => {
  const reported = Promise.withResolvers<unknown[]>();
  t.mock.method(console, "error", (...args: unknown[]) => {
    reported.resolve(args);
  });
  const app: Application = await runApplication(application, {
    env: testEnv,
    overrides: [
      override(saveLogWriter, async (log) => {
        const session = await app.resolve(transaction).current();
        assert.ok(session === app.resolve(transaction).session, "The write opens the command's transaction.");
        await session.insert(logs).values(log);
        throw new Error("private storage failure");
      }),
    ],
  });
  const published: LogEvent[] = [];
  app.resolve(eventBus).on("logCreated", (event) => {
    published.push(event);
  });
  try {
    assert.deepEqual(await client(app.resolve(httpServer).url).createRole.mutate(input), input);
    const [message, error] = await reported.promise;
    assert.equal(message, "RoleChanged listener failed");
    assert.ok(InternalFlowError.is(error));
    assert.deepEqual(
      await app.resolve(database).select().from(roles),
      [input],
      "The role UoW committed independently of its log consumer.",
    );
    assert.deepEqual(
      await app.resolve(database).select().from(logs),
      [],
      "The failed log transaction rolls back its real INSERT.",
    );
    assert.deepEqual(published, []);
  } finally {
    await app.stop();
  }
});

test("shutdown drains an admitted listener and unregisters the Node event consumer", async () => {
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const app = await runApplication(application, {
    env: testEnv,
    overrides: [
      override(saveLogWriter, async (log) => {
        entered.resolve();
        await finish.promise;
        return upserted(log);
      }),
    ],
  });
  const bus = app.resolve(eventBus),
    server = app.resolve(httpServer);
  const logged = once(bus, "logCreated");
  const pending = app.resolve(createRoleExposure)({
    input,
    userHasAccessToRoleGuard: undefined,
    actor: { userId: "example-user" },
  });
  await entered.promise;
  const stopping = app.stop();
  try {
    assert.equal(app.status, "stopping");
    finish.resolve();
    assert.deepEqual(await pending, input);
    await logged;
    await stopping;
    assert.equal(server.listening, false);
    assert.equal(bus.listenerCount("roleChanged"), 0);
  } finally {
    finish.resolve();
    await pending;
    await app.stop();
  }
});

test("a request still running when shutdown begins reaches its listener", async (t) => {
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const app = await runApplication(application, {
    env: testEnv,
    overrides: [
      override(saveRoleWriter, async (role) => {
        entered.resolve();
        await finish.promise;
        return upserted(role);
      }),
    ],
  });
  const bus = app.resolve(eventBus),
    server = app.resolve(httpServer);
  const close = server.native.close;
  t.mock.method(server.native, "close", function (this: typeof server.native, callback?: (error?: Error) => void) {
    const result = close.call(this, callback);
    // The command publishes only after the host has stopped intake.
    finish.resolve();
    return result;
  });
  const logged = once(bus, "logCreated", { signal: AbortSignal.timeout(5_000) });
  const request = client(server.url).createRole.mutate(input);
  try {
    await entered.promise;
    await app.stop();
    assert.deepEqual(await request, input);
    await logged;
    assert.equal(bus.listenerCount("roleChanged"), 0);
  } finally {
    finish.resolve();
    await app.stop();
  }
});

test("a request admitted before shutdown begins is still answered while the host drains", async () => {
  const resolving = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const app = await runApplication(application, {
    env: testEnv,
    overrides: [
      override(actorResolver, async () => {
        resolving.resolve();
        await resume.promise;
        return { userId: "example-user" };
      }),
    ],
  });
  const request = client(app.resolve(httpServer).url).getState.query();
  await resolving.promise;
  const stopping = app.stop();
  try {
    resume.resolve();
    assert.deepEqual((await request).roles, []);
  } finally {
    resume.resolve();
    await stopping;
  }
});

test("DI overrides reach tRPC and each application has its own instances and state", async () => {
  let contexts = 0;
  const context = createTrpcContext();
  const first = await runApplication(application, {
    env: testEnv,
    overrides: [
      override(trpcContextFactory, (...args) => {
        contexts++;
        return context(...args);
      }),
    ],
  });
  let second: Awaited<ReturnType<typeof runApplication>> | undefined;
  try {
    second = await runApplication(application, { env: testEnv });
    assert.notEqual(first.resolve(trpc), second.resolve(trpc));
    assert.notEqual(first.resolve(trpcRouter), second.resolve(trpcRouter));
    assert.notEqual(first.resolve(database), second.resolve(database));
    await client(first.resolve(httpServer).url).createRole.mutate(input);
    assert.equal(contexts, 1);
    assert.deepEqual(await client(second.resolve(httpServer).url).getState.query(), { roles: [], logs: [] });
    await first.withScope(async (scope) => {
      const writer = scope.resolve(saveLogWriter);
      assert.equal(writer, scope.resolve(saveLogWriter));
    });
  } finally {
    await Promise.all([first.stop(), second?.stop()]);
  }
});

test("cancellation before admission performs no persistence or publication", async () => {
  const app = await runApplication(application, { env: testEnv });
  try {
    const cancelled = app.resolve(createRoleExposure)({
      input,
      userHasAccessToRoleGuard: undefined,
      actor: { userId: "example-user" },
      signal: AbortSignal.abort(),
    });
    await assert.rejects(cancelled, InputCancelledError.is);
    assert.deepEqual(await app.resolve(database).select().from(roles), []);
    assert.deepEqual(await app.resolve(database).select().from(logs), []);
  } finally {
    await app.stop();
  }
});

test("the application log command publishes after native commit and after-commit hooks", async () => {
  const order: string[] = [];
  const beforeCommit = hook<UowActive>()({
    requirements: { transaction },
    run: async (_, ctx) => {
      assert.ok(ctx.transaction.session);
      assert.equal((await ctx.transaction.session.select().from(logs)).length, 1);
      order.push("beforeCommit");
      return success();
    },
  });
  const afterCommit = hook<UowCommitted>()({
    requirements: { database, transaction },
    run: async (_, ctx) => {
      assert.equal(ctx.transaction.session, undefined);
      assert.equal((await ctx.database.select().from(logs)).length, 1);
      order.push("effect");
      return success();
    },
  });
  const selected = unitOfWork({ hooks: { beforeCommit: [beforeCommit], afterCommit: [afterCommit] } });
  const binding = plug({
    port: selected,
    requirements: { transaction },
    bind: ({ transaction }) => transaction,
  });
  const app = await runApplication(
    defineApplication({
      modules: [
        behavior,
        flow.includeOnly([roleChangedListener]),
        composeModule({
          modules: [io.exclude([storage.unitOfWork])],
          providers: {
            logPublishing,
            binding,
            selection: unit({
              provides: defaultUnitOfWork,
              lifetime: "scoped",
              requirements: { selected },
              factory: ({ selected }) => selected,
            }),
          },
        }),
      ],
    }),
    { env: testEnv },
  );
  app.resolve(eventBus).on("logCreated", (_event) => {
    order.push("publish");
  });
  try {
    await app.resolve(roleChangedListener)({
      input: { type: "RoleChanged", role: input },
      actor: { userId: "example-user" },
    });
    assert.deepEqual(order, ["beforeCommit", "effect", "publish"]);
  } finally {
    await app.stop();
  }
});

test("Role to Log publications carry only W3C context across independent input scopes", async () => {
  const seen: { propagation: PropagationCarrier | undefined }[] = [];
  const propagation = {
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    tracestate: "vendor=value",
  };
  const app = await runApplication(application, { env: testEnv });
  const bus = app.resolve(eventBus);
  bus.on("roleChanged", (_event, propagation) => {
    seen.push({ propagation });
  });
  bus.on("logCreated", (_event, propagation) => {
    seen.push({ propagation });
  });
  const logged = once(bus, "logCreated");
  try {
    await app.resolve(createRoleExposure)({
      input,
      userHasAccessToRoleGuard: undefined,
      actor: { userId: "example-user" },
      propagation,
    });
    await logged;
    assert.deepEqual(seen, [{ propagation }, { propagation }]);
  } finally {
    await app.stop();
  }
});

test(
  "shutdown drains an HTTP command before unregistering its downstream event consumers",
  {
    timeout: 5_000,
  },
  async () => {
    const entered = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>();
    const app: Application = await runApplication(application, {
      env: testEnv,
      overrides: [
        override(saveRoleWriter, async (role) => {
          const session = await app.resolve(transaction).current();
          assert.ok(session === app.resolve(transaction).session, "The write opens the command's transaction.");
          await session.insert(roles).values(role);
          entered.resolve();
          await finish.promise;
          return upserted(role);
        }),
      ],
    });
    const server = app.resolve(httpServer),
      data = app.resolve(database),
      bus = app.resolve(eventBus);
    const delivered: string[] = [];
    bus.on("roleChanged", () => {
      delivered.push("role");
    });
    bus.on("logCreated", () => {
      delivered.push("log");
    });
    const pending = fetch(`${server.url}/trpc/createRole`, {
      method: "POST",
      headers: { authorization: "Bearer example-token", "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    await entered.promise;
    const stopping = app.stop();
    try {
      assert.equal(app.status, "stopping");
      assert.equal(data.$client.closed, false);
      finish.resolve();
      const response = await pending;
      assert.equal(
        response.headers.get("connection"),
        "close",
        "A response sent while stopping closes its connection.",
      );
      assert.deepEqual(await response.json(), { result: { data: input } });
      await stopping;
      assert.deepEqual(delivered, ["role", "log"]);
      assert.equal(server.listening, false);
      assert.equal(data.$client.closed, true);
    } finally {
      finish.resolve();
      await pending.catch(() => {});
      await app.stop();
      bus.removeAllListeners();
    }
  },
);

test("HTTP resolves a trusted actor and carries trace context through independent Role-to-Log deliveries", async () => {
  const spans: TraceSpan[] = [];
  const tracing: Tracing = {
    propagationFields: ["traceparent", "tracestate"],
    run: async (span, work) => {
      spans.push(span);
      return work();
    },
    capture: () => undefined,
    bind: (work) => work,
  };
  const seen: { propagation: PropagationCarrier | undefined }[] = [];
  const observability = composeModule({
    providers: {
      tracing: unit({ provides: trace, factory: () => tracing }),
    },
  });
  const configured = defineApplication({
    ...application.options,
    modules: observability.requiredBy(...application.options.modules.selections),
  });
  const app = await runApplication(configured, {
    env: testEnv,
    overrides: [
      override(actorResolver, async (_token, { signal } = {}) => {
        signal?.throwIfAborted();
        return { userId: "trusted-user" };
      }),
      override(userHasAccessToRole, async (userId) => {
        assert.equal(userId, "trusted-user");
        return true;
      }),
    ],
  });
  const bus = app.resolve(eventBus);
  assert.equal(app.resolve(roleChangedListener).tracing, tracing);
  bus.on("roleChanged", (_event, propagation) => {
    seen.push({ propagation });
  });
  bus.on("logCreated", (_event, propagation) => {
    seen.push({ propagation });
  });
  const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  try {
    const logged = once(bus, "logCreated");
    await client(app.resolve(httpServer).url, "example-token", {
      traceparent,
      tracestate: "vendor=value",
      "x-openknot-actor-id": "untrusted",
    }).createRole.mutate(input);
    await logged;
    assert.equal(seen.length, 2);
    assert.ok(spans.every((span) => !Object.hasOwn(span, "execution")));
    assert.ok(seen.every((message) => message.propagation?.traceparent === traceparent));
    assert.ok(seen.every((message) => message.propagation?.authorization === undefined));
    assert.ok(spans.some((span) => span.name === "openknot.listener" && span.propagation?.traceparent === traceparent));
    assert.ok(spans.some((span) => span.name === "openknot.guard"));
  } finally {
    await app.stop();
  }
});

test("HTTP tuning and the application's tRPC body limit are independently configurable", async () => {
  const app = await runApplication(application, {
    env: {
      ...testEnv,
      HTTP_KEEP_ALIVE_TIMEOUT_MS: "15000",
      HTTP_REQUEST_TIMEOUT_MS: "45000",
      TRPC_MAX_BODY_SIZE: "64",
    },
  });
  try {
    const server = app.resolve(httpServer);
    assert.equal(server.native.keepAliveTimeout, 15_000);
    assert.equal(server.native.requestTimeout, 45_000);
    assert.equal(server.native.headersTimeout, 45_000);
    const response = await fetch(`${server.url}/trpc/createRole`, {
      method: "POST",
      headers: { authorization: "Bearer example-token", "content-type": "application/json" },
      body: JSON.stringify({ id: "oversized", name: "r".repeat(128), active: true }),
    });
    assert.equal(response.status, 413);
    await response.text();
    assert.deepEqual(await client(server.url).getState.query(), { roles: [], logs: [] });
  } finally {
    await app.stop();
  }
});

test("repeated start, requests and stop leave no connection, timer or process listener behind", async () => {
  // Closed handles leave libuv in the close phase that follows the current turn of the event loop.
  const resources = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    return process.getActiveResourcesInfo().sort();
  };
  const signals = () => ["SIGINT", "SIGTERM"].map((name) => process.listenerCount(name));
  const before = { resources: await resources(), signals: signals() };
  for (let index = 0; index < 5; index++) {
    const app = await runApplication(application, { env: testEnv });
    try {
      const api = client(app.resolve(httpServer).url);
      await api.createRole.mutate({ ...input, id: `cycle${index}` });
      await api.getState.query();
    } finally {
      await app.stop();
    }
  }
  assert.deepEqual({ resources: await resources(), signals: signals() }, before);
});
