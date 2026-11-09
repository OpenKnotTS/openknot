import { integratedBy } from "./integration.ts";
import type { AdaptedDefinition, DefinitionAdapter, DefinitionAdapterContext, Resolved } from "@openknot-ts/wire";
import {
  runApplication,
  defineApplication,
  composeModule,
  optional,
  override,
  resource,
  unit,
} from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

interface GreetingDefinition {
  readonly testGreeting: string;
}
declare module "@openknot-ts/wire" {
  interface DefinitionTypes {
    readonly testGreeting: GreetingDefinition;
  }
  interface DefinitionResults<_D> {
    readonly testGreeting: _D extends GreetingDefinition ? () => string : never;
  }
}

test("reference providers use identity rather than dependency property or export names", async () => {
  const source = unit({ factory: () => 21 });
  const compute = unit({ requirements: { argument: source }, factory: ({ argument }) => argument * 2 });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { compute } })] }));
  try {
    const value: Resolved<typeof compute> = app.resolve(compute);
    assert.equal(value, 42);
  } finally {
    await app.stop();
  }
});

test("a binding's reference graph supplies private dependencies without a registry entry", async () => {
  const original = unit({ factory: () => 1 });
  const privateValue = unit({ factory: () => 42 });
  const binding = unit({ provides: original, requirements: { value: privateValue }, factory: ({ value }) => value });
  const app = await runApplication(
    defineApplication({
      modules: [composeModule({ providers: { original, binding } })],
    }),
  );
  try {
    assert.equal(app.resolve(original), 42);
  } finally {
    await app.stop();
  }
});

test("a definition loads its adapter through its marker, and without one nothing recognizes it", async () => {
  const greeting: GreetingDefinition = { testGreeting: "hello", ...integratedBy("test:greeting", () => adapter) };
  const module = composeModule({ providers: { greeting, ordinaryExport: { ignored: true } } }).includeOnly([greeting]);
  const adapter: DefinitionAdapter = {
    name: "test:greeting",
    adapt(value): AdaptedDefinition | undefined {
      if (value !== greeting) {
        return undefined;
      }
      return { reference: greeting, provider: unit({ factory: () => () => greeting.testGreeting }) };
    },
  };
  const app = await runApplication(defineApplication({ modules: [module] }));
  try {
    assert.equal(app.resolve(greeting)(), "hello");
  } finally {
    await app.stop();
  }
  const unknown: GreetingDefinition = { testGreeting: "nothing loads me" };
  await assert.rejects(
    runApplication(defineApplication({ modules: [composeModule({ providers: { unknown } }).includeOnly([unknown])] })),
    /adapter/,
  );
});

test("a definition consumed only optionally loads its adapter, so an application's override binds it", async () => {
  const greeting: GreetingDefinition = { testGreeting: "unbound", ...integratedBy("test:optional", () => adapter) };
  const adapter: DefinitionAdapter = {
    name: "test:optional",
    adapt: (value): AdaptedDefinition | undefined =>
      value === greeting ? { reference: greeting, provider: unit.contract<() => string>() } : undefined,
  };
  const consume = unit({ requirements: { greeting: optional(greeting) }, factory: ({ greeting }) => greeting?.() });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { consume } })] }), {
    overrides: [override(greeting, () => "overridden")],
  });
  try {
    assert.equal(app.resolve(consume), "overridden");
  } finally {
    await app.stop();
  }
});

test("once stop has drained its scopes, an adapter's cleanup scope is refused", async () => {
  let adapterContext: DefinitionAdapterContext | undefined;
  const greeting: GreetingDefinition = { testGreeting: "drained", ...integratedBy("test:drained", () => adapter) };
  const adapter: DefinitionAdapter = {
    name: "test:drained",
    adapt(value, context) {
      if (value !== greeting) {
        return undefined;
      }
      adapterContext = context;
      return { reference: greeting, provider: unit({ factory: () => () => greeting.testGreeting }) };
    },
  };
  let late: Promise<unknown> | undefined;
  // Resources release after the scopes drained, with the application's own references already released.
  const closing = resource({
    initialize: async () => ({
      value: "open",
      release: () => {
        late = adapterContext?.withScope(() => "opened", { cleanup: true });
      },
    }),
  });
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { greeting, closing } })] }),
    { stopOn: [] },
  );
  assert.equal(app.resolve(greeting)(), "drained");
  await app.stop();
  assert.ok(late !== undefined);
  await assert.rejects(late, /Cannot open a scope while application is 'stopping'/);
});

test("requirement-reference cycles fail at startup with their path", async () => {
  const first: GreetingDefinition = { testGreeting: "first", ...integratedBy("test:cyclic", () => adapter) };
  const second: GreetingDefinition = { testGreeting: "second" };
  const adapter: DefinitionAdapter = {
    name: "test:cyclic",
    adapt(value) {
      if (value !== first && value !== second) {
        return undefined;
      }
      const reference = value === first ? first : second;
      const dependency = value === first ? second : first;
      return { reference, provider: unit({ requirements: { dependency }, factory: ({ dependency }) => dependency }) };
    },
  };
  await assert.rejects(
    runApplication(
      defineApplication({
        modules: [composeModule({ providers: { first, second } }).includeOnly([first])],
      }),
    ),
    /cyclic dependency \(definition 'first' → dependency → dependency\)/,
  );
});

test("provider requirements enforce construction contracts and freeze dependency snapshots", async () => {
  const source = unit({ factory: () => 1 });
  const requirements = { source };
  const capture = unit({ requirements: requirements, factory: (ctx) => () => ctx.source });
  requirements.source = unit({ factory: () => 2 });
  const module = composeModule({ providers: { source, capture } });
  const app = await runApplication(defineApplication({ modules: [module] }));
  try {
    assert.equal(app.resolve(capture)(), 1);
  } finally {
    await app.stop();
  }
  const invalid = unit({ factory: async () => 1 });
  await assert.rejects(
    runApplication(defineApplication({ modules: [composeModule({ providers: { invalid } })] })),
    /Factories must be synchronous/,
  );
});
