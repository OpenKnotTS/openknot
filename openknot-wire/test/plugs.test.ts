import type { DefinitionAdapter, Plug, Requirements, RequirementsOptions, ResolvedReferences } from "@openknot-ts/wire";
import {
  DefinitionIntegrationMarker,
  defineApplication,
  hook,
  isPlug,
  override,
  plug,
  providePlugs,
  runApplication,
  unit,
} from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

interface TestPort {
  readonly testPort: true;
}
declare module "@openknot-ts/wire" {
  interface PlugFactory {
    <const P extends TestPort, const R extends Requirements = {}>(
      options: RequirementsOptions<R> & {
        readonly port: P;
        readonly bind: (ctx: ResolvedReferences<R> & { readonly port: NoInfer<P> }) => number;
      },
    ): Plug<P, R>;
  }
  interface DefinitionResults<_D> {
    readonly testPlug: _D extends Plug<infer P, infer _R> ? (P extends TestPort ? number : never) : never;
  }
}

test("Wire discovers a plug's native port integration and requirements without a layer dependency", async () => {
  let loads = 0,
    constructions = 0,
    reads = 0;
  const source = unit({ factory: () => 1 });
  const port = Object.freeze({
    testPort: true as const,
    [DefinitionIntegrationMarker]: {
      name: "test:plug",
      references: [],
      async load(): Promise<DefinitionAdapter> {
        loads++;
        return {
          name: "test:plug",
          adapt(definition) {
            if (!isPlug(definition) || definition.port !== port) {
              return undefined;
            }
            return {
              reference: definition,
              provider: unit({
                lifetime: "scoped",
                requirements: definition.requirements,
                factory: (dependencies) => {
                  constructions++;
                  return definition.bind(Object.freeze({ ...dependencies, port }) as never);
                },
              }),
            };
          },
        };
      },
    },
  });
  const binding = plug({
    port,
    requirements: {
      get source() {
        reads++;
        return source;
      },
    },
    bind: (ctx) => {
      assert.ok(Object.isFrozen(ctx));
      assert.equal(ctx.port, port);
      return ctx.source;
    },
  });
  assert.equal(reads, 1);
  assert.ok(isPlug(binding));
  assert.ok(Object.isFrozen(binding.requirements));
  const app = await runApplication(defineApplication({ modules: [providePlugs([binding])] }), {
    overrides: [override(source, 42)],
  });
  try {
    assert.equal(loads, 1);
    assert.equal(constructions, 0);
    await app.withScope((scope) => {
      const result: number = scope.resolve(binding);
      assert.equal(result, 42);
      assert.equal(scope.resolve(binding), result);
    });
    assert.equal(constructions, 1);
  } finally {
    await app.stop();
  }
});

test("generic plug declarations preserve one port reference and reject missing integrations before acquisition", async () => {
  const port = { testPort: true as const };
  let portReads = 0;
  const binding = Reflect.apply(plug, undefined, [
    {
      get port() {
        portReads++;
        return port;
      },
      bind: () => [],
    },
  ]) as Plug;
  assert.equal(portReads, 1);
  assert.equal(binding.port, port);
  assert.ok(Object.isFrozen(binding));
  for (const invalid of [[], [port], [port, port], [[port]], null, "port"]) {
    assert.throws(() => Reflect.apply(plug, undefined, [{ port: invalid, bind: () => [] }]), /port/);
  }
  for (const requirements of [null, [], 42, { dependency: 42 }]) {
    assert.throws(
      () => Reflect.apply(plug, undefined, [{ port, requirements, bind: () => 1 }]),
      /Requirements|reference/,
    );
  }
  await assert.rejects(runApplication(defineApplication({ modules: [providePlugs([binding])] })), /integration/);
});

test("a provision names the kind of definition it does not accept", () => {
  assert.throws(
    () => Reflect.apply(providePlugs, undefined, [[hook({ run() {} })]]),
    /providePlugs\(\) does not accept a hook/,
  );
  assert.throws(
    () => Reflect.apply(providePlugs, undefined, [[unit.contract<string>()]]),
    /providePlugs\(\) does not accept a unit contract/,
  );
});
