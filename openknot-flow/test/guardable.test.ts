import { broadcast, expose, guard, InputCancelledError, InternalFlowError, topic } from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
import { rejection } from "./fixtures/rejection.ts";
import { failure, success } from "@openknot-ts/behavior";
import { plug, composeModule, defineApplication, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

async function* empty(): AsyncIterable<never> {}

for (const kind of ["exposure", "broadcast", "topic"] as const) {
  test(`${kind} shares named guard inputs, validation, scopes and short-circuit execution`, async () => {
    const denied = new Error("denied");
    const seen: unknown[] = [];
    let executions = 0,
      businessResolutions = 0;
    const business = unit({ lifetime: "scoped", factory: () => ++businessResolutions });
    const first = guard<string>()({
      run: (value) => {
        seen.push(value);
        return value === "denied" ? failure(denied) : success();
      },
    });
    const organization = guard<{ readonly id: number }>()({
      run: (value) => {
        seen.push(value);
        return success();
      },
    });
    const guards = { first, organization, again: first };
    const work = (input: unknown) => {
      seen.push(input);
      executions++;
      return success();
    };
    const entry = expose<{ readonly id: string }>()({
      guards,
      requirements: { business },
      run: (input) => work(input),
    });
    const connection = broadcast<string>()({ guards });
    const updates = topic<"roles", string>()({ guards });
    const output = {
      updates: plug({
        port: updates,
        requirements: { business },
        bind: () => ({
          publish() {},
          subscribe: (key) => {
            work(key);
            return empty();
          },
        }),
      }),
      connection: plug({
        port: connection,
        requirements: { business },
        bind: () => ({
          publish() {},
          subscribe: () => {
            work(undefined);
            return empty();
          },
        }),
      }),
    };
    const app = await runApplication(
      defineApplication({
        modules: [provideFlow([entry, updates, connection]), composeModule({ providers: { ...output } })],
      }),
    );
    try {
      const input = kind === "exposure" ? { id: "role" } : kind === "topic" ? "roles" : undefined;
      const base = kind === "broadcast" ? { input } : kind === "topic" ? { input } : { input };
      const invoke =
        kind === "exposure"
          ? app.resolve(entry)
          : kind === "broadcast"
            ? app.resolve(connection).subscribe
            : app.resolve(updates).subscribe;
      // Every guardable resolves with its value and rejects with its classified failure.
      const call = (request: unknown): Promise<unknown> => Reflect.apply(invoke, undefined, [request]);
      const organizationInput = { id: 7 };
      let reads = 0;
      const request = {
        ...base,
        get first() {
          reads++;
          return "source";
        },
        organization: organizationInput,
        again: "destination",
      };

      // Missing fields read as undefined; a field nothing reads, a nested envelope or a non-object is malformed.
      for (const malformed of [
        { ...base, guards: { first: "source", organization: organizationInput, again: "destination" } },
        { ...base, context: { first: "source", organization: organizationInput, again: "destination" } },
        { ...request, unknownGuard: true },
        { ...request, guardInputs: () => ({}) },
        { ...request, actorId: "alice" },
        null,
        undefined,
        [],
      ]) {
        const error = await rejection(call(malformed));
        assert.ok(InternalFlowError.is(error) && error.cause instanceof TypeError);
      }
      assert.deepEqual(seen, []);
      assert.equal(businessResolutions, 0);

      assert.equal(await rejection(call({ ...request, first: "denied" })), denied);
      assert.deepEqual(seen, ["denied"]);
      assert.equal(executions, 0);
      assert.equal(businessResolutions, 0);
      seen.length = 0;

      reads = 0;
      await call(request);
      assert.deepEqual(seen, ["source", organizationInput, "destination", input]);
      assert.equal(seen[1], organizationInput);
      assert.equal(seen[3], input);
      assert.equal(reads, 1);
      assert.equal(executions, 1);
      assert.equal(businessResolutions, 1);
    } finally {
      await app.stop();
    }
  });

  test(`${kind} cancels pending admission without running later guards or business work`, async () => {
    const entered = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>();
    let later = 0,
      executions = 0;
    const waiting = guard<string>()({
      run: async (_input) => {
        entered.resolve();
        await finish.promise;
        return success();
      },
    });
    const next = guard<number>()({
      run: (_input) => {
        later++;
        return success();
      },
    });
    const guards = { waiting, next };
    const work = () => {
      executions++;
      return success();
    };
    const entry = expose({ guards, run: work });
    const connection = broadcast<string>()({ guards });
    const updates = topic<"roles", never>()({ guards });
    const output = {
      updates: plug({
        port: updates,
        bind: () => ({
          publish() {},
          subscribe: () => {
            work();
            return empty();
          },
        }),
      }),
      connection: plug({
        port: connection,
        bind: () => ({
          publish() {},
          subscribe: () => {
            work();
            return empty();
          },
        }),
      }),
    };
    const app = await runApplication(
      defineApplication({
        modules: [provideFlow([entry, updates, connection]), composeModule({ providers: { ...output } })],
      }),
    );
    try {
      const controller = new AbortController();
      const request = {
        input: kind === "topic" ? "roles" : undefined,
        waiting: "token",
        next: 2,
        signal: controller.signal,
      };
      const invoke =
        kind === "exposure"
          ? app.resolve(entry)
          : kind === "broadcast"
            ? app.resolve(connection).subscribe
            : app.resolve(updates).subscribe;
      const pending = rejection(Reflect.apply(invoke, undefined, [request]));
      await entered.promise;
      controller.abort("cancelled");
      finish.resolve();
      assert.ok(InputCancelledError.is(await pending));
      assert.equal(later, 0);
      assert.equal(executions, 0);
    } finally {
      finish.resolve();
      await app.stop();
    }
  });
}

test("every guardable uses the same declaration validation and rejects reserved guard names", () => {
  const access = guard({ run: () => success() });
  const factories = [
    (options: object) => Reflect.apply(expose, undefined, [{ ...options, run: () => success() }]),
    (options: object) => Reflect.apply(broadcast<string>(), undefined, [options]),
    (options: object) => Reflect.apply(topic<string, string>(), undefined, [options]),
  ];
  for (const create of factories) {
    for (const name of ["input", "signal", "actor", "propagation", "traceAttributes"]) {
      assert.throws(() => create({ guards: { [name]: access } }), /reserved/);
    }
    assert.throws(() => create({ guards: { access: {} } }), /Invalid guard/);
    assert.doesNotThrow(() => create({ guards: { access } }));
    assert.doesNotThrow(() => create({}));
  }
});

test("a void input or guard input may be left out of every guardable request, and reads as undefined", async () => {
  const seen: unknown[] = [];
  const signedIn = guard({
    run: (input) => {
      seen.push(input);
      return success();
    },
  });
  const entry = expose({ guards: { signedIn }, run: (input) => success(input) });
  const updates = topic<"roles", string>()({ guards: { signedIn } });
  const notifications = broadcast<string>()({ guards: { signedIn } });
  const using = { publish() {}, subscribe: empty };
  const app = await runApplication(
    defineApplication({
      modules: [
        provideFlow([entry]),
        composeModule({
          providers: {
            updates: plug({ port: updates, bind: () => using }),
            notifications: plug({ port: notifications, bind: () => using }),
          },
        }),
      ],
    }),
  );
  try {
    assert.deepEqual(await app.resolve(entry)({}), undefined);
    await app.resolve(updates).subscribe({ input: "roles" });
    await app.resolve(notifications).subscribe({});
    assert.deepEqual(seen, [undefined, undefined, undefined]);
  } finally {
    await app.stop();
  }
});
