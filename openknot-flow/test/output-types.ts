import { listener, writer } from "../src/index.ts";
import { operation, reader, success } from "@openknot-ts/behavior";
import { plug, unit, resource } from "@openknot-ts/wire";
import type { BindPort } from "@openknot-ts/wire/internal/marker";
import "../src/wire.ts";

const find = reader<(id: string) => Promise<{ readonly id: string } | null>>();
const count = reader<() => number>();
const save = writer<(id: string) => Promise<void>>();
const readers = reader.compose({ find, count });
const writers = writer.compose({ save });
const database = resource({
  async initialize() {
    return {
      value: { find: (id: string) => Promise.resolve({ id }), save: (_id: string) => Promise.resolve() },
      release() {},
    };
  },
  lifetime: "scoped",
});
plug({
  port: find,
  requirements: { database },
  bind: ({ database }) => {
    // @ts-expect-error Only declared dependencies are available.
    void database.missing;
    return (id) => database.find(id);
  },
});
const output = plug({
  port: readers,
  requirements: { database },
  bind: ({ database }) => ({ find: (id) => database.find(id), count: () => 1 }),
});
plug({
  port: writers,
  requirements: { database },
  bind: ({ database }) => ({ save: (id) => database.save(id) }),
});
plug({ port: save, bind: () => () => Promise.resolve() });
type ReadBindings = {
  readonly find: ReturnType<(typeof find)[typeof BindPort]>;
  readonly count: ReturnType<(typeof count)[typeof BindPort]>;
};
const consumer = unit({
  requirements: { find, save, output },
  factory: ({ find, save, output }) => {
    const found: Promise<{ readonly id: string } | null> = find("r1");
    const saved: Promise<void> = save("r1");
    const bindings: ReadBindings = output;
    void found;
    void saved;
    return bindings;
  },
  lifetime: "scoped",
});
listener<string>()({
  requirements: { find, save },
  run: async (id, ctx) => {
    const found: { readonly id: string } | null = await ctx.find(id);
    const write: (id: string) => Promise<void> = ctx.save;
    await write(id);
    return success(found);
  },
});
// @ts-expect-error Reader compositions accept only readers.
reader.compose({ find, save });
// @ts-expect-error Writer compositions accept only writers.
writer.compose({ save, find });
// @ts-expect-error Compositions do not wrap other compositions.
reader.compose({ readers });
// @ts-expect-error Compositions require named members.
reader.compose([find, count]);
// @ts-expect-error Wrong implementation parameter.
plug({ port: save, bind: () => (id: number) => Promise.resolve(id) });
// @ts-expect-error Wrong implementation return value.
plug({ port: save, bind: () => () => 42 });
// @ts-expect-error Output bind must return the port's implementation.
plug({ port: find, bind: () => ({ release() {} }) });
// @ts-expect-error Single ports cannot return binding arrays.
plug({ port: find, bind: () => [plug({ port: find, bind: () => (id) => Promise.resolve({ id }) })] });
// @ts-expect-error Output binding factories are synchronous.
plug({ port: find, bind: () => Promise.resolve(plug({ port: find, bind: () => (id) => Promise.resolve({ id }) })) });
// @ts-expect-error The count reader has an incompatible signature with the declared find port.
plug({ port: find, bind: () => () => 1 });
// @ts-expect-error Every named composition member must be implemented.
plug({ port: readers, bind: () => ({ find: (id) => Promise.resolve({ id }) }) });
// @ts-expect-error Composed bindings must retain each member's signature.
plug({ port: readers, bind: () => ({ find: () => 1, count: () => 1 }) });
const plugs = [
  plug({ port: find, bind: () => (id) => Promise.resolve({ id }) }),
  plug({ port: count, bind: () => () => 1 }),
];
plug({
  port: readers,
  // @ts-expect-error Composed ports return named objects, not binding arrays.
  bind: () => plugs,
});
// @ts-expect-error Raw port arrays are not accepted, including homogeneous arrays.
plug({ port: [find, count], bind: () => (id) => Promise.resolve({ id }) });
// @ts-expect-error A single-element array is not a port composition.
plug({ port: [find], bind: () => (id) => Promise.resolve({ id }) });
// @ts-expect-error A namespace is not an explicit port composition.
plug({
  port: { find, count },
  bind: () => ({ find: (id: string) => Promise.resolve({ id }), count: () => 1 }),
});
operation({
  // @ts-expect-error Behavior only accepts reader requirements and child operations.
  requirements: { save },
  run: () => success({ output: { changeType: "updated" as const, next: 1 } }),
});
const input = listener({ run: () => success() });
// @ts-expect-error Input and output ports cannot form a raw port array.
plug({ port: [find, input], bind: () => (id) => Promise.resolve({ id }) });
plug({
  port: count,
  bind: (ctx) => {
    // @ts-expect-error Output factories have no input invoker.
    void ctx.invoke;
    return () => 1;
  },
});
const mutableReaders = { count };
const immutableGroup = reader.compose(mutableReaders);
// @ts-expect-error Composed members are readonly snapshots.
immutableGroup.members.count = count;
const mutableWriters = { save };
const immutableWriters = writer.compose(mutableWriters);
// @ts-expect-error Writer compositions preserve readonly named members.
immutableWriters.members.save = save;
void consumer;
