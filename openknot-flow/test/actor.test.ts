import { command, expose, guard, hook, listener, publisher, query, unitOfWork } from "../src/index.ts";
import { actorResolver, executionActorResolver, provideFlow } from "../src/wire.ts";
import { success } from "@openknot-ts/behavior";
import { composeModule, defineApplication, optional, runApplication, unit, plug } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

test("actor resolvers are ordinary callable dependencies and cannot manufacture absent parents", async () => {
  const api = unit({ factory: () => ({ verify: (token: string) => ({ subject: token, roles: ["admin"] }) }) });
  const identity = actorResolver({ requirements: { api }, resolve: (token: string, ctx) => ctx.api.verify(token) });
  const consume = unit({
    requirements: { identity: optional(executionActorResolver) },
    factory: ({ identity }) => identity,
  });
  const absent = await runApplication(defineApplication({ modules: [provideFlow([identity, consume])] }));
  try {
    assert.equal(absent.resolve(consume), undefined);
    assert.equal(absent.resolve(optional(executionActorResolver)), undefined);
    assert.throws(() => absent.resolve(executionActorResolver), /unavailable/);
  } finally {
    await absent.stop();
  }
  const present = await runApplication(defineApplication({ modules: [provideFlow([identity, consume, api])] }));
  try {
    const resolve = present.resolve(consume);
    assert.ok(resolve);
    assert.equal(present.resolve(executionActorResolver), resolve);
    assert.deepEqual(await resolve("alice"), { subject: "alice", roles: ["admin"] });
    assert.deepEqual(await present.resolve(identity)("bob"), { subject: "bob", roles: ["admin"] });
    let called = false;
    const signal = AbortSignal.abort("cancelled");
    await assert.rejects(resolve("ignored", { signal }), (error) => error === signal.reason);
    const bad = actorResolver({
      resolve: () => {
        called = true;
        return undefined;
      },
    });
    const other = await runApplication(defineApplication({ modules: [provideFlow([bad])] }));
    try {
      await assert.rejects(other.resolve(bad)("ignored", { signal }));
      assert.equal(called, false);
    } finally {
      await other.stop();
    }
  } finally {
    await present.stop();
  }
});

test("one actor reaches admission, nested work, UoW drivers and hooks; messaging starts without it", async () => {
  const actor = { subject: "alice", tenant: "airport" };
  const seen: unknown[] = [];
  const deliveries: unknown[] = [];
  const before = hook<unknown>()({
    run: (_, ctx) => {
      seen.push(ctx.actor);
      return success();
    },
  });
  const transaction = unitOfWork({ hooks: { beforeCommit: [before] } });
  const nested = query({
    unitOfWork: transaction,
    run: (_, ctx) => {
      seen.push(ctx.actor);
      return success();
    },
  });
  const incoming = listener<number>()({
    run: (_, ctx) => {
      deliveries.push(ctx.actor);
      return success();
    },
  });
  const events = publisher<number>();
  const action = command({
    unitOfWork: transaction,
    requirements: { nested, events },
    run: async (_, ctx) => {
      assert.ok(Object.isFrozen(ctx));
      seen.push(ctx.actor, ctx.uow.actor);
      const result = await ctx.nested(undefined, { actor: { subject: "cannot-replace" } });
      assert.ok(!result.isError);
      await ctx.events.publish(1);
      return success(ctx.actor);
    },
  });
  const admitted = guard({
    run: (_, ctx) => {
      seen.push(ctx.actor);
      return success();
    },
  });
  const api = expose({ handler: action, guards: { admitted } });
  const app = await runApplication(
    defineApplication({
      modules: composeModule({
        providers: {
          transaction: plug({
            port: transaction,
            bind: () => ({
              transaction: async (work, options) => {
                seen.push(options.actor);
                return work();
              },
            }),
          }),
          publication: plug({
            port: events,
            bind: () => async (_value, options) => {
              assert.equal(Object.hasOwn(options, "actor"), false);
              assert.equal(Object.hasOwn(options, "metadata"), false);
              await app.resolve(incoming)({ input: 1 });
            },
          }),
        },
      }).requiredBy(provideFlow([api, incoming])),
    }),
  );
  try {
    assert.equal(await app.resolve(api)({ input: undefined, admitted: undefined, actor }), actor);
    assert.equal(seen.length, 6);
    assert.ok(seen.every((value) => value === actor));
    assert.deepEqual(deliveries, [undefined]);
    assert.equal(Object.isFrozen(actor), false, "The runtime freezes its binding, not application-owned values.");
  } finally {
    await app.stop();
  }
});
