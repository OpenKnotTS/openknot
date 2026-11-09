import {
  broadcast,
  command,
  defaultUnitOfWork,
  expose,
  guard,
  hook,
  listener,
  publisher,
  query,
  scheduler,
  topic,
  unitOfWork,
  writer,
} from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
import { operation, reader, success } from "@openknot-ts/behavior";
import type { Application } from "@openknot-ts/wire";
import {
  plug,
  hook as applicationHook,
  collect,
  defineApplication,
  composeModule,
  resource,
  unit,
} from "@openknot-ts/wire";

const find = reader<() => number>();
provideFlow([
  expose({ run: () => success(1) }),
  listener({ run: () => success(1) }),
  scheduler({ schedule: { every: { seconds: 1 } }, run: () => success(1) }),
  topic<string, number>()({}),
  broadcast<number>()({}),
  publisher<number>(),
  unit({ factory: () => 1 }),
]);
// @ts-expect-error Provisions require an array of explicit port sources.
provideFlow("./ports");
// @ts-expect-error URL-shaped values are not port source arrays.
provideFlow({ href: "file:///ports/" });
// @ts-expect-error Provisions require an array of explicit port sources.
provideFlow(42);
const save = writer<(id: string) => Promise<void>>();
const onNumber = listener<string>()({
  requirements: { find },
  run: (input, ctx) => success(input.length + ctx.find()),
});
const ports = provideFlow([find, writer.compose({ save }), { onNumber }, () => import("./fixtures/ports.ts")]);
defineApplication({ modules: [ports, ports.includeOnly([onNumber]).exclude([find]).when(true)] });
composeModule({ modules: [ports] }).exclude([ports]);
const run = operation({
  requirements: {},
  run: () => success({ output: { changeType: "updated" as const, next: 1 } }),
});
const data = plug({
  port: find,
  requirements: {},
  bind: () => () => 1,
});
// @ts-expect-error Flows expose ports, not behavior operations.
provideFlow([run]);
// @ts-expect-error Operation compositions remain behavior entries, not flow ports.
provideFlow([operation.compose({ run })]);
// @ts-expect-error Infrastructure adapters are implementations, not public ports.
provideFlow([data]);
// @ts-expect-error Bindings belong in infrastructure.
provideFlow([plug({ port: find, bind: () => () => 1 })]);
const count = unit({ factory: () => 1 });
const doubled = unit({ lifetime: "scoped", requirements: { count }, factory: ({ count }) => count * 2 });
provideFlow([count, { doubled }, async () => ({ count, doubled })]);
const action = command<number>()({ run: (input) => success(input) });
const lookup = query({ run: () => success(1) });
const access = guard({ run: () => success() });
const committed = hook({ run: () => success() });
const transaction = unitOfWork();
// @ts-expect-error Commands are internal requirements, not provision roots.
provideFlow([action]);
// @ts-expect-error Queries are internal requirements, not provision roots.
provideFlow([lookup]);
// @ts-expect-error Guards are internal policies, not provision roots.
provideFlow([access]);
// @ts-expect-error Hooks are internal policies, not provision roots.
provideFlow([committed]);
// @ts-expect-error UoW is supplied by data access, not exported as a Flow port.
provideFlow([transaction]);
// @ts-expect-error The internal default UoW is not a provision root either.
provideFlow([defaultUnitOfWork]);
// @ts-expect-error Namespace exports follow the same provision boundary.
provideFlow([{ command: action }]);
// @ts-expect-error Import loaders cannot expose internal handlers either.
provideFlow([async () => ({ query: lookup })]);
// @ts-expect-error Resources belong to infrastructure.
provideFlow([
  resource({
    async initialize() {
      return { value: 1, release() {} };
    },
  }),
]);
// @ts-expect-error Application hooks belong to the container.
provideFlow([applicationHook({ run() {} })]);
// @ts-expect-error Allowing units does not allow other native provider kinds.
provideFlow([collect.contract<number>()]);
// @ts-expect-error Native import exports are checked as well.
provideFlow([async () => ({ data })]);
export async function inferAutomaticPorts(app: Application): Promise<void> {
  const value: number = await app.resolve(onNumber)({ input: "r1" });
  void value;
  // @ts-expect-error Input envelopes retain the port's argument type.
  await app.resolve(onNumber)({ input: 1 });
  await app.withScope(async (scope) => {
    await scope.resolve(save)("r1");
    // @ts-expect-error Writers retain their bound function signature.
    await scope.resolve(save).run(1);
  });
}
