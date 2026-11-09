import type { ResolvedPublisher, ResolvedRequirement } from "../src/index.ts";
import { expose, publisher } from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
import { operation, success, updated } from "@openknot-ts/behavior";
import { plug } from "@openknot-ts/wire";
import type { Resolved } from "@openknot-ts/wire";

type Message = { readonly type: "changed"; readonly id: string } | { readonly type: "deleted"; readonly id: string };
const changes = publisher<Message>();
plug({
  port: changes,
  bind: () => (message, options) => {
    const input: Message = message;
    const signal: AbortSignal | undefined = options.signal;
    void input;
    void signal;
  },
});
provideFlow([changes]);
// A plug returns the implementation, typed from the publisher's own contract.
plug({
  port: changes,
  bind: () => (message, options) => {
    const input: Message = message;
    const signal: AbortSignal | undefined = options.signal;
    void input;
    void signal;
  },
});
// @ts-expect-error The publisher retains its authored message type.
plug({ port: changes, bind: () => (_message: number) => {} });
// @ts-expect-error Business operations cannot publish infrastructure messages.
operation({ requirements: { changes }, run: () => success({ output: updated(1) }) });
expose<string>()({
  requirements: { changes },
  run: async (id, ctx) => {
    await ctx.changes.publish({ type: "changed", id }, { signal: ctx.signal });
    // @ts-expect-error Publication keeps literal discriminators.
    await ctx.changes.publish({ type: "unknown", id });
    // @ts-expect-error Publication keeps payload types.
    await ctx.changes.publish({ type: "changed", id: 1 });
    // @ts-expect-error A publisher does not expose client subscriptions.
    void ctx.changes.subscribe;
    return success();
  },
});
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type PublisherTyping = [
  Assert<Equal<ResolvedRequirement<typeof changes>, ResolvedPublisher<Message>>>,
  Assert<Equal<Resolved<typeof changes>, ResolvedPublisher<Message>>>,
];
