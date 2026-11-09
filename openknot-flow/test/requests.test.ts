import { expose, guard, InternalFlowError, listener, scheduler, topic } from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
import { success } from "@openknot-ts/behavior";
import { composeModule, defineApplication, resource, runApplication, plug } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

async function* empty(): AsyncIterable<never> {}

/** Every port kind reads a request the same way: an object, through its own fields, once. */
async function harness() {
  const events: string[] = [];
  const session = resource({
    lifetime: "scoped",
    async initialize() {
      events.push("acquired");
      return { value: "session", release() {} };
    },
  });
  const access = guard<string | undefined>()({
    requirements: { session },
    run: (input) => {
      events.push(`guard:${String(input)}`);
      return success();
    },
  });
  const entry = expose<string | undefined>()({
    requirements: { session },
    guards: { access },
    run: (input) => {
      events.push(`expose:${String(input)}`);
      return success(input);
    },
  });
  const delivery = listener<string | undefined>()({
    requirements: { session },
    run: (input) => {
      events.push(`listener:${String(input)}`);
      return success();
    },
  });
  const tick = scheduler({
    requirements: { session },
    schedule: { every: { seconds: 1 } },
    run: () => {
      events.push("scheduler");
      return success();
    },
  });
  const changes = topic<string | undefined, number>()({ guards: { access } });
  const binding = plug({
    port: changes,
    bind: () => ({
      publish() {},
      subscribe: (key) => {
        events.push(`topic:${String(key)}`);
        return empty();
      },
    }),
  });
  const app = await runApplication(
    defineApplication({ modules: [provideFlow([entry, delivery, tick]), composeModule({ providers: { binding } })] }),
  );
  const call = (invoke: unknown, request: unknown) => Reflect.apply(invoke as () => unknown, undefined, [request]);
  return { app, events, call, entry, delivery, tick, changes };
}

test("a request that is not an object is rejected before guards, handlers or resources", async () => {
  const { app, events, call, entry, delivery, tick, changes } = await harness();
  try {
    for (const request of [[], null, "input"]) {
      for (const invoke of [
        app.resolve(entry),
        app.resolve(delivery),
        app.resolve(tick),
        app.resolve(changes).subscribe,
      ]) {
        await assert.rejects(call(invoke, request) as Promise<unknown>, InternalFlowError.is);
      }
    }
    assert.deepEqual(events, []);
  } finally {
    await app.stop();
  }
});

test("inherited fields and getters never take part, absent fields read as undefined, own undefined passes", async () => {
  const { app, events, call, entry, delivery, changes } = await harness();
  try {
    let getters = 0;
    const inherited = Object.create({
      get input() {
        getters++;
        return "inherited";
      },
      get access() {
        getters++;
        return "inherited";
      },
      get signal() {
        getters++;
        return AbortSignal.abort();
      },
    });
    await call(app.resolve(entry), inherited);
    await call(app.resolve(delivery), inherited);
    await call(app.resolve(changes).subscribe, inherited);
    assert.equal(getters, 0);
    assert.deepEqual(events, [
      "acquired",
      "guard:undefined",
      "expose:undefined",
      "acquired",
      "listener:undefined",
      "acquired",
      "guard:undefined",
      "topic:undefined",
    ]);
    events.length = 0;
    // Absent and own undefined fields are the same input; own values pass unchanged.
    assert.deepEqual(await call(app.resolve(entry), {}), undefined);
    assert.deepEqual(await call(app.resolve(entry), { input: undefined, access: undefined }), undefined);
    assert.deepEqual(await call(app.resolve(entry), { input: "own", access: "own" }), "own");
    assert.deepEqual(events, [
      "acquired",
      "guard:undefined",
      "expose:undefined",
      "acquired",
      "guard:undefined",
      "expose:undefined",
      "acquired",
      "guard:own",
      "expose:own",
    ]);
  } finally {
    await app.stop();
  }
});

test("own input, guard and execution getters are each read once before admission", async () => {
  const { app, events, call, entry, delivery, changes } = await harness();
  const controller = new AbortController();
  try {
    for (const [invoke, guarded] of [
      [app.resolve(entry), true],
      [app.resolve(delivery), false],
      [app.resolve(changes).subscribe, true],
    ] as const) {
      const values: Record<string, unknown> = {
        input: "own",
        signal: controller.signal,
        actor: undefined,
        propagation: undefined,
        traceAttributes: undefined,
        ...(guarded ? { access: "own" } : {}),
      };
      const fields = Object.keys(values);
      const before = events.length;
      const reads: string[] = [];
      const request = Object.defineProperties(
        {},
        Object.fromEntries(
          fields.map((name) => [
            name,
            {
              enumerable: true,
              get() {
                assert.equal(events.length, before);
                reads.push(name);
                return values[name];
              },
            },
          ]),
        ),
      );
      await call(invoke, request);
      assert.deepEqual(reads.toSorted(), fields.toSorted());
    }
    assert.deepEqual(events, [
      "acquired",
      "guard:own",
      "expose:own",
      "acquired",
      "listener:own",
      "acquired",
      "guard:own",
      "topic:own",
    ]);
  } finally {
    controller.abort();
    await app.stop();
  }
});
