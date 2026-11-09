import type { InputInvoker } from "../src/index.ts";
import {
  PostCommitError,
  command,
  expose,
  guard,
  listener,
  publisher,
  query,
  scheduler,
  topic,
  upserted,
  writer,
} from "../src/index.ts";
import type {} from "../src/wire.ts";
import { error, failure, reader, success } from "@openknot-ts/behavior";
import { composeModule, defineApplication, plug, runApplication } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";

/** Collects garbage once the current job no longer keeps its objects alive, in the next turn of the event loop. */
async function collect(): Promise<void> {
  const gc = (globalThis as { gc?: () => void }).gc ?? assert.fail("run with node --expose-gc");
  await new Promise((resolve) => setImmediate(resolve));
  gc();
}

const Refused = error("Refused");
interface Role {
  readonly entity: "role";
  readonly id: string;
  readonly outcome: "ok" | "refuse" | "throw";
}

test("completed executions and a stopped application keep no input, context or Unit of Work reachable", async () => {
  const kept: WeakRef<object>[] = [];
  const run = async () => {
    const allowed = reader<(id: string) => Promise<boolean>>();
    const save = writer<(role: Role) => Promise<ReturnType<typeof upserted<Role>>>>();
    const events = publisher<{ readonly type: "Saved"; readonly role: Role }>();
    const access = guard<Role>()({
      requirements: { allowed },
      run: async (role, ctx) => ((await ctx.allowed(role.id)) ? success() : failure(Refused())),
    });
    const create = command<Role, Role>()({
      requirements: { save, events },
      async run(role, ctx) {
        kept.push(new WeakRef(ctx), new WeakRef(ctx.uow));
        if (role.outcome === "refuse") {
          return failure(Refused());
        }
        const receipt = await ctx.save(role);
        await ctx.events.publish({ type: "Saved", role: receipt.next });
        ctx.uow.afterCommit(async ({ latest }) => {
          kept.push(new WeakRef(latest(receipt)));
        });
        return success(receipt.next);
      },
    });
    const endpoint = expose({ handler: create, guards: { access } });
    const received = listener({ handler: create });
    let invoke: InputInvoker<typeof received> | undefined;
    const app = await runApplication(
      defineApplication({
        modules: [
          composeModule({
            providers: {
              endpoint,
              allowed: plug({ port: allowed, bind: () => async (id) => !id.startsWith("x") }),
              save: plug({
                port: save,
                bind: () => async (role) => {
                  if (role.outcome === "throw") {
                    throw new Error("database");
                  }
                  return upserted(role);
                },
              }),
              events: plug({ port: events, bind: () => async () => undefined }),
              source: plug({
                port: received,
                bind: (ctx) => {
                  invoke = ctx.invoke;
                  return { release: () => undefined };
                },
              }),
            },
          }),
        ],
      }),
      { stopOn: [] },
    );
    const exposure = app.resolve(endpoint);
    // Each call owns its input, so no frame of this test keeps one.
    const call = async (id: string, outcome: Role["outcome"]) => {
      const input: Role = { entity: "role", id, outcome };
      kept.push(new WeakRef(input));
      await exposure({ input, access: input }).catch(() => undefined);
      const delivery: Role = { entity: "role", id: `m${id}`, outcome };
      kept.push(new WeakRef(delivery));
      await invoke!({ input: delivery }).catch(() => undefined);
    };
    for (let index = 0; index < 30; index++) {
      for (const outcome of ["ok", "refuse", "throw"] as const) {
        await call(`r${index}`, outcome);
        await call(`x${index}`, outcome);
      }
    }
    await collect();
    assert.equal(
      kept.filter((value) => value.deref() !== undefined).length,
      0,
      "a completed execution keeps nothing of its own",
    );
    await app.stop();
    invoke = undefined;
    return { application: new WeakRef(app), exposure: new WeakRef(exposure) };
  };
  const { application, exposure } = await run();
  await collect();
  assert.equal(exposure.deref(), undefined, "a stopped application keeps no resolved port");
  assert.equal(application.deref(), undefined, "nothing in the process keeps a stopped application");
});

test("calls that share one long-lived caller signal leave no abort listener on it", async () => {
  const caller = new AbortController();
  const signal = caller.signal;
  const allowed = reader<(id: string) => Promise<boolean>>();
  const events = publisher<number>();
  const access = guard<string>()({
    requirements: { allowed },
    run: async (id, ctx) => ((await ctx.allowed(id)) ? success() : failure(Refused())),
  });
  const changes = topic<string, number>()({ guards: { access } });
  let attached = 0;
  const inner = query<number, number>()({
    run: async (value) => {
      attached = Math.max(attached, getEventListeners(signal, "abort").length);
      return success(value);
    },
  });
  const outer = command<number, number>()({
    requirements: { inner, events },
    async run(value, ctx) {
      // A nested call that passes the caller's signal of its own owns a lifetime that follows it.
      const result = await ctx.inner(value, { signal });
      await ctx.events.publish(value);
      await ctx.events.publishNow(value, { signal });
      return value % 3 === 0 ? failure(Refused()) : result;
    },
  });
  const endpoint = expose({ handler: outer, guards: { access } });
  const received = listener({ handler: outer });
  let invoke: InputInvoker<typeof received> | undefined;
  const app = await runApplication(
    defineApplication({
      modules: [
        composeModule({
          providers: {
            endpoint,
            allowed: plug({ port: allowed, bind: () => async (id) => id !== "refused" }),
            events: plug({ port: events, bind: () => async () => undefined }),
            changes: plug({
              port: changes,
              bind: () => ({
                subscribe: async function* () {
                  yield 1;
                },
                publish: () => undefined,
              }),
            }),
            source: plug({
              port: received,
              bind: (ctx) => {
                invoke = ctx.invoke;
                return { release: () => undefined };
              },
            }),
          },
        }),
      ],
    }),
    { stopOn: [] },
  );
  try {
    const exposure = app.resolve(endpoint);
    const subscriptions = app.resolve(changes);
    for (let value = 0; value < 30; value++) {
      for (const id of ["allowed", "refused"]) {
        await exposure({ input: value, access: id, signal }).catch(() => undefined);
        const stream = await subscriptions.subscribe({ input: "roles", access: id, signal }).catch(() => undefined);
        await stream?.[Symbol.asyncIterator]().return?.();
      }
      await invoke!({ input: value, signal }).catch(() => undefined);
    }
    // Executions follow the signal while they run and detach once they end.
    assert.ok(attached > 0);
    assert.equal(getEventListeners(signal, "abort").length, 0);
  } finally {
    await app.stop();
  }
});

test("native work an execution starts keeps none of its receipts once its Unit of Work completes", async () => {
  const kept: WeakRef<object>[] = [];
  const timers: NodeJS.Timeout[] = [];
  const save = writer<(role: Role) => Promise<ReturnType<typeof upserted<Role>>>>();
  const create = command<Role, Role>()({
    requirements: { save },
    async run(role, ctx) {
      const receipt = await ctx.save(role);
      kept.push(new WeakRef(receipt), new WeakRef(receipt.next));
      return success(role);
    },
  });
  const endpoint = expose({ handler: create });
  const app = await runApplication(
    defineApplication({
      modules: [
        composeModule({
          providers: {
            endpoint,
            // A native client starts a timer within the call, as a command timeout does: it keeps the call's context.
            save: plug({
              port: save,
              bind: () => async (role) => {
                const timer = setTimeout(() => undefined, 60_000);
                timer.unref();
                timers.push(timer);
                return upserted({ ...role });
              },
            }),
          },
        }),
      ],
    }),
    { stopOn: [] },
  );
  try {
    const call = (index: number) =>
      app.resolve(endpoint)({ input: { entity: "role", id: `t${index}`, outcome: "ok" } });
    for (let index = 0; index < 20; index++) {
      await call(index);
    }
    await collect();
    assert.equal(kept.length, 40);
    assert.equal(kept.filter((value) => value.deref() !== undefined).length, 0);
  } finally {
    for (const timer of timers) {
      clearTimeout(timer);
    }
    await app.stop();
  }
});

test("stopping during a scheduler tick drains it, skips an overlapping tick and keeps nothing of either", async () => {
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const kept: WeakRef<object>[] = [];
  const tick = scheduler({
    schedule: { every: { minutes: 1 } },
    overlap: "skip",
    async run(_input, ctx) {
      kept.push(new WeakRef(ctx));
      started.resolve();
      await gate.promise;
      return success("ticked");
    },
  });
  let fire: InputInvoker<typeof tick> | undefined;
  const timer = plug({
    port: tick,
    bind: ({ invoke }) => {
      fire = invoke;
      return { release: () => undefined };
    },
  });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { tick, timer } })] }), {
    stopOn: [],
  });
  const running = fire!({ trigger: { scheduledAt: Date.now() } });
  await started.promise;
  assert.deepEqual(await fire!({ trigger: { scheduledAt: Date.now() } }), { status: "skipped", reason: "overlap" });
  let stopped = false;
  const stopping = app.stop().then(() => {
    stopped = true;
  });
  // Stopping waits for the running tick: two turns of the event loop pass with it still pending.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  gate.resolve();
  assert.equal(await running, "ticked");
  await stopping;
  fire = undefined;
  await collect();
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.deref(), undefined);
});

test("work that fails after commit keeps neither its execution nor its failures once reported", async () => {
  const kept: WeakRef<object>[] = [];
  const events = publisher<number>();
  const change = command<number>()({
    requirements: { events },
    async run(value, ctx) {
      kept.push(new WeakRef(ctx));
      await ctx.events.publish(value);
      ctx.uow.afterCommit(() => {
        const failed = new Error(`effect ${value}`);
        kept.push(new WeakRef(failed));
        throw failed;
      });
      return success();
    },
  });
  const endpoint = expose({ handler: change });
  const app = await runApplication(
    defineApplication({
      modules: [
        composeModule({
          providers: {
            endpoint,
            events: plug({
              port: events,
              bind: () => async (value) => {
                const failed = new Error(`publish ${value}`);
                kept.push(new WeakRef(failed));
                throw failed;
              },
            }),
          },
        }),
      ],
    }),
    { stopOn: [] },
  );
  const caller = new AbortController();
  try {
    for (let index = 0; index < 20; index++) {
      await app
        .resolve(endpoint)({ input: index, signal: caller.signal })
        .then(
          () => assert.fail("A failure after commit rejects"),
          (error: unknown) => assert.ok(PostCommitError.is(error)),
        );
    }
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
    await collect();
    assert.equal(kept.length, 60);
    assert.equal(kept.filter((value) => value.deref() !== undefined).length, 0);
  } finally {
    await app.stop();
  }
});
