import { integratedBy } from "./integration.ts";
import type { DefinitionAdapter } from "@openknot-ts/wire";
import {
  composeModule,
  decorate,
  defineApplication,
  describeApplication,
  hook,
  override,
  requiredBy,
  resource,
  unit,
} from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

test("describeApplication returns the composed graph without starting anything", async () => {
  const effects: string[] = [];
  const config = unit({ factory: () => ({ url: "file:default" }) });
  const testConfig = unit({ provides: config, factory: () => ({ url: "file:test" }) });
  const clock = unit({ factory: () => () => 1 });
  const repository = unit({ requirements: { config, clock }, factory: ({ config }) => config.url });
  const session = unit({ lifetime: "scoped", requirements: { repository }, factory: ({ repository }) => repository });
  const database = resource({
    requirements: { config },
    initialize() {
      effects.push("database:open");
      return Promise.resolve({ value: 1, release() {} });
    },
  });
  const started = hook({
    requirements: { repository },
    run() {
      effects.push("started");
    },
  });
  const timed = decorate(clock, { requirements: { config }, wrap: (inner) => inner });
  const description = await describeApplication(
    defineApplication({
      modules: requiredBy(
        composeModule({ providers: { session, database } }).includeOnly([database]),
        composeModule({ providers: { timed, config, testConfig } }).includeOnly([]),
      ),
      startupTasks: [started],
    }),
    { overrides: [override(repository, "stub")] },
  );
  assert.deepEqual(effects, []);
  assert.deepEqual(description.problems, []);
  const named = (name: string) => description.definitions.find((definition) => definition.names.includes(name));
  const byId = (id: number | undefined) => description.definitions.find((definition) => definition.id === id);
  assert.partialDeepStrictEqual(named("config"), { kind: "unit", lifetime: "singleton", binding: "implementation" });
  assert.partialDeepStrictEqual(named("repository"), { binding: "override" });
  assert.partialDeepStrictEqual(named("clock"), { binding: "implementation" });
  assert.deepEqual(named("clock")?.decorations, [
    { dependencies: [{ name: "config", optional: false, id: named("config")?.id }] },
  ]);
  const scoped = description.definitions.find((definition) => definition.lifetime === "scoped");
  assert.partialDeepStrictEqual(scoped, { kind: "unit", binding: "implementation" });
  assert.deepEqual(
    scoped?.dependencies.map(({ name, id }) => [name, byId(id)?.names]),
    [["repository", ["repository"]]],
  );
  assert.deepEqual(
    description.definitions.filter((definition) => definition.roles.length > 0).map(({ kind, roles }) => [kind, roles]),
    [
      // Listed by includeOnly(), the database is a root and, being a resource, acquired without a list.
      ["resource", ["root", "resource"]],
      ["hook", ["startup-task"]],
    ],
  );
});

test("describeApplication reports the problems runApplication would reject with", async () => {
  const session = unit({ lifetime: "scoped", factory: () => ({}) });
  const cache = unit({ requirements: { session }, factory: ({ session }) => session });
  const description = await describeApplication(
    defineApplication({ modules: requiredBy(composeModule({ providers: { cache } }).includeOnly([])) }),
  );
  assert.deepEqual(description.problems, [
    "- singleton unit 'cache' depends on scoped unit 'session', which has a shorter lifetime",
  ]);
});

test("deferred references are described as validation follows them", async () => {
  const dependency = unit({ factory: () => 1 });
  const consumer = unit({ requirements: { dependency }, factory: ({ dependency }) => dependency });
  // An integration definition that reaches its dependency only when it executes.
  const deferred = { testDeferred: true, ...integratedBy("test:deferred", () => adapter) };
  const adapter: DefinitionAdapter = {
    name: "test:deferred",
    adapt: (value) =>
      value === deferred
        ? { reference: deferred as never, references: [dependency], provider: unit({ factory: () => "deferred" }) }
        : undefined,
  };
  const description = await describeApplication(
    defineApplication({
      modules: [composeModule({ providers: { deferred: deferred as never, consumer } })],
    }),
  );
  const dependencyId = description.definitions.find((definition) => definition.names.includes("dependency"))?.id;
  const referring = description.definitions.find((definition) => definition.references.length > 0);
  assert.ok(dependencyId !== undefined);
  assert.deepEqual(referring?.references, [dependencyId]);
});

test("requirement names come from the binding that builds a definition", async () => {
  const contract = unit.contract<string>();
  const store = unit({ factory: () => "store" });
  const binding = unit({ provides: contract, requirements: { store }, factory: ({ store }) => store });
  const clock = unit({ factory: () => 0 });
  const original = unit({ factory: () => 1 });
  const second = unit({ provides: original, requirements: { clock }, factory: ({ clock }) => clock });
  const consumer = unit({
    requirements: { contract, original },
    factory: ({ contract, original }) => `${contract}${original}`,
  });
  const description = await describeApplication(
    defineApplication({
      modules: [composeModule({ providers: { consumer, binding, second } })],
    }),
  );
  const named = (name: string) => description.definitions.filter((definition) => definition.names.includes(name));
  assert.equal(named("store").length, 1);
  assert.equal(named("clock").length, 1);
});
