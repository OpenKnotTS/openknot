import type { ApplicationOptions } from "@openknot-ts/wire";
import {
  composeModule,
  decorate,
  defineApplication,
  override,
  providePlugs,
  resource,
  runApplication,
  unit,
} from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

test("decorations wrap an implementation in declaration order and inherit its lifetime", async () => {
  const greet = unit({ lifetime: "scoped", factory: () => (name: string) => `hi ${name}` });
  const prefix = unit({ factory: () => ">" });
  const consumer = unit({ lifetime: "scoped", requirements: { greet }, factory: ({ greet }) => greet("ada") });
  const prefixed = decorate(greet, {
    requirements: { prefix },
    wrap:
      (inner, { prefix }) =>
      (name) =>
        `${prefix}${inner(name)}`,
  });
  const upper = decorate(greet, { wrap: (inner) => (name) => inner(name).toUpperCase() });
  const app = await runApplication(
    defineApplication({
      modules: [
        composeModule({ providers: { greet, consumer } }).includeOnly([]),
        composeModule({ providers: { prefixed, upper } }),
      ],
    }),
  );
  try {
    const first = await app.withScope((scope) => {
      assert.equal(scope.resolve(consumer), ">HI ADA");
      assert.equal(scope.resolve(greet), scope.resolve(greet));
      return scope.resolve(greet);
    });
    await app.withScope((scope) => assert.notEqual(scope.resolve(greet), first));
  } finally {
    await app.stop();
  }
});

test("each target has its own typed decoration, sharing requirements as any definitions do", async () => {
  const calls: string[] = [];
  const log = unit({ factory: () => calls });
  const add = unit({ factory: () => (a: number, b: number) => a + b });
  const label = unit({ factory: () => (value: string) => `#${value}` });
  const countedAdd = decorate(add, {
    requirements: { log },
    wrap:
      (inner, { log }) =>
      (a, b) => {
        log.push("call");
        return inner(a, b);
      },
  });
  const countedLabel = decorate(label, {
    requirements: { log },
    wrap:
      (inner, { log }) =>
      (value) => {
        log.push("call");
        return inner(value);
      },
  });
  const app = await runApplication(
    defineApplication({
      modules: [composeModule({ providers: { add, label, log, countedAdd, countedLabel } })],
    }),
  );
  try {
    assert.equal(app.resolve(add)(2, 3), 5);
    assert.equal(app.resolve(label)("x"), "#x");
    assert.deepEqual(calls, ["call", "call"]);
  } finally {
    await app.stop();
  }
});

test("a binding is decorated, while an override stays the final value", async () => {
  const value = unit({ factory: () => 1 });
  const alternative = unit({ provides: value, factory: () => 2 });
  const doubled = decorate(value, { wrap: (inner) => inner * 2 });
  const definition = defineApplication({
    modules: [composeModule({ providers: { value, alternative, doubled } })],
  });
  const bound = await runApplication(definition);
  const overridden = await runApplication(definition, { overrides: [override(value, 10)] });
  try {
    assert.equal(bound.resolve(value), 4);
    assert.equal(overridden.resolve(value), 10);
  } finally {
    await Promise.all([bound.stop(), overridden.stop()]);
  }
});

test("decorations fail at startup for unavailable targets, shorter lifetimes and non-unit targets", async () => {
  let acquisitions = 0;
  const shared = resource({
    initialize() {
      acquisitions++;
      return Promise.resolve({ value: 1, release() {} });
    },
  });
  const value = unit({ factory: () => 1 });
  const session = unit({ lifetime: "scoped", factory: () => 2 });
  const module = composeModule({ providers: { value, session, shared } }).includeOnly([value]);
  const cases = [
    [decorate(unit({ factory: () => 0 }), { wrap: (inner) => inner }), /decoration targets a unit that is unavailable/],
    [
      decorate(value, { requirements: { session }, wrap: (inner, { session }) => inner + session }),
      /decoration of singleton unit 'value' depends on scoped unit 'session', which has a shorter lifetime/,
    ],
    [
      decorate(shared, { wrap: (inner) => inner }),
      /only units and contracts can be decorated, not the resource 'shared'/,
    ],
  ] as const;
  for (const [decoration, message] of cases) {
    await assert.rejects(
      runApplication(defineApplication({ modules: [module, composeModule({ providers: { decoration } })] })),
      message,
    );
  }
  assert.equal(acquisitions, 0);
  assert.throws(() => Reflect.apply(decorate, undefined, [value, {}]), /requires \{ wrap/);
});

test("the root modules decide which decorations apply and in what order", async () => {
  const value = unit({ factory: () => "value" });
  const first = decorate(value, { wrap: (inner) => `first(${inner})` });
  const second = decorate(value, { wrap: (inner) => `second(${inner})` });
  const base = composeModule({ providers: { value } });
  const one = composeModule({ providers: { first } });
  const two = providePlugs([second]);
  const cases: readonly [NonNullable<ApplicationOptions["modules"]>, string][] = [
    [[base, one, two], "second(first(value))"],
    [[base, two, one], "first(second(value))"],
    [[base, one.when(false), two], "second(value)"],
    [[base, one, two.exclude([second])], "first(value)"],
    // A module that is only available offers what others ask for; nothing asks for a decoration.
    [one.requiredBy(base, two), "second(value)"],
  ];
  for (const [modules, expected] of cases) {
    const app = await runApplication(defineApplication({ modules }));
    try {
      assert.equal(app.resolve(value), expected);
    } finally {
      await app.stop();
    }
  }
});
