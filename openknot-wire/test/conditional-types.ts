import { optional, resource, unit } from "../src/index.ts";
import type { Resolved } from "../src/index.ts";

const contract = unit.contract<{ readonly id: number }>();
export const binding = unit({ provides: contract, factory: () => ({ id: 42 }) });
export const consumer = unit({
  requirements: { value: optional(contract) },
  factory: ({ value }) => {
    const id: number | undefined = value?.id;
    return id;
  },
});
const result: Resolved<ReturnType<typeof optional<typeof contract>>> = undefined;
void result;
// @ts-expect-error A provided value must satisfy the target contract.
unit({ provides: contract, factory: () => "wrong" });
const managed = resource({ initialize: async () => ({ value: 1, release() {} }) });
// @ts-expect-error Native bindings preserve provider kind.
unit({ provides: managed, factory: () => 1 });
// @ts-expect-error Managed resource bindings preserve their value contract.
resource({ provides: managed, initialize: async () => ({ value: "wrong", release() {} }) });
// @ts-expect-error Optional requirements cannot be nested.
optional(optional(contract));
// @ts-expect-error Conditions require explicit references, not factories.
unit({ whenAvailable: [() => true], factory: () => 1 });
