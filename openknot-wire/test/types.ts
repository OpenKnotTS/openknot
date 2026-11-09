// Compiled by `pnpm check`; intentionally not executed.
import type {
  Application,
  ProviderArguments,
  ProviderDependencies,
  ProviderOptions,
  Resolved,
} from "@openknot-ts/wire";
import { hook, collect, defineApplication, override, resource, unit } from "@openknot-ts/wire";

interface Repository {
  find(id: string): Promise<{ id: string }>;
}
const repository = unit({ factory: (): Repository => ({ find: async (id) => ({ id }) }) });
function createService({ repository }: { repository: Repository }) {
  return { find: repository.find };
}
const roleService = unit({ requirements: { repository }, factory: createService });
const dependencies: ProviderDependencies<typeof roleService> = {
  repository: { find: async (id) => ({ id }) },
};
const args: ProviderArguments<typeof roleService> = [dependencies];
const resolved: Resolved<typeof roleService> = createService(dependencies);
void args;
void resolved;

const typedOptions: ProviderOptions = { lifetime: "scoped" };
unit({ requirements: { repository }, factory: createService, ...typedOptions });
// @ts-expect-error Override values must implement the provider output contract.
override(roleService, { wrong: true });
// @ts-expect-error Dependencies are inferred from their requirement references.
const wrongDependencies: ProviderDependencies<typeof roleService> = { repository: 42 };
void wrongDependencies;
// @ts-expect-error There is exactly one dependency context argument.
const wrongArgs: ProviderArguments<typeof roleService> = [dependencies, "extra"];
void wrongArgs;

unit({
  requirements: { repository },
  factory: (ctx) => {
    void ctx.repository.find("r1");
    // @ts-expect-error Context contains only declared requirements.
    void ctx.undeclared;
    // @ts-expect-error Methods retain their signatures.
    void ctx.repository.find(42);
    return ctx.repository;
  },
});
unit({
  factory: (ctx) => {
    // @ts-expect-error Omitted requirements produce an empty context.
    void ctx.repository;
    return 1;
  },
});
// @ts-expect-error Selecting nonempty requirement types cannot omit the references.
unit<{ repository: typeof repository }>({ factory: () => 1 });
// @ts-expect-error Factories requiring dependencies must declare their references.
unit({ factory: createService });
// @ts-expect-error Requirements accept definitions, not raw values.
unit({ requirements: { value: 42 }, factory: () => 1 });
// @ts-expect-error Provider declarations require an options object with factory.
unit(createService);
const database = resource({
  async initialize() {
    return { value: { connected: true }, release() {} };
  },
});
override(database, { connected: false });
resource({
  async initialize() {
    return { value: 1, release() {} };
  },
  // @ts-expect-error Resources require an owned application or execution scope.
  lifetime: "transient",
});
// @ts-expect-error Resource consumers receive the ready value, not a resource handle.
override(database, { value: { connected: true }, release() {} });
resource({
  requirements: { database },
  async initialize({ database }) {
    const connected: boolean = database.connected;
    return { value: connected, release() {} };
  },
});
hook({
  run(ctx) {
    // @ts-expect-error Omitted requirements stay empty in lifecycle factories too.
    void ctx.database;
  },
});
hook({
  requirements: { repository },
  async run({ repository }) {
    await repository.find("r1");
  },
});
// @ts-expect-error Lifecycle tasks are singleton.
hook({ run() {}, lifetime: "scoped" });
// @ts-expect-error Application tasks accept hooks, not arbitrary units.
defineApplication({ modules: [], startupTasks: [repository] });
// @ts-expect-error An option defineApplication() does not know fails to compile instead of being ignored.
defineApplication({ modules: [], startupTask: [] });
// @ts-expect-error Shutdown tasks accept hooks, not managed resources.
defineApplication({ modules: [], shutdownTasks: [database] });

function checkResolution(app: Application): void {
  const value = app.resolve(roleService);
  void value.find("42");
  // @ts-expect-error Result method input contracts are preserved.
  void value.find(42);
  // @ts-expect-error Interface-only dispatch is not a runtime identity.
  app.resolve<Repository>();
  for (const item of app.resolve(collect.contract<typeof value>())) {
    void item.find("42");
    // @ts-expect-error Collection outputs preserve member contracts.
    void item.missing();
  }
  const ready: boolean = app.resolve(database).connected;
  void ready;
}
void checkResolution;
