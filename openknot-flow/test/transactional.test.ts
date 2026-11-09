import type { UnitOfWorkImplementation, UowActive } from "../src/index.ts";
import { command, hook, InternalFlowError, publisher, unitOfWork } from "../src/index.ts";
import { transactional } from "../src/wire.ts";
import { application } from "./fixtures/unit-of-work.ts";
import { success } from "@openknot-ts/behavior";
import { plug } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

function tracking(events: string[]): UnitOfWorkImplementation {
  return {
    async transaction(work) {
      events.push("begin");
      try {
        const result = await work();
        events.push("commit");
        return result;
      } catch (error) {
        events.push("rollback");
        throw error;
      }
    },
  };
}

test("a transactional publisher's staged publications are sent inside the transaction, after beforeCommit hooks", async () => {
  const events: string[] = [];
  let failing = false;
  const stored = publisher<string>();
  const sent = publisher<string>();
  const before = hook<UowActive>()({
    run: () => {
      events.push("hook");
      return success();
    },
  });
  const database = unitOfWork({ hooks: { beforeCommit: [before] } });
  const change = command<string>()({
    requirements: { stored, sent },
    run: async (name, ctx) => {
      await ctx.stored.publish(name);
      await ctx.sent.publish(name);
      await ctx.stored.publish(() => `${name}-deferred`);
      events.push("handler");
      return success();
    },
  });
  const outbox = plug({
    port: stored,
    bind: () =>
      transactional(async (message: string) => {
        events.push(`stored ${message}`);
        if (failing) {
          throw new Error("outbox table missing");
        }
      }),
  });
  const broker = plug({ port: sent, bind: () => (message: string) => void events.push(`sent ${message}`) });
  const app = await application(
    [change, outbox, broker, plug({ port: database, bind: () => tracking(events) })],
    database,
  );
  try {
    const committed = await app.withScope((scope) => scope.resolve(change)("a"));
    assert.ok(!committed.isError);
    assert.deepEqual(events, ["begin", "handler", "hook", "stored a", "stored a-deferred", "commit", "sent a"]);

    events.length = 0;
    failing = true;
    const failed = await app.withScope((scope) => scope.resolve(change)("b"));
    assert.ok(failed.isError && InternalFlowError.is(failed.error));
    assert.deepEqual(events, ["begin", "handler", "hook", "stored b", "rollback"]);
  } finally {
    await app.stop();
  }
});

test("publishNow on a transactional publisher sends at once, still inside the transaction", async () => {
  const events: string[] = [];
  const stored = publisher<string>();
  const database = unitOfWork();
  const change = command({
    requirements: { stored },
    run: async (_, ctx) => {
      await ctx.stored.publishNow("now");
      events.push("handler");
      return success();
    },
  });
  const outbox = plug({
    port: stored,
    bind: () => transactional((message: string) => void events.push(`stored ${message}`)),
  });
  const app = await application([change, outbox, plug({ port: database, bind: () => tracking(events) })], database);
  try {
    assert.ok(!(await app.withScope((scope) => scope.resolve(change)())).isError);
    assert.deepEqual(events, ["begin", "stored now", "handler", "commit"]);
  } finally {
    await app.stop();
  }
});
