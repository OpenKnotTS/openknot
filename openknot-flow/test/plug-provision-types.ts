import { defaultUnitOfWork, expose, hook as executionHook, listener, writer } from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
import { reader, operation, success } from "@openknot-ts/behavior";
import { plug, collect, composeModule, defineApplication, hook, providePlugs, resource, unit } from "@openknot-ts/wire";

const read = reader<() => number>();
const save = writer<(value: number) => void>();
const input = listener<number>()({ run: (input) => success(input) });
const config = unit({ factory: () => 42 });
const database = resource({
  requirements: { config },
  async initialize({ config }) {
    return { value: config, release() {} };
  },
});
const output = plug({
  port: read,
  requirements: { database },
  bind:
    ({ database }) =>
    () =>
      database,
});
const saving = plug({
  port: save,
  bind: () => (value) => {
    const checked: number = value;
    void checked;
  },
});
const transaction = plug({
  port: defaultUnitOfWork,
  bind: () => ({ transaction: (work) => work() }),
});
const source = plug({ port: input, bind: () => ({ release() {} }) });
providePlugs([plug({ port: listener<string>()({ run: (input) => success(input) }), bind: () => ({ release() {} }) })]);
const provided = providePlugs([
  output,
  saving,
  transaction,
  source,
  config,
  database,
  { output },
  async () => ({ source }),
]);
composeModule({ modules: [provided.includeOnly([config]), provided.exclude([source]).when(true)] });
// @ts-expect-error Flow contracts are not plug implementations.
providePlugs([read]);
// @ts-expect-error Flow input contracts are not plug implementations.
providePlugs([input]);
// @ts-expect-error UoW implementation is provided through its plug.
providePlugs([defaultUnitOfWork]);
// @ts-expect-error Application hooks belong to the container.
providePlugs([hook({ run() {} })]);
// @ts-expect-error Collections are not units or resources.
providePlugs([collect.contract<number>()]);
// @ts-expect-error Native import loaders follow the same provision boundary.
providePlugs([async () => ({ invalid: expose({ run: () => success() }) })]);
// @ts-expect-error Plugs cannot provide behavior operations.
providePlugs([operation({ run: () => success({ output: { changeType: "unchanged", current: 1 } }) })]);
// @ts-expect-error Plug provisions cannot be composed as Flow provisions.
provideFlow([provided]);
// @ts-expect-error Application hooks do not use the Flow execution/Outcome contract.
defineApplication({ modules: [], startupTasks: [executionHook({ run: () => success() })] });
