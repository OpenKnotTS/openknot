import type { UowActive, UowCommitted, UowCompleted, UowRolledBack } from "../src/index.ts";
import {
  command,
  defaultUnitOfWork,
  expose,
  hook,
  InputCancelledError,
  InputUnavailableError,
  InternalFlowError,
  PostCommitError,
  publisher,
  unitOfWork,
  UnitOfWorkError,
  writer,
} from "../src/index.ts";
import type {} from "../src/wire.ts";
import { provideFlow } from "../src/wire.ts";
import { rejection } from "./fixtures/rejection.ts";
import { application, recording } from "./fixtures/unit-of-work.ts";
import { error, failure, InternalBehaviorError, operation, reader, success, updated } from "@openknot-ts/behavior";
import { composeModule, defineApplication, optional, resource, runApplication, plug, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

const AccessDenied = error("AccessDenied");

test("a writer exception is an internal failure with its cause that rolls back and discards staged work", async () => {
  const outcomes: string[] = [],
    sent: number[] = [];
  const cause = new Error("disk full");
  const save = writer<(value: number) => Promise<void>>();
  const events = publisher<number>();
  const database = unitOfWork();
  const change = command<number>()({
    requirements: { save, events },
    run: async (value, ctx) => {
      await ctx.events.publish(value);
      ctx.uow.afterCommit(() => {
        sent.push(-value);
      });
      await ctx.save(value);
      return success();
    },
  });
  const app = await application(
    [
      change,
      plug({
        port: events,
        bind: () => (value) => {
          sent.push(value);
        },
      }),
      plug({ port: save, bind: () => () => Promise.reject(cause) }),
      plug({ port: database, bind: () => recording(outcomes) }),
    ],
    database,
  );
  try {
    const result = await app.withScope((scope) => scope.resolve(change)(1));
    assert.ok(result.isError && InternalFlowError.is(result.error));
    assert.equal(result.error.cause, cause);
    assert.deepEqual(outcomes, ["rollback"]);
    assert.deepEqual(sent, []);
  } finally {
    await app.stop();
  }
});

test("a reader exception stays a behavior failure and an authored failure keeps its identity; both roll back", async () => {
  const outcomes: string[] = [];
  const unavailable = new Error("replica unavailable");
  const find = reader<(id: string) => Promise<number>>();
  const decide = operation<string>()({
    tag: "decide",
    requirements: { find },
    run: async (id, ctx) => {
      const found = await ctx.find(id);
      return found > 0 ? success({ output: updated(found) }) : failure(AccessDenied());
    },
  });
  const change = command<string>()({
    requirements: { decide },
    run: async (id, ctx) => {
      const decided = await ctx.decide(id);
      if (decided.isError) {
        return decided;
      }
      return success(decided.value.output.next);
    },
  });
  const database = unitOfWork();
  const app = await application(
    [
      change,
      plug({
        port: find,
        bind: () => async (id) => {
          if (id === "broken") {
            throw unavailable;
          }
          return id === "denied" ? 0 : 1;
        },
      }),
      plug({ port: database, bind: () => recording(outcomes) }),
    ],
    database,
  );
  try {
    const broken = await app.withScope((scope) => scope.resolve(change)("broken"));
    assert.ok(broken.isError && InternalBehaviorError.is(broken.error));
    assert.equal(broken.error.cause, unavailable);
    assert.equal(broken.error.boundary, "decide");
    const denied = await app.withScope((scope) => scope.resolve(change)("denied"));
    assert.ok(denied.isError && AccessDenied.is(denied.error));
    assert.deepEqual(await app.withScope((scope) => scope.resolve(change)("allowed")), success(1));
    assert.deepEqual(outcomes, ["rollback", "rollback", "commit"]);
  } finally {
    await app.stop();
  }
});

test("a Flow failure that an outer handler throws again keeps its identity instead of being wrapped twice", async () => {
  const outcomes: string[] = [];
  const cause = new Error("constraint violated");
  const save = writer<(value: number) => Promise<void>>();
  let nested: Error | undefined;
  const inner = command<number>()({
    requirements: { save },
    run: async (value, ctx) => {
      await ctx.save(value);
      return success();
    },
  });
  const outer = command<number>()({
    requirements: { inner },
    run: async (value, ctx) => {
      const result = await ctx.inner(value);
      if (result.isError) {
        nested = result.error;
        throw result.error;
      }
      return success();
    },
  });
  const database = unitOfWork();
  const app = await application(
    [
      outer,
      plug({ port: save, bind: () => () => Promise.reject(cause) }),
      plug({ port: database, bind: () => recording(outcomes) }),
    ],
    database,
  );
  try {
    const result = await app.withScope((scope) => scope.resolve(outer)(1));
    assert.ok(result.isError && InternalFlowError.is(result.error));
    assert.equal(result.error, nested);
    assert.equal(result.error.cause, cause);
    assert.deepEqual(outcomes, ["rollback"]);
  } finally {
    await app.stop();
  }
});

test("a before-commit hook keeps its cancellation and internal failures, and its authored failure vetoes", async () => {
  const outcomes: string[] = [];
  const defect = new Error("audit table missing"),
    veto = AccessDenied("Commit window closed");
  let mode: "cancel" | "throw" | "veto" = "cancel";
  let controller = new AbortController();
  const check = hook<UowActive>()({
    run: (_, ctx) => {
      if (mode === "cancel") {
        controller.abort();
        ctx.signal.throwIfAborted();
      }
      if (mode === "throw") {
        throw defect;
      }
      return failure(veto);
    },
  });
  const database = unitOfWork({ hooks: { beforeCommit: [check] } });
  const change = command({ run: () => success() });
  const app = await application([change, plug({ port: database, bind: () => recording(outcomes) })], database);
  try {
    const run = () => app.withScope((scope) => scope.resolve(change)(undefined, { signal: controller.signal }));
    const cancelled = await run();
    assert.ok(cancelled.isError && InputCancelledError.is(cancelled.error));
    mode = "throw";
    controller = new AbortController();
    const thrown = await run();
    assert.ok(thrown.isError && InternalFlowError.is(thrown.error));
    assert.equal(thrown.error.cause, defect);
    mode = "veto";
    const vetoed = await run();
    assert.ok(vetoed.isError && UnitOfWorkError.is(vetoed.error));
    assert.equal(vetoed.error.cause, veto);
    assert.equal(vetoed.error.transactionStatus, "rolled-back");
    assert.deepEqual(outcomes, ["rollback", "rollback", "rollback"]);
  } finally {
    await app.stop();
  }
});

test("after commit, a failing hook or effect stops nothing: every one runs and the events are delivered", async () => {
  const outcomes: string[] = [],
    sent: number[] = [];
  const expected = new Error("cache unavailable"),
    effectFailed = new Error("search index unavailable");
  const ran: string[] = [];
  const invalidate = hook<UowCommitted>()({ run: () => failure(expected) });
  const notify = hook<UowCommitted>()({
    run: () => {
      ran.push("notify");
      return success();
    },
  });
  const events = publisher<number>();
  const database = unitOfWork({ hooks: { afterCommit: [invalidate, notify] } });
  const change = command<boolean>()({
    requirements: { events },
    run: async (both, ctx) => {
      await ctx.events.publish(1);
      if (both) {
        ctx.uow.afterCommit(() => {
          throw effectFailed;
        });
        ctx.uow.afterCommit(() => {
          ran.push("effect");
        });
      }
      return success();
    },
  });
  const app = await application(
    [
      change,
      plug({
        port: events,
        bind: () => (value) => {
          sent.push(value);
        },
      }),
      plug({ port: database, bind: () => recording(outcomes) }),
    ],
    database,
  );
  try {
    const single = await app.withScope((scope) => scope.resolve(change)(false));
    assert.ok(single.isError && PostCommitError.is(single.error));
    assert.equal(single.error.phase, "effects");
    assert.equal(single.error.cause, expected);
    const both = await app.withScope((scope) => scope.resolve(change)(true));
    assert.ok(both.isError && PostCommitError.is(both.error) && both.error.phase === "effects");
    assert.deepEqual((both.error.cause as AggregateError).errors, [expected, effectFailed]);
    assert.deepEqual(ran, ["notify", "notify", "effect"]);
    assert.deepEqual(outcomes, ["commit", "commit"]);
    assert.deepEqual(sent, [1, 1]);
  } finally {
    await app.stop();
  }
});

test("cleanup hook failures keep whether the work committed or rolled back, and every failure", async () => {
  const outcomes: string[] = [];
  const offline = new Error("audit offline"),
    rejected = AccessDenied();
  const audit = hook<UowCompleted>()({
    run: () => {
      throw offline;
    },
  });
  const database = unitOfWork({ hooks: { afterCompletion: [audit] } });
  const change = command<boolean>()({ run: (allowed) => (allowed ? success() : failure(rejected)) });
  const app = await application([change, plug({ port: database, bind: () => recording(outcomes) })], database);
  try {
    const committed = await app.withScope((scope) => scope.resolve(change)(true));
    assert.ok(committed.isError && PostCommitError.is(committed.error));
    assert.equal(committed.error.phase, "completion");
    const [completion] = (committed.error.cause as AggregateError).errors;
    assert.ok(InternalFlowError.is(completion) && completion.cause === offline);
    const rolledBack = await app.withScope((scope) => scope.resolve(change)(false));
    assert.ok(rolledBack.isError && UnitOfWorkError.is(rolledBack.error));
    assert.equal(rolledBack.error.transactionStatus, "rolled-back");
    const [work, cleanup] = (rolledBack.error.cause as AggregateError).errors;
    assert.equal(work, rejected);
    assert.ok(InternalFlowError.is(cleanup) && cleanup.cause === offline);
    assert.deepEqual(outcomes, ["commit", "rollback"]);
  } finally {
    await app.stop();
  }
});

test("a native failure while rolling back leaves the outcome unknown and keeps the work's failure", async () => {
  const lost = new Error("connection lost during rollback"),
    rejected = AccessDenied();
  const database = unitOfWork();
  const change = command({ run: () => failure(rejected) });
  const app = await application(
    [
      change,
      plug({
        port: database,
        bind: () => ({
          async transaction(work) {
            try {
              return await work();
            } catch {
              throw lost;
            }
          },
        }),
      }),
    ],
    database,
  );
  try {
    const result = await app.withScope((scope) => scope.resolve(change)());
    assert.ok(result.isError && UnitOfWorkError.is(result.error));
    assert.equal(result.error.transactionStatus, "unknown");
    assert.deepEqual((result.error.cause as AggregateError).errors, [rejected, lost]);
  } finally {
    await app.stop();
  }
});

test("a scope that fails to release after its input settled keeps what the execution established", async () => {
  const outcomes: string[] = [];
  const released = new Error("connection release failed"),
    rejected = AccessDenied();
  const session = resource({
    lifetime: "scoped",
    initialize: async () => ({
      value: {},
      release() {
        throw released;
      },
    }),
  });
  const change = command<boolean>()({
    requirements: { session },
    run: (allowed) => (allowed ? success() : failure(rejected)),
  });
  const api = expose({ handler: change });
  const database = unitOfWork();
  const app = await runApplication(
    defineApplication({
      modules: [
        provideFlow([api]),
        composeModule({
          providers: {
            driver: plug({ port: database, bind: () => recording(outcomes) }),
            selection: unit({
              provides: defaultUnitOfWork,
              lifetime: "scoped",
              requirements: { database },
              factory: ({ database }) => database,
            }),
          },
        }),
      ],
    }),
  );
  try {
    const committed = await rejection(app.resolve(api)({ input: true }));
    assert.ok(PostCommitError.is(committed));
    assert.equal(committed.phase, "completion");
    assert.deepEqual((committed.cause as AggregateError).errors, [released]);
    const failed = await rejection(app.resolve(api)({ input: false }));
    assert.ok(InternalFlowError.is(failed));
    const [work, cleanup] = (failed.cause as AggregateError).errors;
    assert.equal(work, rejected);
    assert.deepEqual((cleanup as AggregateError).errors, [released]);
    assert.deepEqual(outcomes, ["commit", "rollback"]);
  } finally {
    await app.stop();
  }
});

test("a cancelled execution stops before its next port call and rolls back", async () => {
  const outcomes: string[] = [],
    saved: number[] = [];
  let controller = new AbortController();
  const save = writer<(value: number) => Promise<void>>();
  const validate = operation<number>()({ run: (value) => success({ output: updated(value) }) });
  const change = command<"operation" | "optional">()({
    requirements: { save, validate, later: optional(save) },
    run: async (next, ctx) => {
      await ctx.save(1);
      controller.abort();
      if (next === "operation") {
        await ctx.validate(2);
      } else {
        await ctx.later?.(2);
      }
      return success();
    },
  });
  const database = unitOfWork();
  const app = await application(
    [
      change,
      plug({
        port: save,
        bind: () => async (value) => {
          saved.push(value);
        },
      }),
      plug({ port: database, bind: () => recording(outcomes) }),
    ],
    database,
  );
  try {
    for (const next of ["operation", "optional"] as const) {
      controller = new AbortController();
      const result = await app.withScope((scope) => scope.resolve(change)(next, { signal: controller.signal }));
      assert.ok(result.isError && InputCancelledError.is(result.error));
    }
    assert.deepEqual(saved, [1, 1]);
    assert.deepEqual(outcomes, ["rollback", "rollback"]);
  } finally {
    await app.stop();
  }
});

test("rollback cleanup runs its port calls although the execution was cancelled, and publishes nothing", async () => {
  const audited: string[] = [],
    sent: string[] = [];
  const controller = new AbortController();
  const audit = writer<(entry: string) => Promise<void>>();
  const alerts = publisher<string>();
  const record = hook<UowRolledBack>()({
    requirements: { audit, alerts },
    run: async (event, ctx) => {
      await ctx.audit(event.error.name);
      // Work that did not commit publishes nothing, so this fails the hook.
      await ctx.alerts.publish(event.error.name);
      return success();
    },
  });
  const database = unitOfWork({ hooks: { afterRollback: [record] } });
  const change = command({
    run: () => {
      controller.abort();
      return success();
    },
  });
  const app = await application(
    [
      change,
      plug({
        port: audit,
        bind: () => async (entry) => {
          audited.push(entry);
        },
      }),
      plug({
        port: alerts,
        bind: () => (entry) => {
          sent.push(entry);
        },
      }),
      plug({ port: database, bind: () => recording([]) }),
    ],
    database,
  );
  try {
    const result = await app.withScope((scope) => scope.resolve(change)(undefined, { signal: controller.signal }));
    assert.ok(result.isError && UnitOfWorkError.is(result.error));
    assert.equal(result.error.transactionStatus, "rolled-back");
    const [work, refused] = (result.error.cause as AggregateError).errors;
    assert.ok(InputCancelledError.is(work));
    assert.ok(UnitOfWorkError.is(refused) && refused.message === "The Unit of Work did not commit");
    assert.deepEqual(audited, ["InputCancelledError"]);
    assert.deepEqual(sent, []);
  } finally {
    await app.stop();
  }
});

test("after commit, hooks and effects run with a signal the caller's cancellation does not abort", async () => {
  const controller = new AbortController();
  const observed: boolean[] = [],
    delivered: (boolean | undefined)[] = [];
  const events = publisher<number>();
  const notify = hook<UowCommitted>()({
    run: (_, ctx) => {
      controller.abort();
      observed.push(ctx.signal.aborted);
      return success();
    },
  });
  const database = unitOfWork({ hooks: { afterCommit: [notify] } });
  const change = command({
    requirements: { events },
    run: async (_, ctx) => {
      ctx.uow.afterCommit(() => ctx.events.publishNow(1));
      return success();
    },
  });
  const app = await application(
    [
      change,
      plug({
        port: events,
        bind: () => (_value, options) => {
          delivered.push(options.signal?.aborted);
        },
      }),
      plug({ port: database, bind: () => recording([]) }),
    ],
    database,
  );
  try {
    const result = await app.withScope((scope) => scope.resolve(change)(undefined, { signal: controller.signal }));
    assert.deepEqual(result, success());
    assert.deepEqual(observed, [false]);
    assert.deepEqual(delivered, [false]);
  } finally {
    await app.stop();
  }
});

test("a behavior failure passes through a handler, whose fallback for authored errors cannot hide it", async () => {
  const unavailable = new Error("replica unavailable");
  const broken = operation({
    tag: "broken",
    run: () => {
      throw unavailable;
    },
  });
  const fallback = command({
    requirements: { broken },
    run: async (_, ctx) => {
      const result = await ctx.broken();
      return result.isError ? success("fallback") : success("found");
    },
  });
  const database = unitOfWork();
  const app = await application([fallback, plug({ port: database, bind: () => recording([]) })], database);
  try {
    const result = await app.withScope((scope) => scope.resolve(fallback)());
    assert.ok(result.isError && InternalBehaviorError.is(result.error));
    assert.equal(result.error.boundary, "broken");
    assert.equal(result.error.cause, unavailable);
  } finally {
    await app.stop();
  }
});

test("a driver that swallows the requested rollback leaves the outcome unknown and keeps the work's failure", async () => {
  const rejected = AccessDenied();
  const deny = command({ run: () => failure(rejected) });
  const database = unitOfWork();
  const app = await application(
    [
      deny,
      plug({
        port: database,
        bind: () => ({
          async transaction(work) {
            try {
              return await work();
            } catch {
              return undefined as never;
            }
          },
        }),
      }),
    ],
    database,
  );
  try {
    const result = await app.withScope((scope) => scope.resolve(deny)());
    assert.ok(result.isError && UnitOfWorkError.is(result.error));
    assert.equal(result.error.transactionStatus, "unknown");
    assert.equal(result.error.cause, rejected);
  } finally {
    await app.stop();
  }
});

test("a Flow error that reaches an execution through a plug is that execution's infrastructure failure", async () => {
  const outcomes: string[] = [];
  // Plugs that invoke another execution and pass on its rejection, as an in-process bus or module call may.
  const elsewhere = PostCommitError("publications", new Error("another command's broker"));
  const draining = InputUnavailableError();
  const find = reader<() => Promise<number>>();
  const events = publisher<number>();
  const change = command<"reader" | "publisher">()({
    requirements: { find, events },
    run: async (source, ctx) => {
      if (source === "reader") {
        await ctx.find();
      } else {
        await ctx.events.publishNow(1);
      }
      return success();
    },
  });
  const database = unitOfWork();
  const app = await application(
    [
      change,
      plug({ port: find, bind: () => () => Promise.reject(elsewhere) }),
      plug({
        port: events,
        bind: () => () => {
          throw draining;
        },
      }),
      plug({ port: database, bind: () => recording(outcomes) }),
    ],
    database,
  );
  try {
    for (const [source, foreign] of [
      ["reader", elsewhere],
      ["publisher", draining],
    ] as const) {
      const result = await app.withScope((scope) => scope.resolve(change)(source));
      assert.ok(result.isError && InternalFlowError.is(result.error));
      assert.equal(result.error.cause, foreign);
    }
    assert.deepEqual(outcomes, ["rollback", "rollback"]);
  } finally {
    await app.stop();
  }
});

test("a vetoed commit whose rollback fails reports an unknown outcome with the veto as its cause", async () => {
  const lost = new Error("connection lost during rollback"),
    veto = AccessDenied("Commit window closed");
  const check = hook<UowActive>()({ run: () => failure(veto) });
  const database = unitOfWork({ hooks: { beforeCommit: [check] } });
  const change = command({ run: () => success() });
  const app = await application(
    [
      change,
      plug({
        port: database,
        bind: () => ({
          async transaction(work) {
            try {
              return await work();
            } catch {
              throw lost;
            }
          },
        }),
      }),
    ],
    database,
  );
  try {
    const result = await app.withScope((scope) => scope.resolve(change)());
    assert.ok(result.isError && UnitOfWorkError.is(result.error));
    assert.equal(result.error.transactionStatus, "unknown");
    assert.deepEqual((result.error.cause as AggregateError).errors, [veto, lost]);
  } finally {
    await app.stop();
  }
});

test("a driver's own errors and returned values never stand in for the Unit of Work's outcome", async () => {
  const rejected = AccessDenied();
  const driverError = UnitOfWorkError("rollback failed", { transactionStatus: "rolled-back" });
  const throwing = unitOfWork(),
    replacing = unitOfWork();
  const deny = command({ unitOfWork: throwing, run: () => failure(rejected) });
  const allow = command({ unitOfWork: replacing, run: () => success(1) });
  const app = await application([
    deny,
    allow,
    plug({
      port: throwing,
      bind: () => ({
        async transaction(work) {
          try {
            return await work();
          } catch {
            throw driverError;
          }
        },
      }),
    }),
    plug({
      port: replacing,
      bind: () => ({
        async transaction(work) {
          await work();
          return { rows: 1 } as never;
        },
      }),
    }),
  ]);
  try {
    const thrown = await app.withScope((scope) => scope.resolve(deny)());
    assert.ok(thrown.isError && UnitOfWorkError.is(thrown.error) && thrown.error !== driverError);
    assert.equal(thrown.error.transactionStatus, "unknown");
    assert.deepEqual((thrown.error.cause as AggregateError).errors, [rejected, driverError]);
    const replaced = await app.withScope((scope) => scope.resolve(allow)());
    assert.ok(replaced.isError && UnitOfWorkError.is(replaced.error));
    assert.equal(replaced.error.transactionStatus, "unknown");
  } finally {
    await app.stop();
  }
});

test("a beforeCommit hook's foreign Flow error vetoes, and nested failures recorded meanwhile come first", async () => {
  const elsewhere = PostCommitError("publications", new Error("another command's broker"));
  const ran: string[] = [];
  let mode: "foreign" | "nested" = "foreign";
  // Nested work under another Unit of Work fails the active one, even when the hook ignores its result.
  const other = unitOfWork();
  const check = command({ unitOfWork: other, run: () => success() });
  const first = hook<UowActive>()({
    requirements: { check },
    run: async (_, ctx) => {
      ran.push("first");
      if (mode === "foreign") {
        return failure(elsewhere);
      }
      await ctx.check();
      return success();
    },
  });
  const second = hook<UowActive>()({
    run: () => {
      ran.push("second");
      return failure(AccessDenied("Second veto"));
    },
  });
  const database = unitOfWork({ hooks: { beforeCommit: [first, second] } });
  const change = command({ run: () => success() });
  const app = await application(
    [
      change,
      check,
      plug({ port: database, bind: () => recording([]) }),
      plug({ port: other, bind: () => recording([]) }),
    ],
    database,
  );
  try {
    const foreign = await app.withScope((scope) => scope.resolve(change)());
    assert.ok(foreign.isError && UnitOfWorkError.is(foreign.error));
    assert.equal(foreign.error.transactionStatus, "rolled-back");
    assert.equal(foreign.error.cause, elsewhere);
    mode = "nested";
    const nested = await app.withScope((scope) => scope.resolve(change)());
    assert.ok(nested.isError && UnitOfWorkError.is(nested.error));
    assert.equal(nested.error.message, "Nested work must use the same resolved Unit of Work");
    assert.deepEqual(ran, ["first", "first"]);
  } finally {
    await app.stop();
  }
});

test("work an execution leaves running stops at its next port call once the execution completed", async () => {
  const saved: number[] = [];
  const gate = Promise.withResolvers<void>();
  let detached: Promise<unknown> | undefined;
  const save = writer<(value: number) => Promise<void>>();
  const change = command({
    requirements: { save },
    run: async (_, ctx) => {
      detached = rejection(
        (async () => {
          await gate.promise;
          await ctx.save(2);
        })(),
      );
      return success();
    },
  });
  const database = unitOfWork();
  const app = await application(
    [
      change,
      plug({
        port: save,
        bind: () => async (value) => {
          saved.push(value);
        },
      }),
      plug({ port: database, bind: () => recording([]) }),
    ],
    database,
  );
  try {
    assert.deepEqual(await app.withScope((scope) => scope.resolve(change)()), success());
    gate.resolve();
    const error = await detached;
    assert.ok(error instanceof Error && error.name === "AbortError");
    assert.deepEqual(saved, []);
  } finally {
    await app.stop();
  }
});
