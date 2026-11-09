import type { HandlerInput, HandlerOutput, HandlerErrors } from "../src/index.ts";
import { command, expose, guard, hook, listener, query } from "../src/index.ts";
import { error, failure, reader, success } from "@openknot-ts/behavior";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
const read = reader<(id: string) => number>();
const lookup = query<string>()({ requirements: { read }, run: (id, ctx) => success(ctx.read(id)) });
const action = command<string>()({
  requirements: { query: lookup },
  run: (id, ctx) => {
    // @ts-expect-error Handler input remains explicit and typed without wire.
    ctx.query.run(42);
    return ctx.query(id);
  },
});
expose<string>()({
  requirements: { command: action },
  run: (input, ctx) => {
    // @ts-expect-error A resolved handler is called directly; it has no run() method.
    void ctx.command.run;
    return ctx.command(input);
  },
});
export type Contract = [HandlerInput<typeof action>, HandlerOutput<typeof lookup>, HandlerErrors<typeof lookup>];

const Missing = error("Missing");
const declared = command<string, number>()({
  requirements: { read },
  run: (id, ctx) => (id === "" ? failure(Missing()) : success(ctx.read(id))),
});
export type DeclaredContract = [
  Assert<Equal<HandlerInput<typeof declared>, string>>,
  Assert<Equal<HandlerOutput<typeof declared>, number>>,
  Assert<Equal<HandlerErrors<typeof declared>, ReturnType<typeof Missing>>>,
];
// @ts-expect-error A declared output restricts the result.
command<string, number>()({ run: () => success("text") });
// @ts-expect-error A declared output restricts the result of a guarded exposure too.
expose<string, number>()({ guards: {}, run: () => success("text") });

const inferred = query<string>()({ run: (id) => success(id.length) });
const plain = query({ requirements: { read }, run: (_, ctx) => success(ctx.read("id")) });
export type InferredContract = [
  Assert<Equal<HandlerOutput<typeof inferred>, number>>,
  Assert<Equal<HandlerInput<typeof plain>, void>>,
];

// @ts-expect-error A plain call takes no input: a declared input goes on the head.
command({ run: (id: string) => success(id) });
// @ts-expect-error A plain call takes no input: a declared input goes on the head.
query({ run: (id: string) => success(id) });
// @ts-expect-error A plain call takes no input: a declared input goes on the head.
guard({ run: (_id: string) => success() });
// @ts-expect-error A plain call takes no input: a declared input goes on the head.
hook({ run: (_id: string) => success() });
// @ts-expect-error A plain call takes no input: a declared input goes on the head.
listener({ run: (id: string) => success(id) });
// @ts-expect-error A plain call takes no input: a declared input goes on the head.
expose({ run: (id: string) => success(id) });
// @ts-expect-error The empty call carries the declared types, so leaving it out does not compile.
command<string, number>({ run: (id: string) => success(id.length) });
