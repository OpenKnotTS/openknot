import type { Outcome } from "../src/index.ts";
import { operation, reader, success } from "../src/index.ts";
import type { Application, Resolved } from "@openknot-ts/wire";
import { override, unit } from "@openknot-ts/wire";
import "../src/wire.ts";

const find = reader<(id: string) => Promise<number>>();
const read = operation<string>()({
  requirements: { find },
  run: async (id, ctx) => success({ output: { changeType: "updated" as const, next: await ctx.find(id) } }),
});

export async function verifyWireTypes(app: Application): Promise<void> {
  const run: Resolved<typeof read> = app.resolve(read);
  const result: Outcome<{ readonly output: { readonly changeType: "updated"; readonly next: number } }, Error> =
    await run("r1");
  void result;
  // @ts-expect-error operation input remains inferred through the optional bridge
  await run(1);
  // @ts-expect-error readers retain their argument type
  app.resolve(find).run(1);
  // @ts-expect-error unmarked objects are not resolvable definitions
  app.resolve({ name: "unregistered" });
  // @ts-expect-error operation overrides must preserve asynchronous outcome envelopes
  override(read, (id: string) => Number(id));
  // @ts-expect-error reader overrides must preserve the reader signature
  override(find, (id: number) => Promise.resolve(id));
  const boundValue: Promise<number> = app.resolve(find)("r1");
  void boundValue;
  // @ts-expect-error reader resolution preserves its signature
  app.resolve(find)(123);
  const composed = unit({ requirements: { selected: read }, factory: ({ selected }) => selected });
  const numberResult = await app.resolve(composed)("r1");
  if (!numberResult.isError) {
    const output: number = numberResult.value.output.next;
    void output;
    // @ts-expect-error resolved operation output does not widen to unknown/any
    const invalid: string = numberResult.value.output.next;
    void invalid;
  }
}
