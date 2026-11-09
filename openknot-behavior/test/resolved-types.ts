import type { ResolvedRequirement } from "../src/index.ts";
import { operation, reader, success } from "../src/index.ts";
import type { BehaviorResolved } from "../src/wire.ts";
import type { Resolved, Application } from "@openknot-ts/wire";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
const lookup = reader<(id: string, options?: { readonly cached: boolean }) => Promise<number>>();
const run = operation<string>()({
  requirements: { lookup },
  run: async (id, ctx) => success({ output: { changeType: "updated" as const, next: await ctx.lookup(id) } }),
});
const identity = reader<<const Value>(value: Value) => Value>();

export type BehaviorMappings = [
  Assert<Equal<ResolvedRequirement<typeof lookup>, BehaviorResolved<typeof lookup>>>,
  Assert<Equal<ResolvedRequirement<typeof run>, BehaviorResolved<typeof run>>>,
  Assert<Equal<Resolved<typeof lookup>, BehaviorResolved<typeof lookup>>>,
  Assert<Equal<Resolved<typeof run>, BehaviorResolved<typeof run>>>,
];

export function verifyGenericBinding(app: Application): void {
  const literal: "value" = app.resolve(identity)("value");
  const tuple: readonly [1, "two"] = app.resolve(identity)([1, "two"]);
  void literal;
  void tuple;
  // @ts-expect-error Resolved generic reader implementations keep literal return types.
  const wrong: "other" = app.resolve(identity).run("value");
  void wrong;
}
