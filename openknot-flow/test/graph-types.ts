import { command, expose, listener, publisher, writer } from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
// Compiled by `pnpm check`; intentionally not executed.
import { operation, reader, success } from "@openknot-ts/behavior";
import {
  composeModule,
  decorate,
  defineApplication,
  resource,
  override,
  plug,
  providePlugs,
  runApplication,
  unit,
} from "@openknot-ts/wire";
import type { Provider } from "@openknot-ts/wire";

const find = reader<(id: string) => string>();
const save = writer<(name: string) => void>();
const changes = publisher<string>();
const audit = reader<() => number>();
const check = operation<string>()({
  requirements: { find },
  run: (id, ctx) => success({ output: { changeType: "updated" as const, next: ctx.find(id) } }),
});
const store = command({ requirements: { check, save, changes }, run: () => success() });
const api = expose({ handler: store });
const onAudit = listener({ requirements: { audit }, run: () => success() });
const flow = provideFlow([api, onAudit]);

const readers = providePlugs([plug({ port: find, bind: () => (id) => id })]);
const writers = providePlugs([
  plug({ port: writer.compose({ save }), bind: () => ({ save: () => {} }) }),
  plug({ port: changes, bind: () => () => {} }),
]);
const auditing = composeModule({ providers: { binding: plug({ port: audit, bind: () => () => 1 }) } });

// Every contract is implemented.
void runApplication(defineApplication({ modules: [flow, readers, writers, auditing] }));
// @ts-expect-error The publisher and the writers' module are missing.
void runApplication(defineApplication({ modules: [flow, readers, auditing] }));
// includeOnly checks only the selected roots: the listener needs just its reader.
void runApplication(defineApplication({ modules: [flow.includeOnly([onAudit]), auditing] }));
// @ts-expect-error The selected listener still needs its reader.
void runApplication(defineApplication({ modules: [flow.includeOnly([onAudit])] }));
// Overrides implement the contracts they target.
void runApplication(defineApplication({ modules: [flow, writers, auditing] }), {
  overrides: [override(find, (id) => id)],
});
// @ts-expect-error Excluding a binding module's contract leaves it unbound.
void runApplication(defineApplication({ modules: [flow, readers.exclude([find]), writers, auditing] }));
// @ts-expect-error A disabled module implements nothing.
void runApplication(defineApplication({ modules: [flow, readers.when(false), writers, auditing] }));
const cache = reader<() => Map<string, string>>();
const cached = decorate(find, {
  requirements: { cache },
  wrap:
    (inner, { cache }) =>
    (id) =>
      cache().get(id) ?? inner(id),
});
void runApplication(
  // @ts-expect-error A decoration's requirements are needs as well.
  defineApplication({ modules: [flow, readers, writers, auditing, composeModule({ providers: { cached } })] }),
);

// Needs are followed however deep the graph goes: this reader sits ten requirement levels down.
const level1 = unit({ requirements: { find }, factory: ({ find }) => find });
const level2 = unit({ requirements: { level1 }, factory: ({ level1 }) => level1 });
const level3 = unit({ requirements: { level2 }, factory: ({ level2 }) => level2 });
const level4 = unit({ requirements: { level3 }, factory: ({ level3 }) => level3 });
const level5 = unit({ requirements: { level4 }, factory: ({ level4 }) => level4 });
const level6 = unit({ requirements: { level5 }, factory: ({ level5 }) => level5 });
const level7 = unit({ requirements: { level6 }, factory: ({ level6 }) => level6 });
const level8 = unit({ requirements: { level7 }, factory: ({ level7 }) => level7 });
const level9 = unit({ requirements: { level8 }, factory: ({ level8 }) => level8 });
const level10 = unit({ requirements: { level9 }, factory: ({ level9 }) => level9 });
// @ts-expect-error The reader ten levels down has no implementation.
void runApplication(defineApplication({ modules: [composeModule({ providers: { level10 } })] }));
void runApplication(defineApplication({ modules: [composeModule({ providers: { level10 } }), readers] }));
// A declared type that requires itself still terminates and reports its reader.
interface Loop extends Provider<number, never, "unit", { readonly find: typeof find; readonly next: Loop }> {}
declare const loop: Loop;
// @ts-expect-error The self-requiring definition still needs its reader.
void runApplication(defineApplication({ modules: [composeModule({ providers: { loop } })] }));
// A resource's requirements are needs like any other provider's, and plug packages provide resources.
const server = resource({
  requirements: { find },
  initialize: async ({ find }) => ({ value: { port: find("port") }, release() {} }),
});
const host = providePlugs([server]);
// @ts-expect-error The resource's reader has no implementation.
void runApplication(defineApplication({ modules: [host] }));
void runApplication(defineApplication({ modules: [host, readers] }));
