import type { HealthReport } from "../src/index.ts";
import { health, healthCheck, healthProbes } from "../src/index.ts";
import { composeModule, defineApplication, hook, optional, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

const signal = new AbortController().signal;

test("probes follow the application lifecycle, and health without checks equals readiness", async () => {
  const seen: string[] = [];
  const observe = (phase: string) =>
    hook({
      requirements: { healthProbes },
      async run({ healthProbes }) {
        const { status } = await healthProbes.health({ signal });
        seen.push(`${phase}: live ${healthProbes.liveness()}, ready ${healthProbes.readiness()}, health ${status}`);
      },
    });
  const app = await runApplication(
    defineApplication({ modules: [health], startupTasks: [observe("startup")], shutdownTasks: [observe("shutdown")] }),
  );
  const probes = app.resolve(healthProbes);
  assert.equal(probes.liveness(), "up");
  assert.equal(probes.readiness(), "up");
  assert.deepEqual(await probes.health({ signal }), { status: "up", application: "ready", checks: {} });
  void app.stop();
  // Readiness drops synchronously when stopping begins, before any shutdown task runs.
  assert.equal(probes.readiness(), "down");
  await app.stopped;
  assert.equal(probes.liveness(), "down");
  assert.deepEqual(seen, ["startup: live up, ready down, health down", "shutdown: live up, ready down, health down"]);
});

test("checks listed in any selected module join health, run concurrently, and any failure turns it down", async () => {
  const connection = { ready: true };
  const brokerChecked = Promise.withResolvers<void>();
  const received: AbortSignal[] = [];
  let failure: Error | undefined;
  const broker = unit({ factory: () => connection });
  // Waits for the broker check, so sequential checks could never finish.
  const databaseHealth = healthCheck({
    name: "database",
    async check(_dependencies, options) {
      received.push(options.signal);
      await brokerChecked.promise;
      if (failure !== undefined) {
        throw failure;
      }
      return "up";
    },
  });
  const brokerHealth = healthCheck({
    name: "broker",
    requirements: { broker },
    async check({ broker }) {
      brokerChecked.resolve();
      return broker.ready ? "up" : "down";
    },
  });
  const io = composeModule({ providers: { databaseHealth } });
  const channels = composeModule({ providers: { brokerHealth } });
  const app = await runApplication(defineApplication({ modules: [health, io, channels] }));
  try {
    const probes = app.resolve(healthProbes);
    const report: HealthReport = await probes.health({ signal });
    assert.deepEqual(report, { status: "up", application: "ready", checks: { database: "up", broker: "up" } });
    assert.ok(Object.isFrozen(report) && Object.isFrozen(report.checks));
    // Each check receives a signal that follows the caller's and its own deadline.
    assert.deepEqual(
      received.map((own) => own.aborted),
      [false],
    );
    connection.ready = false;
    assert.deepEqual((await probes.health({ signal })).checks, { database: "up", broker: "down" });
    connection.ready = true;
    failure = new Error("connection refused");
    assert.deepEqual(await probes.health({ signal }), {
      status: "down",
      application: "ready",
      checks: { database: "down", broker: "up" },
    });
    // Checks never decide liveness or readiness.
    assert.equal(probes.liveness(), "up");
    assert.equal(probes.readiness(), "up");
  } finally {
    await app.stop();
  }
});

test("probes exist only when the health module is listed", async () => {
  const host = unit({ requirements: { probes: optional(healthProbes) }, factory: ({ probes }) => probes });
  const databaseHealth = healthCheck({ name: "database", check: async () => "up" });
  const plugs = composeModule({ providers: { host, databaseHealth } });
  const without = await runApplication(defineApplication({ modules: [plugs] }));
  const enabled = await runApplication(defineApplication({ modules: [plugs, health] }));
  try {
    assert.equal(without.resolve(host), undefined);
    assert.deepEqual((await enabled.resolve(host)?.health({ signal }))?.checks, { database: "up" });
  } finally {
    await Promise.all([without.stop(), enabled.stop()]);
  }
});

test("two checks with the same name fail at startup", async () => {
  const first = healthCheck({ name: "database", check: async () => "up" });
  const second = healthCheck({ name: "database", check: async () => "down" });
  await assert.rejects(
    runApplication(defineApplication({ modules: [health, composeModule({ providers: { first, second } })] })),
    /Health check 'database' is declared more than once/,
  );
});

test("a check that does not settle in time is down, and its signal aborts", async () => {
  let aborted = false;
  const stuck = healthCheck({
    name: "stuck",
    timeoutMs: 20,
    check: (_dependencies, { signal: own }) =>
      new Promise<"up">((_resolve) => {
        own.addEventListener("abort", () => {
          aborted = true;
        });
      }),
  });
  const app = await runApplication(defineApplication({ modules: [health, composeModule({ providers: { stuck } })] }));
  try {
    const report = await app.resolve(healthProbes).health({ signal });
    assert.deepEqual(report.checks, { stuck: "down" });
    assert.equal(aborted, true);
  } finally {
    await app.stop();
  }
});

test("a check's signal aborts when the caller's request ends, before its deadline", { timeout: 5_000 }, async () => {
  const entered = Promise.withResolvers<void>();
  const pending = healthCheck({
    name: "pending",
    // Far beyond the test's own timeout: only the caller's signal can end this check in time.
    timeoutMs: 60_000,
    check: (_dependencies, { signal: own }) => {
      entered.resolve();
      return new Promise<"up" | "down">((resolve) => {
        own.addEventListener("abort", () => resolve("down"), { once: true });
      });
    },
  });
  const app = await runApplication(defineApplication({ modules: [health, composeModule({ providers: { pending } })] }));
  try {
    const caller = new AbortController();
    const report = app.resolve(healthProbes).health({ signal: caller.signal });
    await entered.promise;
    caller.abort();
    assert.deepEqual((await report).checks, { pending: "down" });
  } finally {
    await app.stop();
  }
});

test("every check clears its deadline once it settles, whether up, down, failed or timed out", async () => {
  const timers = () => process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
  const before = timers();
  const up = healthCheck({ name: "up", check: async () => "up" });
  const down = healthCheck({ name: "down", check: async () => "down" });
  const failed = healthCheck({
    name: "failed",
    check: async () => {
      throw new Error("refused");
    },
  });
  const stuck = healthCheck({ name: "stuck", timeoutMs: 20, check: () => new Promise<"up">(() => undefined) });
  const app = await runApplication(
    defineApplication({ modules: [health, composeModule({ providers: { up, down, failed, stuck } })] }),
  );
  try {
    const report = await app.resolve(healthProbes).health({ signal });
    assert.deepEqual(report.checks, { up: "up", down: "down", failed: "down", stuck: "down" });
    assert.equal(timers(), before);
  } finally {
    await app.stop();
  }
  assert.equal(timers(), before);
});

test("a check is not built when the application does not select the health probes", async () => {
  let built = false;
  const database = unit({
    factory: () => {
      built = true;
      return {};
    },
  });
  const check = healthCheck({ name: "database", requirements: { database }, check: async () => "up" });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { check } })] }));
  try {
    assert.equal(built, false);
  } finally {
    await app.stop();
  }
});

test("a check that throws before returning its promise reports down without failing the report", async () => {
  const checks = {
    broken: healthCheck({
      name: "broken",
      check: () => {
        throw new Error("client closed");
      },
    }),
    working: healthCheck({ name: "working", check: async () => "up" }),
  };
  const app = await runApplication(defineApplication({ modules: [health, composeModule({ providers: checks })] }), {
    stopOn: [],
  });
  try {
    const report = await app.resolve(healthProbes).health({ signal: new AbortController().signal });
    assert.deepEqual(report.checks, { broken: "down", working: "up" });
    assert.equal(report.status, "down");
  } finally {
    await app.stop();
  }
});
