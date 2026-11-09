// Compiled by `pnpm check`; intentionally not executed.
import { composeModule, decorate, defineApplication, providePlugs, unit } from "@openknot-ts/wire";

const add = unit({ factory: () => (a: number, b: number) => a + b });
const label = unit({ factory: () => (value: string) => `#${value}` });
const count = unit({ factory: () => 1 });
const log = unit({ factory: (): string[] => [] });

const added = decorate(add, { wrap: (inner) => (a, b) => inner(a, b) * 2 });
const counted = decorate(count, { requirements: { log }, wrap: (inner, { log }) => inner + log.length });
// @ts-expect-error A decoration keeps its target's resolved type.
decorate(add, { wrap: () => (value: string) => value });
// @ts-expect-error Dependencies are the declared requirements only.
decorate(count, { requirements: { log }, wrap: (inner, { missing }) => inner + missing });
const traced = decorate(label, {
  requirements: { log },
  wrap:
    (inner, { log }) =>
    (value) => {
      log.push(value);
      return inner(value);
    },
});
// @ts-expect-error A wrapper may not change the result its consumers see.
decorate(label, { wrap: () => (value: string) => value.length });
defineApplication({ modules: [composeModule({ providers: { added, counted, traced } }), providePlugs([added])] });
