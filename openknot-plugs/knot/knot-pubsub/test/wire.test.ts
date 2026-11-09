import { inMemoryBroadcast, inMemoryTopic } from "../src/index.ts";
import { failure, reader, success } from "@openknot-ts/behavior";
import { broadcast, command, defaultUnitOfWork, expose, guard, topic } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import { composeModule, defineApplication, plug, providePlugs, resource, runApplication } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

test("Flow guards release admission resources before native delivery and native recipient reads stay behind a reader port", async () => {
  type Audience = { readonly userId: string; readonly roleId: number; readonly scope: "summary" | "detail" };
  const events = new EventEmitter();
  let acquired = 0,
    released = 0,
    effects = 0;
  const emitted: { readonly effects: number; readonly commits: number }[] = [];
  const observe = () => {
    emitted.push({ effects, commits: completed.length });
  };
  const session = resource({
    lifetime: "scoped",
    async initialize() {
      acquired++;
      return {
        value: {},
        release() {
          released++;
        },
      };
    },
  });
  const access = guard<string>()({
    requirements: { session },
    run: (token) => (token === "allowed" ? success() : failure(new Error("Denied"))),
  });
  const roles = topic<Audience, string>()({ guards: { access } });
  const logs = broadcast<string>()({ guards: { access } });
  const recipients = reader<(roleId: number) => readonly Audience[]>();
  const roleDelivery = resource({
    initialize: () =>
      inMemoryTopic<Audience, string>({
        events,
        event: (key) => `roles:${JSON.stringify([key.userId, key.roleId, key.scope])}`,
      }),
  });
  const logDelivery = resource({ initialize: () => inMemoryBroadcast<string>({ events, event: "logs" }) });
  const bindings = {
    roles: plug({
      port: roles,
      requirements: { roleDelivery },
      bind: ({ roleDelivery }) => roleDelivery,
    }),
    logs: plug({
      port: logs,
      requirements: { logDelivery },
      bind: ({ logDelivery }) => logDelivery,
    }),
    recipients: plug({
      port: recipients,
      requirements: { roleDelivery },
      bind:
        ({ roleDelivery }) =>
        (roleId) =>
          roleDelivery.keys().filter((key) => key.roleId === roleId),
    }),
  };
  const notify = command<{ readonly roleId: number; readonly fail: boolean }>()({
    requirements: { roles, logs, recipients },
    run: async (input, ctx) => {
      for (const key of ctx.recipients(input.roleId)) {
        // Recipient policy belongs to Flow; native delivery fans out to duplicate consumers of this key.
        if (key.scope === "detail") {
          await ctx.roles.publish(key, "changed");
        }
      }
      await ctx.logs.publish("logged");
      ctx.uow.afterCommit(() => {
        effects++;
      });
      if (input.fail) {
        return failure(new Error("rolled back"));
      }
      return success();
    },
  });
  const notifyExposure = expose<{ readonly roleId: number; readonly fail: boolean }>()({
    requirements: { notify },
    run: (input, ctx) => ctx.notify(input),
  });
  const completed: string[] = [];
  const uow = plug({
    port: defaultUnitOfWork,
    bind: () => ({
      transaction: async (work) => {
        const value = await work();
        completed.push("commit");
        return value;
      },
    }),
  });
  const app = await runApplication(
    defineApplication({
      modules: [
        provideFlow([roles, logs, recipients, notifyExposure]),
        providePlugs([roleDelivery, logDelivery, bindings]),
        composeModule({ providers: { uow } }),
      ],
    }),
  );
  try {
    const key: Audience = { userId: "alice", roleId: 1, scope: "detail" };
    await assert.rejects(app.resolve(roles).subscribe({ input: key, access: "denied" }), /Denied/);
    assert.equal(app.resolve(roleDelivery).subscriberCount(key), 0);
    const first = (await app.resolve(roles).subscribe({ input: key, access: "allowed" }))[Symbol.asyncIterator]();
    const second = (await app.resolve(roles).subscribe({ input: { ...key }, access: "allowed" }))[
      Symbol.asyncIterator
    ]();
    const summary = (await app.resolve(roles).subscribe({ input: { ...key, scope: "summary" }, access: "allowed" }))[
      Symbol.asyncIterator
    ]();
    const log = (await app.resolve(logs).subscribe({ input: undefined, access: "allowed" }))[Symbol.asyncIterator]();
    events.on("logs", observe);
    assert.equal(acquired, released, "The live subscriptions retain no scoped admission session.");
    assert.equal(acquired, 5);
    const firstValue = first.next(),
      secondValue = second.next(),
      logValue = log.next();
    await assert.rejects(app.withScope((scope) => scope.resolve(notifyExposure)({ input: { roleId: 1, fail: true } })));
    assert.equal(effects, 0);
    assert.deepEqual(completed, []);
    assert.deepEqual(emitted, []);
    await app.withScope((scope) => scope.resolve(notifyExposure)({ input: { roleId: 1, fail: false } }));
    assert.equal(effects, 1);
    assert.deepEqual(completed, ["commit"]);
    assert.deepEqual(emitted, [{ effects: 1, commits: 1 }], "Native emission follows commit and staged effects.");
    assert.deepEqual(await firstValue, { done: false, value: "changed" });
    assert.deepEqual(await secondValue, { done: false, value: "changed" });
    assert.deepEqual(await logValue, { done: false, value: "logged" });
    const unaddressed = summary.next();
    events.off("logs", observe);
    await app.stop();
    assert.deepEqual(await unaddressed, { done: true, value: undefined });
    assert.equal(events.listenerCount("logs"), 0);
    assert.deepEqual(events.eventNames(), []);
    assert.deepEqual(await first.next(), { done: true, value: undefined }, "Rollback staged no hidden publication.");
  } finally {
    await app.stop();
  }
});
