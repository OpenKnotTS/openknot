import type { Composition } from "../src/internal/composable.ts";
import { composable } from "../src/internal/composable.ts";

const Marker = Symbol("boxes");
interface BoxDefinition {
  readonly kind: "box";
  readonly value: unknown;
}
function createBox<const Value>(value: Value) {
  return Object.freeze({ kind: "box" as const, value });
}
const box = composable(createBox, {
  name: "box",
  memberName: "box",
  marker: Marker,
  kind: "boxes",
  isMember: (value: unknown): value is BoxDefinition =>
    typeof value === "object" && value !== null && "kind" in value && value.kind === "box",
});
const first = box<string>("first");
const second = box({ id: 2 });
const group = box.compose({ first, second });
const preserved: Composition<typeof Marker, "boxes", { readonly first: typeof first; readonly second: typeof second }> =
  group;
const input: string = preserved.members.first.value;
const literal: 2 = preserved.members.second.value.id;
const marker: true = preserved[Marker];
void input;
void literal;
void marker;
// @ts-expect-error The original factory's explicit type argument still constrains its input.
box<string>(2);
// @ts-expect-error Original member contracts survive grouping.
const wrong: number = group.members.first.value;
void wrong;
// @ts-expect-error The grouping predicate constrains composition members.
box.compose({ invalid: { kind: "different", value: 1 } });
// @ts-expect-error Generic composition snapshots are readonly objects.
group.members.first = first;
