import type {
  FlowExecutionError,
  ExecutableGuard,
  ExposureRequest,
  GuardErrors,
  GuardInputs,
  InputInvoker,
  ResolvedRequirement,
} from "../src/index.ts";
import { expose, guard, listener } from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
import type { Outcome } from "@openknot-ts/behavior";
import { error, failure, reader, success } from "@openknot-ts/behavior";
import type { Application } from "@openknot-ts/wire";
import { plug, defineApplication, composeModule, override, unit } from "@openknot-ts/wire";

const AccessDenied = error("AccessDenied");
type AccessDenied = ReturnType<typeof AccessDenied>;
const OrganizationDenied = error("OrganizationDenied");
type OrganizationDenied = ReturnType<typeof OrganizationDenied>;
const InvalidRole = error("InvalidRole");
type InvalidRole = ReturnType<typeof InvalidRole>;
const hasPermission = reader<(actorId: string) => Promise<boolean>>();
const session = unit({ factory: () => ({ locale: "en" }), lifetime: "scoped" });
const permissions = guard<{ readonly actorId: string }>()({
  requirements: { hasPermission },
  run: async (input, ctx) => {
    const signal: AbortSignal = ctx.signal;
    void signal;
    // @ts-expect-error Guard context contains declared requirements and signal only.
    void ctx.trigger;
    // @ts-expect-error Unlisted dependencies are unavailable in context.
    void ctx.session;
    return (await ctx.hasPermission(input.actorId)) ? success() : failure(AccessDenied());
  },
});
const organization = guard<{ readonly organizationId: number }>()({
  requirements: {},
  run: (input) => (input.organizationId > 0 ? success() : failure(OrganizationDenied())),
});
const port = expose<{ readonly roleId: string }>()({
  requirements: { session },
  guards: { permissions, organization },
  run: (input, ctx) => {
    const locale: string = ctx.session.locale;
    const signal: AbortSignal = ctx.signal;
    void signal;
    // @ts-expect-error Exposure context has no internal delivery metadata.
    void ctx.trigger;
    // @ts-expect-error Guard inputs are separate from business requirements.
    void ctx.permissions;
    return input.roleId.length > 0 ? success({ roleId: input.roleId, locale }) : failure(InvalidRole());
  },
});
const request: ExposureRequest<{ readonly roleId: string }, typeof port.guards> = {
  input: { roleId: "r1" },
  permissions: { actorId: "u1" },
  organization: { organizationId: 1 },
};
const inputs: GuardInputs<typeof port.guards> = request;
const denied: GuardErrors<typeof port.guards> = AccessDenied();
void denied;
void inputs;
// @ts-expect-error Guard error unions retain their specific error classes.
const unrelated: GuardErrors<typeof port.guards> = InvalidRole();
void unrelated;
const ports = provideFlow([expose.compose({ port }), () => import("./fixtures/exposures.ts")]);
defineApplication({
  modules: [
    ports,
    composeModule({ providers: { binding: plug({ port: hasPermission, bind: () => () => Promise.resolve(true) }) } }),
  ],
});
// @ts-expect-error Guards are helpers, not public flow ports.
provideFlow([permissions]);
// @ts-expect-error Exposure guards must be declared with guard(), not reader().
expose({ requirements: {}, guards: { hasPermission }, run: () => success() });
const publicPort = expose<string>()({
  requirements: { session },
  run: (id, ctx) => success({ id, locale: ctx.session.locale }),
});
const readerPort = expose({ handler: hasPermission });
const listedRoles = reader<() => Promise<readonly string[]>>();
const listedRolesPort = expose({ handler: listedRoles, guards: { access: permissions } });
// @ts-expect-error An exposed reader takes the exposure's one input.
expose({ handler: reader<(id: string, locale: string) => string>() });
const emptyGuardsPort = expose<number>()({ requirements: {}, guards: {}, run: (value) => success(value) });
const reusedGuardPort = expose<number>()({
  requirements: {},
  guards: { access: permissions },
  run: (id) => success(id),
});
// @ts-expect-error Input is reserved by the shared guardable request contract.
expose({ guards: { input: permissions }, run: () => success() });
// @ts-expect-error Guard input mappers are not part of the declaration contract.
expose({ guards: { permissions }, guardInputs: () => ({}), run: () => success() });
// @ts-expect-error Guards are named rather than positional.
expose({ requirements: {}, guards: [permissions], run: () => success() });
// @ts-expect-error Guards check access and do not transform data.
guard({ requirements: {}, run: () => success("not-a-check") });
// @ts-expect-error Guard execution returns Outcome, not boolean.
guard({ requirements: {}, run: () => true });
// @ts-expect-error An exposure composition contains exposures only.
expose.compose({ invalid: listener({ requirements: {}, run: () => success() }) });
const mutableMembers = { port };
const composition = expose.compose(mutableMembers);
// @ts-expect-error Composition members are immutable snapshots.
composition.members.port = port;
const wrongInput: GuardInputs<typeof port.guards> = {
  // @ts-expect-error Compositions preserve each original exposure's contract.
  permissions: { actorId: 1 },
  organization: { organizationId: 1 },
};
void wrongInput;

plug({
  port,
  requirements: {},
  bind: async ({ invoke, port: definition }) => {
    const requestGuards: typeof port.guards = definition.guards;
    void requestGuards;
    await invoke(request);
    // @ts-expect-error Named guard inputs belong at the top level, without an envelope.
    await invoke({ input: request.input, guards: request });
    // @ts-expect-error The exposure plug must supply all named guard inputs.
    await invoke({ input: { roleId: "r1" }, permissions: { actorId: "u1" } });
    return { release() {} };
  },
});
export async function verifyExposureTypes(app: Application): Promise<void> {
  const invoke: InputInvoker<typeof port> = app.resolve(port);
  // A plug receives the value; failures, typed only inside Flow, reject.
  const result: { roleId: string; locale: string } = await invoke(request);
  const roleId: string = result.roleId;
  void roleId;
  // @ts-expect-error Business input types are preserved.
  await invoke({ ...request, input: { roleId: 1 } });
  // @ts-expect-error Calls require every named guard input.
  await invoke({ input: request.input });
  // @ts-expect-error Missing one guard input is not valid.
  await invoke({ input: request.input, permissions: { actorId: "u1" } });
  // @ts-expect-error Guard inputs cannot be swapped or merged with business input.
  await invoke({ input: request.input, permissions: { organizationId: 1 }, organization: { actorId: "u1" } });
  // @ts-expect-error Unknown guard names are rejected on fresh literals.
  await invoke({ input: request.input, ...request, unknown: undefined });
  await app.withScope(async (scope) => {
    const check: ResolvedRequirement<typeof permissions> = scope.resolve(permissions);
    const run: ExecutableGuard<{ readonly actorId: string }, AccessDenied> = check;
    const checked: Outcome<void, AccessDenied | FlowExecutionError> = await run(
      { actorId: "u1" },
      { signal: new AbortController().signal },
    );
    void checked;
    // @ts-expect-error Guard input types survive DI resolution.
    await check({ actorId: 1 });
    // @ts-expect-error Guard callers cannot inject the guard's dependencies.
    await check({ actorId: "u1" }, { hasPermission: true });
  });
}

const guardConsumer = unit({
  requirements: { permissions },
  factory: ({ permissions }) => permissions,
  lifetime: "scoped",
});
void guardConsumer;
override(permissions, () => Promise.resolve(success()));
// @ts-expect-error Guard overrides must retain the input contract.
override(permissions, (_input: { readonly actorId: number }) => Promise.resolve(success()));
// @ts-expect-error Guard overrides must return an Outcome promise.
override(permissions, () => true);

export async function verifyOptionalGuardTypes(app: Application): Promise<void> {
  const result = await app.resolve(publicPort)({ input: "r1" });
  const id: string = result.id;
  const locale: string = result.locale;
  void id;
  void locale;
  await app.resolve(publicPort)({ input: "r1" });
  await app.resolve(emptyGuardsPort)({ input: 2 });
  const permitted: boolean = await app.resolve(readerPort)({ input: "u1" });
  const roles: readonly string[] = await app.resolve(listedRolesPort)({
    input: undefined,
    access: { actorId: "u1" },
  });
  void permitted;
  void roles;
  // @ts-expect-error An exposed reader keeps its parameter as the input type.
  await app.resolve(readerPort)({ input: 1 });
  await app.resolve(reusedGuardPort)({ input: 2, access: { actorId: "u1" } });
  // @ts-expect-error Omitting guards does not erase business input types.
  await app.resolve(publicPort)({ input: 2 });
  // @ts-expect-error Public ports do not accept inputs for undeclared guards.
  await app.resolve(publicPort)({ input: "r1", access: undefined });
  // @ts-expect-error Reused guard definitions preserve their own input types.
  await app.resolve(reusedGuardPort)({ input: 2, access: { actorId: 1 } });
  // @ts-expect-error A port with declared guards still requires its guard input envelope.
  await app.resolve(reusedGuardPort)({ input: 2 });
}
