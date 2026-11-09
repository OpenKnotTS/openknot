import type { ExecutionActor, UowActive, UowCommitted, UowCompleted, UowRolledBack } from "../src/index.ts";
import {
  broadcast,
  command,
  defaultUnitOfWork,
  expose,
  hook,
  InputCancelledError,
  listener,
  PostCommitError,
  publisher,
  query,
  topic,
  unitOfWork,
  UnitOfWorkError,
  writer,
} from "../src/index.ts";
import type {} from "../src/wire.ts";
import { application, recording } from "./fixtures/unit-of-work.ts";
import { failure, success } from "@openknot-ts/behavior";
import { plug, composeModule, defineApplication, resource, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { test } from "node:test";

test("native commit precedes hooks, dynamically staged effects and every publication", async () => {
  const order: string[] = [];
  const messages = publisher<number>();
  const before = hook<UowActive>()({
    run: (event) => {
      assert.equal(event.mode, "read-write");
      order.push("before");
      return success();
    },
  });
  const after = hook<UowCommitted>()({
    requirements: { messages },
    run: async (_event, ctx) => {
      order.push("after");
      await ctx.messages.publish(3);
      return success();
    },
  });
  const completed = hook<UowCompleted>()({
    run: (event) => {
      assert.equal(event.status, "committed");
      order.push("complete");
      return success();
    },
  });
  const database = unitOfWork({
    hooks: { beforeCommit: [before], afterCommit: [after], afterCompletion: [completed] },
  });
  const action = command({
    requirements: { messages },
    run: async (_, ctx) => {
      order.push("execute");
      await ctx.messages.publish(1);
      ctx.uow.afterCommit(async () => {
        order.push("effect");
        await ctx.messages.publish(2);
      });
      assert.deepEqual(order, ["begin", "execute"]);
      return success(42);
    },
  });
  const app = await application(
    [
      action,
      plug({
        port: database,
        bind: () => ({
          async transaction(work) {
            order.push("begin");
            const result = await work();
            order.push("commit");
            return result;
          },
        }),
      }),
      plug({
        port: messages,
        bind: () => (value) => {
          order.push(`publish:${value}`);
        },
      }),
    ],
    database,
  );
  try {
    const result = await app.withScope((scope) => scope.resolve(action)());
    assert.deepEqual(result, success(42));
    assert.deepEqual(order, [
      "begin",
      "execute",
      "before",
      "commit",
      "after",
      "effect",
      "publish:1",
      "publish:3",
      "publish:2",
      "complete",
    ]);
  } finally {
    await app.stop();
  }
});

test("a write a beforeCommit hook leaves running settles before the native commit", async () => {
  const order: string[] = [];
  const save = writer<(value: number) => Promise<void>>();
  const before = hook<UowActive>()({
    requirements: { save },
    run: (_event, ctx) => {
      void ctx.save(1);
      return success();
    },
  });
  const database = unitOfWork({ hooks: { beforeCommit: [before] } });
  const action = command({ run: async () => success() });
  const app = await application(
    [
      action,
      plug({
        port: database,
        bind: () => ({
          async transaction(work) {
            const result = await work();
            order.push("commit");
            return result;
          },
        }),
      }),
      plug({
        port: save,
        bind: () => async () => {
          // The write finishes on a later turn of the event loop than the hook that started it.
          await new Promise((resolve) => setImmediate(resolve));
          order.push("write");
        },
      }),
    ],
    database,
  );
  try {
    assert.deepEqual(await app.withScope((scope) => scope.resolve(action)()), success());
    assert.deepEqual(order, ["write", "commit"]);
  } finally {
    await app.stop();
  }
});

test("ignored nested failures roll back native writes and discard effects and publications", async () => {
  const tx = new AsyncLocalStorage<{ value: number }>();
  let persisted = 0,
    effects = 0,
    sent = 0,
    rolledBack = 0;
  const expected = new Error("business failure");
  const save = writer<(value: number) => Promise<void>>();
  const events = publisher<number>();
  const rollbackHook = hook<UowRolledBack>()({
    run: (event) => {
      assert.equal(event.error, expected);
      rolledBack++;
      return success();
    },
  });
  const database = unitOfWork({ hooks: { afterRollback: [rollbackHook] } });
  const inner = command({
    requirements: { save, events },
    run: async (_, ctx) => {
      await ctx.save(9);
      ctx.uow.afterCommit(() => {
        effects++;
      });
      await ctx.events.publish(9, { signal: ctx.signal });
      return failure(expected);
    },
  });
  const outer = command({
    requirements: { inner },
    run: async (_, ctx) => {
      await ctx.inner();
      return success();
    },
  });
  const app = await application(
    [
      outer,
      plug({
        port: events,
        bind: () => () => {
          sent++;
        },
      }),
      plug({
        port: save,
        bind: () => async (value) => {
          tx.getStore()!.value = value;
        },
      }),
      plug({
        port: database,
        bind: () => ({
          async transaction(work) {
            const staged = { value: persisted };
            const result = await tx.run(staged, work);
            persisted = staged.value;
            return result;
          },
        }),
      }),
    ],
    database,
  );
  try {
    assert.deepEqual(await app.withScope((scope) => scope.resolve(outer)()), failure(expected));
    assert.equal(persisted, 0);
    assert.equal(effects, 0);
    assert.equal(sent, 0);
    assert.equal(rolledBack, 1);
  } finally {
    await app.stop();
  }
});

test("nested commands and queries join one resolved UoW and deliver its staged publications", async () => {
  const modes: string[] = [],
    delivered: number[] = [];
  const database = unitOfWork(),
    messages = publisher<number>();
  const lookup = query({ run: (_, ctx) => success(ctx.uow.mode) });
  const inner = command({
    unitOfWork: database,
    requirements: { messages, query: lookup },
    run: async (_, ctx) => {
      const read = await ctx.query();
      assert.deepEqual(read, success("read-write"));
      await ctx.messages.publish(1, { signal: ctx.signal });
      return success();
    },
  });
  const outer = command({ requirements: { inner }, run: (_, ctx) => ctx.inner() });
  const app = await application(
    [
      outer,
      lookup,
      plug({
        port: messages,
        bind: () => (value, options) => {
          options.signal?.throwIfAborted();
          delivered.push(value);
        },
      }),
      plug({
        port: database,
        bind: () => ({
          transaction(work, options) {
            modes.push(options.mode);
            return work();
          },
        }),
      }),
    ],
    database,
  );
  try {
    assert.deepEqual(await app.withScope((scope) => scope.resolve(outer)()), success());
    assert.deepEqual(modes, ["read-write"]);
    assert.deepEqual(delivered, [1]);
    assert.deepEqual(await app.withScope((scope) => scope.resolve(lookup)()), success("read-only"));
    assert.deepEqual(modes, ["read-write", "read-only"]);
  } finally {
    await app.stop();
  }
});

test("explicit UoW selection is visible to DI and incompatible nested work is rejected", async () => {
  const chosen = unitOfWork(),
    other = unitOfWork();
  let selected = 0,
    unrelated = 0;
  const child = command({ unitOfWork: other, run: () => success() });
  const parent = command({ requirements: { child }, run: (_, ctx) => ctx.child() });
  const app = await application(
    [
      parent,
      plug({
        port: chosen,
        bind: () => ({
          transaction(work) {
            selected++;
            return work();
          },
        }),
      }),
      plug({
        port: other,
        bind: () => ({
          transaction(work) {
            unrelated++;
            return work();
          },
        }),
      }),
    ],
    chosen,
  );
  try {
    const result = await app.withScope((scope) => scope.resolve(parent)());
    assert.ok(result.isError && UnitOfWorkError.is(result.error));
    assert.equal(selected, 1);
    assert.equal(unrelated, 0);
    assert.deepEqual(await app.withScope((scope) => scope.resolve(child)()), success());
    assert.equal(unrelated, 1);
  } finally {
    await app.stop();
  }
});

test("a read-only root cannot upgrade into a command", async () => {
  let executed = false;
  const change = command({
    run: () => {
      executed = true;
      return success();
    },
  });
  const read = query({ requirements: { change }, run: (_, ctx) => ctx.change() });
  const app = await application([read]);
  try {
    const result = await app.withScope((scope) => scope.resolve(read)());
    assert.ok(result.isError && UnitOfWorkError.is(result.error));
    assert.equal(executed, false);
  } finally {
    await app.stop();
  }
});

test("provides selects another Unit of Work as the default, with its own hooks", async () => {
  const seen: string[] = [];
  const onCommit = hook<UowCommitted>()({
    run: () => {
      seen.push("committed");
      return success();
    },
  });
  const selected = unitOfWork({ hooks: { afterCommit: [onCommit] } });
  const action = command({ run: () => success() });
  const driver = plug({ port: selected, bind: () => recording([]) });
  const selection = unit({
    provides: defaultUnitOfWork,
    lifetime: "scoped",
    requirements: { selected },
    factory: ({ selected }) => selected,
  });
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { action, driver, selection } })] }),
  );
  try {
    assert.equal((await app.withScope((scope) => scope.resolve(action)())).isError, false);
    assert.deepEqual(seen, ["committed"]);
  } finally {
    await app.stop();
  }
});

test("a binding of an integration's reference preserves its lifetime", async () => {
  const selection = unit({ provides: defaultUnitOfWork, factory: () => ({}) as never });
  const action = command({ run: () => success() });
  await assert.rejects(
    runApplication(defineApplication({ modules: [composeModule({ providers: { action, selection } })] })),
    /must preserve its kind and lifetime/,
  );
});

test("publishNow refuses a publication factory, which only a commit can run", async () => {
  const sent: unknown[] = [];
  const messages = publisher<number>();
  const action = command({
    requirements: { messages },
    run: async (_, ctx) => {
      await ctx.messages.publishNow((() => 1) as never);
      return success();
    },
  });
  const app = await application([
    action,
    plug({
      port: messages,
      bind: () => (value) => {
        sent.push(value);
      },
    }),
  ]);
  try {
    const result = await app.withScope((scope) => scope.resolve(action)());
    assert.ok(result.isError && UnitOfWorkError.is(result.error));
    assert.deepEqual(sent, []);
  } finally {
    await app.stop();
  }
});

test("publishNow sends immediately without changing publish on the same port", async () => {
  const sent: number[] = [],
    messages = publisher<number>();
  const expected = new Error("rollback");
  const action = command({
    requirements: { immediate: messages, staged: messages },
    run: async (_, ctx) => {
      await ctx.staged.publish(1);
      await ctx.immediate.publishNow(2);
      assert.deepEqual(sent, [2]);
      return failure(expected);
    },
  });
  const app = await application([
    action,
    plug({
      port: messages,
      bind: () => (value) => {
        sent.push(value);
      },
    }),
  ]);
  try {
    assert.deepEqual(await app.withScope((scope) => scope.resolve(action)()), failure(expected));
    assert.deepEqual(sent, [2]);
    await app.withScope((scope) => scope.resolve(messages).publish(3));
    assert.deepEqual(sent, [2, 3]);
  } finally {
    await app.stop();
  }
});

test("topic/broadcast and transitive publisher requirements share the same publication policy", async () => {
  const sent: string[] = [];
  const keyed = topic<"one", string>()({}),
    plain = broadcast<string>()({}),
    messages = publisher<string>();
  const service = unit({
    lifetime: "scoped",
    requirements: { messages },
    factory: ({ messages }) => ({ send: () => messages.publish("service") }),
  });
  const action = command({
    requirements: { keyed, plain, service },
    run: async (_, ctx) => {
      await ctx.keyed.publish("one", "keyed");
      await ctx.plain.publish("plain");
      await ctx.service.send();
      assert.equal(sent.length, 0);
      ctx.uow.afterCommit(() => {
        sent.push("effect");
      });
      return success();
    },
  });
  const native = {
    keyed: plug({
      port: keyed,
      bind: () => ({
        publish(_key, value) {
          sent.push(value);
        },
        subscribe: async function* () {},
      }),
    }),
    plain: plug({
      port: plain,
      bind: () => ({
        publish(value) {
          sent.push(value);
        },
        subscribe: async function* () {},
      }),
    }),
    messages: plug({
      port: messages,
      bind: () => (value) => {
        sent.push(value);
      },
    }),
  };
  const app = await application([action, ...Object.values(native)]);
  try {
    assert.deepEqual(await app.withScope((scope) => scope.resolve(action)()), success());
    assert.deepEqual(sent, ["effect", "keyed", "plain", "service"]);
  } finally {
    await app.stop();
  }
});

test("post-commit failures identify their phase and completion hooks all run", async () => {
  let sent = 0,
    committed = 0;
  const completed: UowCompleted[] = [];
  const expected = new Error("cache failure"),
    messages = publisher<number>();
  const cleanupFailure = hook<UowCompleted>()({ run: (_event) => failure(new Error("cleanup failure")) });
  const cleanup = hook<UowCompleted>()({
    run: (event) => {
      completed.push(event);
      return success();
    },
  });
  const database = unitOfWork({ hooks: { afterCompletion: [cleanupFailure, cleanup] } });
  const action = command({
    requirements: { messages },
    run: async (_, ctx) => {
      await ctx.messages.publish(1);
      ctx.uow.afterCommit(() => {
        throw expected;
      });
      return success();
    },
  });
  const app = await application(
    [
      action,
      plug({
        port: messages,
        bind: () => () => {
          sent++;
        },
      }),
      plug({
        port: database,
        bind: () => ({
          async transaction(work) {
            const result = await work();
            committed++;
            return result;
          },
        }),
      }),
    ],
    database,
  );
  try {
    const result = await app.withScope((scope) => scope.resolve(action)());
    assert.ok(result.isError && PostCommitError.is(result.error) && result.error.committed);
    assert.equal(result.error.phase, "completion");
    assert.equal(committed, 1);
    // The failed effect does not stop the committed work's publications.
    assert.equal(sent, 1);
    assert.equal(completed.length, 1);
    assert.equal(completed[0]!.status, "committed");
    assert.ok(PostCommitError.is(completed[0]!.error) && completed[0]!.error.phase === "effects");
  } finally {
    await app.stop();
  }
});

test("cancellation before commit rolls back; after commit, effects and publications run to completion", async () => {
  const messages = publisher<number>();
  const controller = new AbortController();
  let sent = 0,
    commit = 0;
  const database = unitOfWork();
  const action = command<string>()({
    requirements: { messages },
    run: async (mode, ctx) => {
      await ctx.messages.publish(1, { signal: ctx.signal });
      if (mode === "before") {
        controller.abort();
      } else {
        ctx.uow.afterCommit(() => {
          controller.abort();
        });
      }
      return success();
    },
  });
  const app = await application(
    [
      action,
      plug({
        port: database,
        bind: () => ({
          async transaction(work) {
            const result = await work();
            commit++;
            return result;
          },
        }),
      }),
      plug({
        port: messages,
        bind: () => () => {
          sent++;
        },
      }),
    ],
    database,
  );
  try {
    const first = await app.withScope((scope) => scope.resolve(action)("before", { signal: controller.signal }));
    assert.ok(first.isError && InputCancelledError.is(first.error));
    assert.equal(commit, 0);
    assert.equal(sent, 0);
  } finally {
    await app.stop();
  }
  const after = new AbortController();
  const audited: number[] = [];
  const signals: unknown[] = [];
  const audit = writer<(value: number) => Promise<void>>();
  const later = command({
    requirements: { messages, audit },
    run: async (_, ctx) => {
      await ctx.messages.publish(1, { signal: ctx.signal });
      ctx.uow.afterCommit(async () => {
        after.abort();
        await ctx.audit(1);
      });
      return success();
    },
  });
  const secondApp = await application([
    later,
    plug({
      port: audit,
      bind: () => async (value) => {
        audited.push(value);
      },
    }),
    plug({
      port: messages,
      bind: () => (_value, options) => {
        signals.push(options.signal);
        sent++;
      },
    }),
  ]);
  try {
    // The client leaving after commit interrupts nothing: the committed work's effects and events complete.
    const result = await secondApp.withScope((scope) => scope.resolve(later)(undefined, { signal: after.signal }));
    assert.deepEqual(result, success());
    assert.deepEqual(audited, [1]);
    assert.equal(sent, 1);
    assert.deepEqual(signals, [undefined]);
  } finally {
    await secondApp.stop();
  }
});

test("concurrent inputs isolate staged work and lifecycle resources", { timeout: 2_000 }, async () => {
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const sent: number[] = [],
    released: number[] = [];
  let count = 0;
  const messages = publisher<number>();
  const session = resource({
    lifetime: "scoped",
    async initialize() {
      const id = ++count;
      return {
        value: id,
        release() {
          released.push(id);
        },
      };
    },
  });
  const cleanup = hook<UowCompleted>()({
    requirements: { session },
    run: (_, ctx) => {
      assert.ok(!released.includes(ctx.session));
      return success();
    },
  });
  const database = unitOfWork({ hooks: { afterCompletion: [cleanup] } });
  const action = command<number>()({
    requirements: { messages, session },
    run: async (value, ctx) => {
      await ctx.messages.publish(value);
      if (value === 1) {
        entered.resolve();
        await finish.promise;
      }
      return success();
    },
  });
  const endpoint = expose<number>()({ requirements: { command: action }, run: (value, ctx) => ctx.command(value) });
  const app = await runApplication(
    defineApplication({
      modules: [
        composeModule({
          providers: [
            endpoint,
            plug({
              port: messages,
              bind: () => (value) => {
                sent.push(value);
              },
            }),
            plug({ port: database, bind: () => ({ transaction: (work) => work() }) }),
            unit({
              provides: defaultUnitOfWork,
              lifetime: "scoped",
              requirements: { database },
              factory: ({ database }) => database,
            }),
          ].map((source) => ({ source })),
        }),
      ],
    }),
  );
  try {
    const first = app.resolve(endpoint)({ input: 1 });
    await entered.promise;
    assert.deepEqual(await app.resolve(endpoint)({ input: 2 }), undefined);
    assert.deepEqual(sent, [2]);
    assert.deepEqual(released, [2]);
    finish.resolve();
    assert.deepEqual(await first, undefined);
    assert.deepEqual(sent, [2, 1]);
    assert.deepEqual(released, [2, 1]);
  } finally {
    finish.resolve();
    await app.stop();
  }
});

test("actor stays in the execution and is never inherited by delivery", async () => {
  const messages = publisher<number>();
  const received: unknown[] = [];
  const action = command({
    requirements: { messages },
    run: async (_, ctx) => {
      await ctx.messages.publish(1);
      return success(ctx.actor);
    },
  });
  const endpoint = expose({ requirements: { command: action }, run: (_, ctx) => ctx.command() });
  const sources = [
    endpoint,
    plug({
      port: messages,
      bind: () => (_value, options) => {
        received.push(options);
      },
    }),
  ];
  const app = await application(sources);
  try {
    assert.deepEqual(await app.resolve(endpoint)({ input: undefined }), undefined);
    assert.equal(await app.resolve(endpoint)({ input: undefined, actor: "alice" }), "alice");
    assert.equal(Object.hasOwn(received[1] as object, "actor"), false);
    assert.ok(Object.isFrozen(received[1]));
    assert.equal(await app.resolve(endpoint)({ input: undefined }), undefined);
    assert.equal(Object.hasOwn(received[2] as object, "actor"), false);
  } finally {
    await app.stop();
  }
});

test("an output plug binds UoW and writers to the same scoped native session", async () => {
  let committed = 0;
  const database = unitOfWork(),
    save = writer<(value: number) => void>();
  const session = unit({ lifetime: "scoped", factory: () => ({ pending: 0 }) });
  const io = {
    database: plug({
      port: database,
      requirements: { session },
      bind: ({ session }) => ({
        async transaction(work) {
          const result = await work();
          committed = session.pending;
          return result;
        },
      }),
    }),
    save: plug({
      port: save,
      requirements: { session },
      bind:
        ({ session }) =>
        (value) => {
          session.pending = value;
        },
    }),
  };
  const action = command({
    requirements: { save },
    run: (_, ctx) => {
      ctx.save(7);
      return success();
    },
  });
  const app = await application([action, ...Object.values(io)], database);
  try {
    assert.deepEqual(await app.withScope((scope) => scope.resolve(action)()), success());
    assert.equal(committed, 7);
  } finally {
    await app.stop();
  }
});

test("native driver methods keep their object as this after binding", async () => {
  const driver = {
    commits: 0,
    async transaction<T>(work: () => Promise<T>): Promise<T> {
      const result = await work();
      this.commits++;
      return result;
    },
  };
  const database = unitOfWork();
  const action = command({ run: () => success() });
  const app = await application([action, plug({ port: database, bind: () => driver })], database);
  try {
    assert.deepEqual(await app.withScope((scope) => scope.resolve(action)()), success());
    assert.equal(driver.commits, 1);
  } finally {
    await app.stop();
  }
});

test("before-commit hooks veto commit and all rollback/completion cleanup hooks run", async () => {
  const order: string[] = [],
    expected = new Error("veto");
  const before = hook<UowActive>()({ run: () => failure(expected) });
  const failedCleanup = hook<UowRolledBack>()({
    run: () => {
      order.push("failed cleanup");
      return failure(new Error("cleanup"));
    },
  });
  const cleanup = hook<UowRolledBack>()({
    run: () => {
      order.push("cleanup");
      return success();
    },
  });
  const completed = hook<UowCompleted>()({
    run: (event) => {
      assert.equal(event.status, "rolled-back");
      order.push("complete");
      return success();
    },
  });
  const database = unitOfWork({
    hooks: { beforeCommit: [before], afterRollback: [failedCleanup, cleanup], afterCompletion: [completed] },
  });
  const action = command({ run: () => success() });
  const app = await application(
    [
      action,
      plug({
        port: database,
        bind: () => ({
          async transaction(work) {
            try {
              const result = await work();
              order.push("commit");
              return result;
            } catch (error) {
              order.push("rollback");
              throw error;
            }
          },
        }),
      }),
    ],
    database,
  );
  try {
    const result = await app.withScope((scope) => scope.resolve(action)());
    assert.ok(result.isError && UnitOfWorkError.is(result.error));
    assert.deepEqual(order, ["rollback", "failed cleanup", "cleanup", "complete"]);
  } finally {
    await app.stop();
  }
});

test("publication failure is committed, stops the batch and does not rerun the command", async () => {
  let executions = 0;
  const sent: number[] = [],
    messages = publisher<number>();
  const action = command({
    requirements: { messages },
    run: async (_, ctx) => {
      executions++;
      await ctx.messages.publish(1);
      await ctx.messages.publish(2);
      return success();
    },
  });
  const app = await application([
    action,
    plug({
      port: messages,
      bind: () => (value) => {
        sent.push(value);
        throw new Error("broker unavailable");
      },
    }),
  ]);
  try {
    const result = await app.withScope((scope) => scope.resolve(action)());
    assert.ok(result.isError && PostCommitError.is(result.error) && result.error.phase === "publications");
    assert.equal(executions, 1);
    assert.deepEqual(sent, [1]);
  } finally {
    await app.stop();
  }
});

test("uncertain native commit failure runs completion without reporting a confirmed rollback", async () => {
  const observed: string[] = [];
  const rollback = hook<UowRolledBack>()({
    run: () => {
      observed.push("rollback");
      return success();
    },
  });
  const complete = hook<UowCompleted>()({
    run: (event) => {
      observed.push(event.status);
      return success();
    },
  });
  const database = unitOfWork({ hooks: { afterRollback: [rollback], afterCompletion: [complete] } });
  const action = command({ run: () => success() });
  const app = await application(
    [
      action,
      plug({
        port: database,
        bind: () => ({
          async transaction(work) {
            await work();
            throw new Error("commit response lost");
          },
        }),
      }),
    ],
    database,
  );
  try {
    const result = await app.withScope((scope) => scope.resolve(action)());
    assert.ok(result.isError && UnitOfWorkError.is(result.error) && result.error.transactionStatus === "unknown");
    assert.deepEqual(observed, ["unknown"]);
  } finally {
    await app.stop();
  }
});

test("an immediate native delivery starts an independent listener UoW and context", async () => {
  const transactions: string[] = [],
    executions: ExecutionActor[] = [];
  let sequence = 0;
  const database = unitOfWork(),
    messages = publisher<number>(),
    expected = new Error("producer rolled back");
  const consume = command<number>()({
    run: (_, ctx) => {
      executions.push(ctx.actor);
      return success();
    },
  });
  const incoming = listener<number>()({ requirements: { consume }, run: (value, ctx) => ctx.consume(value) });
  const producer = command({
    requirements: { messages },
    run: async (_, ctx) => {
      executions.push(ctx.actor);
      await ctx.messages.publishNow(1);
      return failure(expected);
    },
  });
  const app = await application(
    [
      producer,
      incoming,
      plug({
        port: database,
        bind: () => ({
          async transaction(work) {
            const id = ++sequence;
            transactions.push(`begin:${id}`);
            try {
              const result = await work();
              transactions.push(`commit:${id}`);
              return result;
            } catch (error) {
              transactions.push(`rollback:${id}`);
              throw error;
            }
          },
        }),
      }),
      plug({
        port: messages,
        bind: () => async (input, options) => {
          await app.resolve(incoming)({ input, ...options });
        },
      }),
    ],
    database,
  );
  try {
    assert.deepEqual(
      await app.withScope((scope) => scope.resolve(producer)(undefined, { actor: "alice" })),
      failure(expected),
    );
    assert.deepEqual(transactions, ["begin:1", "begin:2", "commit:2", "rollback:1"]);
    assert.equal(executions.length, 2);
    assert.notEqual(executions[0], executions[1]);
    assert.deepEqual(executions, ["alice", undefined]);
  } finally {
    await app.stop();
  }
});

test("ignored cancellation before a nested handler starts still marks the root for rollback", async () => {
  let childRan = false,
    commits = 0;
  const database = unitOfWork();
  const child = command({
    run: () => {
      childRan = true;
      return success();
    },
  });
  const parent = command({
    requirements: { child },
    run: async (_, ctx) => {
      await ctx.child(undefined, { signal: AbortSignal.abort() });
      return success();
    },
  });
  const app = await application(
    [
      parent,
      plug({
        port: database,
        bind: () => ({
          async transaction(work) {
            const result = await work();
            commits++;
            return result;
          },
        }),
      }),
    ],
    database,
  );
  try {
    const result = await app.withScope((scope) => scope.resolve(parent)());
    assert.ok(result.isError && InputCancelledError.is(result.error));
    assert.equal(childRan, false);
    assert.equal(commits, 0);
  } finally {
    await app.stop();
  }
});

test("a nested handler cancelled while it runs fails with its cancellation and the root rolls back", async () => {
  let commits = 0;
  const database = unitOfWork();
  const controller = new AbortController();
  const child = command({
    run: () => {
      controller.abort(new Error("child cancelled"));
      return success();
    },
  });
  let nested: unknown;
  const parent = command({
    requirements: { child },
    run: async (_, ctx) => {
      nested = await ctx.child(undefined, { signal: controller.signal });
      return success();
    },
  });
  const app = await application(
    [
      parent,
      plug({
        port: database,
        bind: () => ({
          async transaction(work) {
            const result = await work();
            commits++;
            return result;
          },
        }),
      }),
    ],
    database,
  );
  try {
    const result = await app.withScope((scope) => scope.resolve(parent)());
    assert.ok(result.isError && InputCancelledError.is(result.error));
    assert.deepEqual(nested, result);
    assert.equal(commits, 0);
  } finally {
    await app.stop();
  }
});

test("a driver cancelled before it enters the work reports the cancellation", async () => {
  let entered = false;
  const database = unitOfWork();
  const controller = new AbortController();
  const root = command({
    run: () => {
      entered = true;
      return success();
    },
  });
  const app = await application(
    [
      root,
      plug({
        port: database,
        bind: () => ({
          async transaction(work, { signal }) {
            // The native transaction begins while the caller cancels.
            await Promise.resolve();
            controller.abort(new Error("cancelled while beginning"));
            signal.throwIfAborted();
            return work();
          },
        }),
      }),
    ],
    database,
  );
  try {
    const result = await app.withScope((scope) => scope.resolve(root)(undefined, { signal: controller.signal }));
    assert.ok(result.isError && InputCancelledError.is(result.error));
    assert.equal(entered, false);
  } finally {
    await app.stop();
  }
});
