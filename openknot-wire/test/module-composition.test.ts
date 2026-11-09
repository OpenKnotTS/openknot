import type { Definition } from "../src/index.ts";
import {
  runApplication,
  collect,
  composeModule,
  defineApplication,
  isProvider,
  requiredBy,
  resource,
  unit,
} from "../src/index.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("composeModule shares selectors and identity across named providers and deferred composition sources", async () => {
  let loads = 0;
  let dormantConstructions = 0;
  const dependency = unit({ factory: () => "ready" });
  const selected = unit({ requirements: { dependency }, factory: ({ dependency }) => dependency });
  const dormant = unit({
    factory: () => {
      dormantConstructions++;
      return "dormant";
    },
  });
  const plain = composeModule({ providers: { dependency } });
  const sources = composeModule({
    sources: [
      async () => {
        loads++;
        return { selected, dormant };
      },
    ],
    accepts: isProvider,
    label: "test composition",
  });
  const nested = composeModule({ modules: [sources.includeOnly([selected])], providers: { dependency } });
  assert.equal(loads, 0);
  const app = await runApplication(
    defineApplication({ modules: composeModule({ modules: [plain, sources] }).requiredBy(nested) }),
  );
  try {
    assert.equal(app.resolve(selected), "ready");
    assert.equal(loads, 1);
    assert.equal(dormantConstructions, 0);
  } finally {
    await app.stop();
  }
});

test("composeModule rejects combining source composition with named module configuration", () => {
  for (const configuration of [{ providers: {} }, { modules: [] }]) {
    assert.throws(
      () =>
        Reflect.apply(composeModule, undefined, [
          {
            sources: [],
            accepts: isProvider,
            label: "invalid",
            ...configuration,
          },
        ]),
      /accepts either sources or providers\/modules/,
    );
  }
});

test("shared selectors snapshot arguments and preserve lazy construction for immediate and deferred modules", async () => {
  for (const deferred of [false, true]) {
    let loads = 0;
    let created = 0;
    const selected = unit({ factory: () => ++created });
    const removed = unit({
      factory: () => {
        throw new Error("Excluded provider was constructed");
      },
    });
    const source = deferred
      ? composeModule({
          sources: [
            async () => {
              loads++;
              return { selected, removed };
            },
          ],
          accepts: isProvider,
          label: "selector parity",
        })
      : composeModule({ providers: { selected, removed } });
    const roots: Definition[] = [selected];
    const exclusions: Definition[] = [removed];
    const view = source.includeOnly(roots).exclude(exclusions);
    roots[0] = removed;
    exclusions[0] = selected;
    assert.equal(view.when(true), view);
    const app = await runApplication(defineApplication({ modules: source.requiredBy(view) }));
    try {
      assert.equal(app.resolve(selected), 1);
      assert.equal(created, 1);
      assert.throws(() => app.resolve(removed), /excluded|unavailable/);
      assert.equal(loads, deferred ? 1 : 0);
    } finally {
      await app.stop();
    }
  }
});

test("excluding immediate or deferred modules propagates their own hard exclusions", async () => {
  for (const deferredSource of [false, true]) {
    for (const deferredExclusion of [false, true]) {
      let sourceLoads = 0;
      let exclusionLoads = 0;
      const kept = unit({ factory: () => "kept" });
      const removed = unit({
        factory: () => {
          throw new Error("Excluded member was constructed");
        },
      });
      const inherited = unit({
        factory: () => {
          throw new Error("Inherited exclusion was lost");
        },
      });
      const source = deferredSource
        ? composeModule({
            sources: [
              async () => {
                sourceLoads++;
                return { kept, removed };
              },
            ],
            accepts: isProvider,
            label: "source",
          })
        : composeModule({ providers: { kept, removed } });
      const excluded = (
        deferredExclusion
          ? composeModule({
              sources: [
                async () => {
                  exclusionLoads++;
                  return { removed, inherited };
                },
              ],
              accepts: isProvider,
              label: "exclusion",
            })
          : composeModule({ providers: { removed, inherited } })
      ).exclude([inherited]);
      const view = source.exclude([excluded]).includeOnly([kept]);
      const app = await runApplication(
        defineApplication({
          modules: composeModule({ modules: [source, composeModule({ providers: { inherited } })] }).requiredBy(view),
        }),
      );
      try {
        assert.equal(app.resolve(kept), "kept");
        assert.throws(() => app.resolve(removed), /excluded|unavailable/);
        assert.throws(() => app.resolve(inherited), /excluded|unavailable/);
        assert.equal(sourceLoads, deferredSource ? 1 : 0);
        assert.equal(exclusionLoads, deferredExclusion ? 1 : 0);
      } finally {
        await app.stop();
      }
    }
  }
});

test("disabled immediate and deferred modules exclude private references before consumer construction", async () => {
  for (const deferred of [false, true]) {
    let constructed = 0;
    const dependency = unit({
      factory: () => {
        constructed++;
        return 42;
      },
    });
    const consumer = unit({ requirements: { dependency }, factory: ({ dependency }) => dependency });
    const source = deferred
      ? composeModule({ sources: [() => Promise.resolve({ dependency })], accepts: isProvider, label: "disabled" })
      : composeModule({ providers: { dependency } });
    const roots = composeModule({ providers: { consumer } });
    await assert.rejects(
      runApplication(defineApplication({ modules: source.when(false).requiredBy(roots) })),
      /excluded|unavailable/,
    );
    assert.equal(constructed, 0);
  }
});

test("canonical activation snapshots module selections and resolves deferred roots once per application", async () => {
  let loads = 0;
  let constructions = 0;
  const root = unit({ factory: () => ++constructions });
  const dormant = unit({
    factory: () => {
      throw new Error("Dependency-only module became a root");
    },
  });
  const dependencies = composeModule({ providers: { dormant } });
  const roots = composeModule({
    sources: [
      () => {
        loads++;
        return Promise.resolve({ root });
      },
    ],
    accepts: isProvider,
    label: "roots",
  }).includeOnly([root]);
  const definitions = [
    defineApplication({ modules: dependencies.requiredBy(roots) }),
    defineApplication({ modules: requiredBy(roots) }),
    defineApplication({ modules: [roots] }),
  ];
  for (const [index, definition] of definitions.entries()) {
    assert.ok(Object.isFrozen(definition.options.modules));
    assert.ok(Object.isFrozen(definition.options.modules.selections));
    assert.ok(Object.isFrozen(definition.options.modules.rootSelections));
    const app = await runApplication(definition);
    try {
      assert.equal(app.resolve(root), index + 1);
      assert.equal(loads, index + 1);
    } finally {
      await app.stop();
    }
  }
});

test("invalid selector roots fail before any lifecycle resources are acquired", async () => {
  let acquired = 0;
  const declared = unit({ factory: () => 1 });
  const outside = unit({ factory: () => 2 });
  const database = resource({
    async initialize() {
      acquired++;
      return { value: 42, release() {} };
    },
  });
  const plain = composeModule({ providers: { declared } });
  assert.throws(() => plain.includeOnly([outside]), /outside/);
  const deferred = composeModule({ sources: [declared], accepts: isProvider, label: "invalid roots" });
  await assert.rejects(
    runApplication(
      defineApplication({
        modules: [deferred.includeOnly([outside]), composeModule({ providers: { database } })],
      }),
    ),
    /outside/,
  );
  assert.equal(acquired, 0);
});

test("definitions listed directly join the application in module order, and only input ports are inputs", async () => {
  const names = collect.contract<string>();
  const first = unit({ provides: names, factory: () => "first" });
  const second = unit({ provides: names, factory: () => "second" });
  const third = unit({ provides: names, factory: () => "third" });
  const listed = unit({ requirements: { names }, factory: ({ names }) => names.join(",") });
  const app = await runApplication(
    defineApplication({ modules: [first, composeModule({ providers: { second } }), third, listed] }),
  );
  try {
    assert.equal(app.resolve(listed), "first,second,third");
  } finally {
    await app.stop();
  }

  assert.throws(
    () =>
      defineApplication({
        // @ts-expect-error A unit is not an input port; layers mark their own.
        inputs: [listed],
      }),
    /accepts input ports, such as exposures and listeners, not a unit/,
  );

  for (const [options, message] of [
    [{ modules: [42] }, /expects modules or definitions/],
    [{ inputs: [null] }, /accepts input ports/],
  ] as const) {
    assert.throws(() => Reflect.apply(defineApplication, undefined, [options]), message);
  }
});
