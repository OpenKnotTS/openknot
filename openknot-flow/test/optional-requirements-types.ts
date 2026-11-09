import type { ExposureInvoker, ExecutableGuard } from "../src/index.ts";
import { expose, guard, listener, scheduler } from "../src/index.ts";
import type {} from "../src/wire.ts";
import { reader, success } from "@openknot-ts/behavior";
import { plug } from "@openknot-ts/wire";

const access = guard<string>()({
  run: (actor, ctx) => {
    const signal: AbortSignal = ctx.signal;
    // @ts-expect-error Omitted guard requirements add no dependencies.
    void ctx.missing;
    void signal;
    void actor;
    return success();
  },
});
declare const check: ExecutableGuard<string, Error>;
void check("actor");
const port = expose<number>()({
  guards: { access },
  run: (input, ctx) => {
    const signal: AbortSignal = ctx.signal;
    void signal;
    // @ts-expect-error Omitted exposure requirements remain empty.
    void ctx.missing;
    return success(input);
  },
});
declare const invoke: ExposureInvoker<typeof port>;
const pending: Promise<number> = invoke({ input: 42, access: "actor" });
void pending;
// @ts-expect-error Guard inputs stay required and inferred even without requirements.
void invoke({ input: 42 });
// @ts-expect-error Guard input types remain precise.
void invoke({ input: 42, access: 1 });
listener<string>()({
  run: (input, ctx) => {
    const attempt: number | undefined = ctx.trigger.attempt;
    // @ts-expect-error There are no undeclared dependencies.
    void ctx.missing;
    return success({ input, attempt });
  },
});
scheduler({ schedule: { every: { seconds: 1 } }, run: (_input, ctx) => success(ctx.trigger.scheduledAt) });
plug({
  port,
  bind: ({ invoke, signal }) => {
    void invoke({ input: 42, access: "actor", signal });
    // @ts-expect-error Input plug invocations keep their exposure envelope type.
    void invoke({ input: "wrong", access: "actor" });
    return { release() {} };
  },
});
const read = reader<(id: number) => string>();
plug({
  port: read,
  bind: (ctx) => {
    // @ts-expect-error Output adapters have no undeclared dependencies.
    void ctx.missing;
    return (id) => String(id);
  },
});
// @ts-expect-error Omission does not widen an output binding's function signature.
plug({ port: read, bind: () => (id: string) => id });
