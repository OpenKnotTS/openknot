import type { ResolvedRequirement } from "../src/index.ts";
import { expose, guard, listener, scheduler, writer } from "../src/index.ts";
import { operation, reader, success } from "@openknot-ts/behavior";
import type { Resolved } from "@openknot-ts/wire";
import { plug, unit } from "@openknot-ts/wire";
import "../src/wire.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
interface ClockContract {
  readonly contract: "clock";
}
declare module "../src/definitions.ts" {
  interface RequirementResults<_D> {
    readonly clock: _D extends ClockContract ? Date : never;
  }
}
const find = reader<(id: string) => Promise<number>>();
const readBinding = plug({ port: find, bind: () => (id) => Promise.resolve(id.length) });
const write = writer<(count: number) => Promise<void>>();
const writeBinding = plug({ port: write, bind: () => () => Promise.resolve() });
const run = operation<string>()({
  requirements: { find },
  run: async (id, ctx) => success({ output: { changeType: "updated" as const, next: await ctx.find(id) } }),
});
const access = guard<string>()({ requirements: {}, run: (_actor) => success() });
const port = expose<string>()({ requirements: { run }, guards: { access }, run: (id, ctx) => ctx.run(id) });
const messages = listener<number>()({ requirements: {}, run: (id) => success(id) });
const tick = scheduler({ requirements: {}, schedule: { every: { seconds: 1 } }, run: () => success() });
const source = plug({ port, requirements: {}, bind: () => ({ release() {} }) });
const output = plug({ port: write, bind: () => () => Promise.resolve() });
const native = unit({ factory: () => 1 });

export type FlowMappings = [
  Assert<Equal<ResolvedRequirement<typeof find>, Resolved<typeof find>>>,
  Assert<Equal<ResolvedRequirement<typeof readBinding>, Resolved<typeof readBinding>>>,
  Assert<Equal<ResolvedRequirement<typeof write>, Resolved<typeof write>>>,
  Assert<Equal<ResolvedRequirement<typeof writeBinding>, Resolved<typeof writeBinding>>>,
  Assert<Equal<ResolvedRequirement<typeof run>, Resolved<typeof run>>>,
  Assert<Equal<ResolvedRequirement<typeof access>, Resolved<typeof access>>>,
  Assert<Equal<ResolvedRequirement<typeof port>, Resolved<typeof port>>>,
  Assert<Equal<ResolvedRequirement<typeof messages>, Resolved<typeof messages>>>,
  Assert<Equal<ResolvedRequirement<typeof tick>, Resolved<typeof tick>>>,
  Assert<Equal<ResolvedRequirement<typeof source>, Resolved<typeof source>>>,
  Assert<Equal<ResolvedRequirement<typeof output>, Resolved<typeof output>>>,
  Assert<Equal<ResolvedRequirement<typeof native>, number>>,
  Assert<Equal<ResolvedRequirement<typeof find | typeof native>, ((id: string) => Promise<number>) | number>>,
  Assert<Equal<ResolvedRequirement<typeof find | ClockContract>, ((id: string) => Promise<number>) | Date>>,
  Assert<Equal<ResolvedRequirement<{ readonly unrecognized: true }>, never>>,
];
