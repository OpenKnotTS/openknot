import type { Outcome } from "../src/index.ts";
import { standalone, operation, reader, success } from "../src/index.ts";

const empty = operation<number>()({
  run: (input, ctx) => {
    // @ts-expect-error Omitted requirements produce an empty context.
    void ctx.reader;
    return success({ output: { changeType: "updated" as const, next: input } });
  },
});
const pending: Promise<Outcome<{ readonly output: { readonly changeType: "updated"; readonly next: number } }, Error>> =
  standalone(empty)(1);
void pending;
// @ts-expect-error Input inference survives omitted requirements.
void standalone(empty)("wrong");
const read = reader<() => number>();
// @ts-expect-error Explicit nonempty requirement types must supply their references.
operation<void>()<{ read: typeof read }>({
  run: () => success({ output: { changeType: "updated" as const, next: 1 } }),
});
