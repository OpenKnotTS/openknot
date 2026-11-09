import type { GivesOf } from "@openknot-ts/wire";
import {
  collect,
  composeModule,
  defineApplication,
  describeApplication,
  resource,
  runApplication,
  unit,
} from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

type Check = () => string;
const checks = collect.contract<Check>();
const named = (name: string) => unit({ provides: checks, factory: (): Check => () => name });
const report = unit({ requirements: { checks }, factory: ({ checks }) => checks.map((check) => check()) });
const reporting = composeModule({ providers: { report } });

test("a collection contract gathers the units that the selected modules list, in their order", async () => {
  const database = named("database");
  const cache = named("cache");
  const queue = named("queue");
  const io = composeModule({ providers: { database } });
  const channels = composeModule({ providers: { cache, queue } });
  const definition = defineApplication({ modules: [reporting, channels, io] });
  const app = await runApplication(definition);
  try {
    const names: readonly string[] = app.resolve(report);
    assert.deepEqual(names, ["cache", "queue", "database"]);
    const resolved: readonly Check[] = app.resolve(checks);
    assert.ok(Object.isFrozen(resolved));
    // A member stays an ordinary unit with its own identity.
    assert.equal(app.resolve(database)(), "database");
  } finally {
    await app.stop();
  }
  const description = await describeApplication(definition);
  const collection = description.definitions.find((entry) => entry.kind === "collection");
  assert.equal(collection?.dependencies.length, 3);
  assert.deepEqual(description.problems, []);
  // In the compile-time graph each member gives the contract it joins.
  const gives: GivesOf<typeof database> = checks;
  void gives;
  // @ts-expect-error A member builds one element of the contract.
  unit({ provides: checks, factory: () => 42 });
  assert.throws(
    // @ts-expect-error Only units join a collection contract.
    () => resource({ provides: checks, initialize: async () => ({ value: [], release() {} }) }),
    /gathers units/,
  );
});

test("exclusions and conditions decide membership, and a contract without members is empty", async () => {
  const cache = named("cache");
  const queue = named("queue");
  const database = unit({ factory: () => "connection" });
  const databaseCheck = unit({
    provides: checks,
    requirements: { database },
    whenAvailable: true,
    factory:
      ({ database }): Check =>
      () =>
        database,
  });
  const channels = composeModule({ providers: { cache, queue } });
  const health = composeModule({ providers: { databaseCheck } });
  const io = composeModule({ providers: { database } });
  const cases = [
    [[reporting], []],
    [[reporting, channels.exclude([queue])], ["cache"]],
    [
      [reporting, health, channels],
      ["cache", "queue"],
    ],
    [
      [reporting, health, channels, io],
      ["connection", "cache", "queue"],
    ],
  ] as const;
  for (const [modules, expected] of cases) {
    const app = await runApplication(defineApplication({ modules }));
    try {
      assert.deepEqual(app.resolve(report), expected);
    } finally {
      await app.stop();
    }
  }
  // A module that is only available offers implementations, and a requirement only reaches a unit: neither selects a member.
  const offered = named("offered");
  const reached = named("reached");
  const direct = unit({ requirements: { reached }, factory: ({ reached }) => reached });
  const elsewhere = await runApplication(
    defineApplication({
      modules: composeModule({ providers: { offered } }).requiredBy(
        reporting,
        composeModule({ providers: { direct } }),
      ),
    }),
  );
  try {
    assert.deepEqual(elsewhere.resolve(report), []);
    assert.equal(elsewhere.resolve(direct)(), "reached");
  } finally {
    await elsewhere.stop();
  }
  const listed = await runApplication(defineApplication({ modules: [composeModule({ providers: { checks } })] }));
  try {
    assert.deepEqual(listed.resolve(checks), []);
  } finally {
    await listed.stop();
  }
});

test("a singleton collection rejects scoped members, and each application gathers its own", async () => {
  const scoped = unit({ provides: checks, lifetime: "scoped", factory: (): Check => () => "scoped" });
  await assert.rejects(
    runApplication(
      defineApplication({ modules: [reporting, composeModule({ providers: { scoped } }).includeOnly([])] }),
    ),
    /singleton collection depends on scoped unit 'scoped', which has a shorter lifetime/,
  );

  const first = await runApplication(
    defineApplication({ modules: [reporting, composeModule({ providers: { one: named("one") } })] }),
  );
  const second = await runApplication(
    defineApplication({ modules: [reporting, composeModule({ providers: { two: named("two") } })] }),
  );
  try {
    assert.deepEqual(first.resolve(report), ["one"]);
    assert.deepEqual(second.resolve(report), ["two"]);
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});
