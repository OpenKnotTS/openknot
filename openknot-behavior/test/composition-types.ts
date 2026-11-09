import { model, operation, reader, success } from "../src/index.ts";
import { provideBehavior } from "../src/wire.ts";
import type { Application } from "@openknot-ts/wire";
import { defineApplication, composeModule, hook, resource, unit } from "@openknot-ts/wire";

const find = reader<(id: string) => number>();
const setting = unit({ factory: () => 42 });
provideBehavior([setting, { setting }, async () => ({ setting })]);
// @ts-expect-error Resources belong to plug provisions.
provideBehavior([
  resource({
    async initialize() {
      return { value: 1, release() {} };
    },
  }),
]);
// @ts-expect-error Application hooks belong to the container.
provideBehavior([hook({ run() {} })]);
operation({
  // @ts-expect-error Allowing unit provision does not change operation dependencies.
  requirements: { setting },
  run: () => success({ output: { changeType: "unchanged", current: 1 } }),
});
provideBehavior([operation({ run: () => success({ output: { changeType: "updated" as const, next: 1 } }) })]);
// @ts-expect-error Provisions require an array of explicit operation sources.
provideBehavior("./operations");
// @ts-expect-error URL-shaped values are not operation source arrays.
provideBehavior({ href: "file:///operations/" });
// @ts-expect-error Provisions require an array of explicit operation sources.
provideBehavior(42);
const run = operation<string>()({
  requirements: { find },
  run: (id, ctx) => success({ output: { changeType: "updated" as const, next: ctx.find(id) } }),
});
const behavior = provideBehavior([run, { run }, () => import("./fixtures/operations.ts")]);
composeModule({ modules: [behavior, behavior.includeOnly([run]).exclude([find]).when(true)] });
const second = operation<number>()({
  requirements: {},
  run: (value) => success({ output: { changeType: "updated" as const, next: value > 0 } }),
});
const operations = operation.compose({ run, second });
provideBehavior([operations, { operations }, () => import("./fixtures/operation-compositions.ts")]);
// @ts-expect-error Operation compositions contain only operations.
operation.compose({ find });
// @ts-expect-error Operation compositions are flat and contain definitions only.
operation.compose({ operations });
operation({
  // @ts-expect-error A composition is grouping metadata, not an operation requirement.
  requirements: { operations },
  run: () => success({ output: { changeType: "updated" as const, next: 1 } }),
});
// @ts-expect-error Composition members are immutable snapshots.
operations.members.run = run;
defineApplication({
  modules: [behavior.includeOnly([run]), composeModule({ modules: [behavior] })],
});
// @ts-expect-error Reader contracts are discovered from requirements, never public behavior entries.
provideBehavior([find]);
// @ts-expect-error Namespace exports must also contain operations only.
provideBehavior([{ find }]);
// @ts-expect-error Imported namespaces must contain operations only.
provideBehavior([() => import("./fixtures/contracts.ts")]);
// @ts-expect-error Pure models use ordinary imports rather than DI provision.
provideBehavior([model<unknown>()({ name: "example", mutations: {} })]);
// @ts-expect-error Sources must be definitions, namespaces or import loaders.
provideBehavior(["./operations.ts"]);
export async function inferredWithoutBridgeImport(app: Application): Promise<void> {
  await app.withScope(async (scope) => {
    const grouped = await scope.resolve(operations.members.run)("r1");
    if (!grouped.isError) {
      const count: number = grouped.value.output.next;
      void count;
    }
    const another = await scope.resolve(operations.members.second)(1);
    if (!another.isError) {
      const positive: boolean = another.value.output.next;
      void positive;
    }
    // @ts-expect-error Composition members retain their own input types.
    await scope.resolve(operations.members.run)(1);
    // @ts-expect-error The composition itself is not a separately resolved dependency.
    scope.resolve(operations);
    const result = await scope.resolve(run)("r1");
    if (!result.isError) {
      const count: number = result.value.output.next;
      void count;
      // @ts-expect-error Operation output stays inferred through automatic integration.
      const wrong: string = result.value.output.next;
      void wrong;
    }
    // @ts-expect-error Operation inputs remain checked.
    await scope.resolve(run)(1);
    // @ts-expect-error Reader inputs remain checked.
    scope.resolve(find).run(1);
  });
}
