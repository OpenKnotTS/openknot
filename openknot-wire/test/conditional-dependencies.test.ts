import {
  composeModule,
  defineApplication,
  hook,
  optional,
  override,
  resource,
  runApplication,
  unit,
} from "../src/index.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("optional dependencies consume existing bindings without introducing absent providers", async () => {
  let constructions = 0;
  const client = unit({
    factory: () => {
      constructions++;
      return { connected: true };
    },
  });
  const consumer = unit({ requirements: { client: optional(client) }, factory: ({ client }) => client });
  const missing = await runApplication(defineApplication({ modules: [composeModule({ providers: { consumer } })] }));
  try {
    assert.equal(missing.resolve(consumer), undefined);
    assert.equal(missing.resolve(optional(client)), undefined);
    assert.equal(constructions, 0);
    assert.throws(() => missing.resolve(client), /unavailable/);
  } finally {
    await missing.stop();
  }
  const present = await runApplication(
    defineApplication({
      modules: [composeModule({ providers: { consumer, client } }).includeOnly([consumer])],
    }),
  );
  try {
    assert.equal(present.resolve(consumer), present.resolve(client));
    assert.equal(present.resolve(optional(client)), present.resolve(client));
    assert.equal(constructions, 1);
  } finally {
    await present.stop();
  }
});

test("optional bindings retain native errors and strict scope/lifetime ownership", async () => {
  const defect = new Error("client failed");
  const broken = unit({
    factory: () => {
      throw defect;
    },
  });
  const reads = unit({ requirements: { broken: optional(broken) }, factory: ({ broken }) => broken });
  await assert.rejects(
    runApplication(
      defineApplication({
        modules: [composeModule({ providers: { reads, broken } }).includeOnly([reads])],
      }),
    ),
    (error) => error === defect,
  );
  const session = unit({ lifetime: "scoped", factory: () => ({}) });
  const captive = unit({ requirements: { session: optional(session) }, factory: ({ session }) => session });
  await assert.rejects(
    runApplication(
      defineApplication({
        modules: [composeModule({ providers: { captive, session } }).includeOnly([captive])],
      }),
    ),
    /shorter lifetime/,
  );
  const scoped = unit({
    lifetime: "scoped",
    requirements: { session: optional(session) },
    factory: ({ session }) => session,
  });
  const app = await runApplication(
    defineApplication({
      modules: [composeModule({ providers: { scoped, session } }).includeOnly([])],
    }),
  );
  try {
    assert.throws(() => app.resolve(optional(session)), /withScope/);
    const first = await app.withScope((scope) => {
      assert.equal(scope.resolve(scoped), scope.resolve(session));
      assert.equal(scope.resolve(optional(session)), scope.resolve(session));
      return scope.resolve(scoped);
    });
    const second = await app.withScope((scope) => scope.resolve(scoped));
    assert.notEqual(first, second);
  } finally {
    await app.stop();
  }
});

test("a provides binding replaces its reference's own default with one instance", async () => {
  let defaults = 0,
    implementations = 0;
  const contract = unit({
    factory: (): { id: number } | undefined => {
      defaults++;
      return undefined;
    },
  });
  const implementation = unit({
    provides: contract,
    factory: () => {
      implementations++;
      return { id: 42 };
    },
  });
  const consumer = unit({ requirements: { contract, weak: optional(contract) }, factory: (ctx) => ctx });
  for (const providers of [
    { contract, implementation, consumer },
    { consumer, implementation, contract },
  ]) {
    const app = await runApplication(
      defineApplication({ modules: [composeModule({ providers }).includeOnly([consumer])] }),
    );
    try {
      const value = app.resolve(consumer);
      assert.equal(value.contract, value.weak);
      assert.equal(value.contract, app.resolve(implementation));
      assert.equal(value.contract, app.resolve(contract));
    } finally {
      await app.stop();
    }
  }
  assert.equal(defaults, 0);
  assert.equal(implementations, 2);
});

test("availability uses registered reference metadata without probing factories or their return values", async () => {
  let probes = 0;
  const dependency = unit({
    factory: () => {
      probes++;
      return undefined;
    },
  });
  const integration = unit({ whenAvailable: [dependency], factory: () => "enabled" });
  const app = await runApplication(
    defineApplication({
      modules: [composeModule({ providers: { integration, dependency } }).includeOnly([])],
    }),
  );
  try {
    assert.equal(probes, 0);
    assert.equal(app.resolve(integration), "enabled");
    assert.equal(probes, 0);
  } finally {
    await app.stop();
  }
});

test("a conditional provider cannot manufacture its own prerequisites through requirements", async () => {
  let called = 0;
  const client = unit({
    factory: () => {
      called++;
      return "client";
    },
  });
  const integration = unit({ whenAvailable: [client], requirements: { client }, factory: ({ client }) => client });
  const consumer = unit({
    requirements: { integration: optional(integration) },
    factory: ({ integration }) => integration,
  });
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { integration, consumer } })] }),
  );
  try {
    assert.equal(app.resolve(consumer), undefined);
    assert.equal(called, 0);
    assert.throws(() => app.resolve(integration), /unavailable/);
    assert.throws(() => app.resolve(client), /unavailable/);
  } finally {
    await app.stop();
  }
});

test("whenAvailable true checks declared required dependencies and leaves optional dependencies weak", async () => {
  const sdk = unit({ factory: () => "sdk" });
  const diagnostics = unit({
    factory: () => {
      throw new Error("must not be introduced");
    },
  });
  const integration = unit({
    requirements: { sdk, diagnostics: optional(diagnostics) },
    whenAvailable: true,
    factory: ({ sdk, diagnostics }) => ({ sdk, diagnostics }),
  });
  const app = await runApplication(
    defineApplication({
      modules: [composeModule({ providers: { integration, sdk } })],
    }),
  );
  try {
    assert.deepEqual(app.resolve(integration), { sdk: "sdk", diagnostics: undefined });
  } finally {
    await app.stop();
  }
});

test("positive conditional chains are independent of module order and treat unbound contracts as absent", async () => {
  const seed = unit({ factory: () => "sdk" });
  const first = unit.contract<string>();
  const second = unit.contract<string>();
  const firstBinding = unit({
    provides: first,
    whenAvailable: [seed],
    requirements: { seed },
    factory: ({ seed }) => seed,
  });
  const secondBinding = unit({
    provides: second,
    whenAvailable: [first],
    requirements: { first },
    factory: ({ first }) => first,
  });
  const consumer = unit({ requirements: { second: optional(second) }, factory: ({ second }) => second });
  const integrations = composeModule({
    providers: { secondBinding, firstBinding, first, second, consumer },
  }).includeOnly([consumer]);
  const absent = await runApplication(defineApplication({ modules: [integrations] }));
  try {
    assert.equal(absent.resolve(consumer), undefined);
  } finally {
    await absent.stop();
  }
  const sdk = composeModule({ providers: { seed } }).includeOnly([]);
  for (const modules of [
    [integrations, sdk],
    [sdk, integrations],
  ]) {
    const app = await runApplication(defineApplication({ modules }));
    try {
      assert.equal(app.resolve(consumer), "sdk");
    } finally {
      await app.stop();
    }
  }
});

test("conditional cycles remain inactive without a concrete seed", async () => {
  let activations = 0;
  const first = unit.contract<number>();
  const second = unit.contract<number>();
  const a = unit({ provides: first, whenAvailable: [second], factory: () => ++activations });
  const b = unit({ provides: second, whenAvailable: [first], factory: () => ++activations });
  const consumer = unit({
    requirements: { first: optional(first), second: optional(second) },
    factory: (values) => values,
  });
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { first, second, a, b, consumer } })] }),
  );
  try {
    assert.deepEqual(app.resolve(consumer), { first: undefined, second: undefined });
    assert.equal(activations, 0);
  } finally {
    await app.stop();
  }
});

test("hard exclusions disable conditions and disabled native binding modules leave defaults usable", async () => {
  const client = unit({ factory: () => "sdk" });
  const contract = unit({ factory: () => "default" });
  const binding = unit({
    provides: contract,
    whenAvailable: [client],
    requirements: { client },
    factory: ({ client }) => client,
  });
  const consumer = unit({ requirements: { contract, client: optional(client) }, factory: (ctx) => ctx });
  const base = composeModule({ providers: { client, consumer } }).includeOnly([consumer]);
  const integration = composeModule({ providers: { binding } }).includeOnly([]);
  for (const modules of [
    [base.exclude([client]), integration],
    [base, integration.when(false)],
  ]) {
    const app = await runApplication(defineApplication({ modules }));
    try {
      assert.equal(app.resolve(consumer).contract, "default");
    } finally {
      await app.stop();
    }
  }
});

test("conditional resources and tasks skip absent integrations and canonical aliases acquire once", async () => {
  const events: string[] = [];
  const present = unit({ factory: () => true });
  const absent = unit({ factory: () => true });
  const storage = resource({ initialize: async () => ({ value: "default", release() {} }) });
  const managed = resource({
    provides: storage,
    whenAvailable: [present],
    initialize: async () => {
      events.push("open");
      return {
        value: "native",
        release() {
          events.push("close");
        },
      };
    },
  });
  const ignored = resource({
    whenAvailable: [absent],
    initialize: async () => {
      throw new Error("must stay inactive");
    },
  });
  const skipped = hook({
    whenAvailable: [absent],
    run: () => {
      throw new Error("must stay inactive");
    },
  });
  const started = hook({
    whenAvailable: [present],
    requirements: { managed },
    run: ({ managed }) => {
      events.push(managed);
    },
  });
  const app = await runApplication(
    defineApplication({
      modules: [composeModule({ providers: { managed, storage, ignored, present } })],
      startupTasks: [skipped, started],
      shutdownTasks: [skipped],
    }),
  );
  assert.equal(app.resolve(storage), "native");
  assert.deepEqual(events, ["open", "native"]);
  await app.stop();
  assert.deepEqual(events, ["open", "native", "close"]);
});

test("provided scoped resources inherit their target's lifetime and release each scope independently", async () => {
  let opened = 0,
    closed = 0;
  const contract = resource({
    lifetime: "scoped",
    initialize: async () => ({ value: 0, release() {} }),
  });
  const binding = resource({
    provides: contract,
    initialize: async () => ({
      value: ++opened,
      release() {
        closed++;
      },
    }),
  });
  const app = await runApplication(
    defineApplication({
      modules: [composeModule({ providers: { contract, binding } })],
    }),
  );
  try {
    assert.equal(await app.withScope((scope) => scope.resolve(contract)), 1);
    assert.equal(await app.withScope((scope) => scope.resolve(binding)), 2);
    assert.equal(closed, 2);
  } finally {
    await app.stop();
  }
});

test("overrides and bindings count as explicit configuration for a listed contract", async () => {
  const contract = unit.contract<number>();
  const configured = unit({ provides: contract, factory: () => 42 });
  const integration = unit({
    whenAvailable: [contract],
    requirements: { contract },
    factory: ({ contract }) => contract,
  });
  const modules = [composeModule({ providers: { contract, integration } })];
  const bound = await runApplication(
    defineApplication({ modules: [...modules, composeModule({ providers: { configured } })] }),
  );
  try {
    assert.equal(bound.resolve(integration), 42);
  } finally {
    await bound.stop();
  }
  const overridden = await runApplication(defineApplication({ modules }), { overrides: [override(contract, 21)] });
  try {
    assert.equal(overridden.resolve(integration), 21);
  } finally {
    await overridden.stop();
  }
});

test("a reference's own default satisfies conditions, while an unbound contract does not", async () => {
  const ordinary = unit({ factory: () => 1 });
  const contract = unit.contract<number>();
  const onDefault = unit({ whenAvailable: [ordinary], factory: () => true });
  const onContract = unit({ whenAvailable: [contract], factory: () => true });
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { ordinary, contract, onDefault, onContract } })] }),
  );
  try {
    assert.equal(app.resolve(onDefault), true);
    assert.throws(() => app.resolve(onContract), /unavailable/);
  } finally {
    await app.stop();
  }
});

test("ambiguous bindings fail before lifecycle acquisition and conditional metadata is immutable", async () => {
  let acquired = 0;
  const contract = unit({ factory: () => 0 });
  const one = unit({ provides: contract, factory: () => 1 });
  const two = unit({ provides: contract, factory: () => 2 });
  const managed = resource({
    initialize: async () => {
      acquired++;
      return { value: 1, release() {} };
    },
  });
  await assert.rejects(
    runApplication(
      defineApplication({
        modules: [composeModule({ providers: { contract, one, two, managed } })],
      }),
    ),
    /multiple implementations supplied for unit 'contract'/,
  );
  assert.equal(acquired, 0);
  const conditions = [contract];
  const conditional = unit({ whenAvailable: conditions, factory: () => 1 });
  conditions.length = 0;
  assert.deepEqual(conditional.whenAvailable, [contract]);
  assert.ok(Object.isFrozen(conditional.whenAvailable));
  assert.throws(() => Reflect.apply(unit, undefined, [{ provides: managed, factory: () => 1 }]), /same kind/);
  assert.throws(() => unit({ provides: contract, lifetime: "scoped", factory: () => 1 }), /lifetime/);
  assert.throws(() => Reflect.apply(unit, undefined, [{ factory: () => 1, whenAvailable: () => true }]), /array/);
});

test("inactive conditional bindings do not bind a contract or pull in their prerequisites", async () => {
  let opened = 0;
  const sdk = unit({
    factory: () => {
      opened++;
      return 42;
    },
  });
  const contract = unit.contract<number>();
  const replacement = unit({
    provides: contract,
    whenAvailable: [sdk],
    requirements: { sdk },
    factory: ({ sdk }) => sdk,
  });
  const integration = unit({
    whenAvailable: [contract],
    requirements: { contract },
    factory: ({ contract }) => contract,
  });
  const base = composeModule({ providers: { contract, integration, replacement } });
  const absent = await runApplication(defineApplication({ modules: [base] }));
  try {
    assert.throws(() => absent.resolve(integration), /unavailable/);
    assert.equal(opened, 0);
  } finally {
    await absent.stop();
  }
  const present = await runApplication(
    defineApplication({
      modules: [base, composeModule({ providers: { sdk } })],
    }),
  );
  try {
    assert.equal(present.resolve(integration), 42);
  } finally {
    await present.stop();
  }
});

test("availability does not mistake an unregistered implementation for another binding of its contract", async () => {
  const contract = unit({ factory: () => 0 });
  const registered = unit({ provides: contract, factory: () => 1 });
  const absent = unit({ provides: contract, factory: () => 2 });
  const enabled = unit({ whenAvailable: [registered], factory: () => true });
  const disabled = unit({
    whenAvailable: [absent],
    factory: () => {
      throw new Error("must not activate");
    },
  });
  const app = await runApplication(
    defineApplication({
      modules: [composeModule({ providers: { contract, registered, enabled, disabled } })],
    }),
  );
  try {
    assert.equal(app.resolve(enabled), true);
    assert.throws(() => app.resolve(disabled), /unavailable/);
  } finally {
    await app.stop();
  }
});
