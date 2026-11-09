import { trpcRouter } from "../src/index.ts";
import { success } from "@openknot-ts/behavior";
import { broadcast, command, expose, guard, query, topic } from "@openknot-ts/flow";
import type {} from "@openknot-ts/flow/wire";
import type { Resolved } from "@openknot-ts/wire";
import { defineApplication, providePlugs, runApplication, unit } from "@openknot-ts/wire";
import type { TRPCClient } from "@trpc/client";
import { initTRPC } from "@trpc/server";

const value = unit.contract<() => string>();
export const basic = trpcRouter({
  requirements: { value },
  routes: ({ trpc, value }) => ({
    name: trpc.procedure
      .input((input: unknown) => String(input))
      .query(({ input, ctx }) => {
        const signal: AbortSignal = ctx.signal;
        void signal;
        // @ts-expect-error Default native context has no tenant field.
        void ctx.tenant;
        return { name: input, value: value() };
      }),
  }),
});
declare const client: TRPCClient<Resolved<typeof basic>>;
const output: Promise<{ name: string; value: string }> = client.name.query("hello");
void output;
// @ts-expect-error Native query and mutation types remain distinct.
void client.name.mutate("hello");
// @ts-expect-error Only declared paths are exposed to the client.
void client.missing.query();
const missing = defineApplication({ modules: [providePlugs([basic])] });
// @ts-expect-error Router helpers preserve transitive native contract requirements.
void runApplication(missing);

const custom = unit({
  factory: () =>
    initTRPC
      .context<{ tenant: string }>()
      .meta<{ audit: boolean }>()
      .create({
        errorFormatter: ({ shape }) => ({ ...shape, data: { ...shape.data, publicCode: "CUSTOM" as const } }),
      }),
});
export const customized = trpcRouter({
  trpc: custom,
  routes: ({ trpc }) => ({
    tenant: trpc.procedure.meta({ audit: true }).query(({ ctx }) => {
      const tenant: string = ctx.tenant;
      // @ts-expect-error Custom context retains its own exact shape.
      void ctx.signal;
      return tenant;
    }),
  }),
});
declare const native: Resolved<typeof customized>;
const code: "CUSTOM" = native._def._config.$types.errorShape.data.publicCode;
void code;
export const composed = trpcRouter.compose({ routers: { basic } });
declare const nested: TRPCClient<Resolved<typeof composed>>;
void nested.basic.name.query("hello");
// @ts-expect-error Named composition preserves its route prefixes.
void nested.name.query("hello");

const saveRole = command<{ readonly id: string }, string>()({ run: ({ id }) => success(id) });
const countRoles = query<void, number>()({ run: () => success(1) });
const access = guard<string>()({ run: () => success() });
const createRole = expose({ handler: saveRole });
const roleCount = expose({ handler: countRoles });
const guardedRole = expose({ handler: saveRole, guards: { access } });
const changes = topic<string, number>()({});
const logs = broadcast<string>()({});
const roleInput = (input: unknown) => input as { readonly id: string };
const otherInput = (input: unknown) => input as { readonly id: number };

export const flowInputs = trpcRouter({
  requirements: { createRole, roleCount, guardedRole, changes, logs, value },
  routes: ({ trpc, createRole, roleCount, guardedRole, changes, logs, value }) => ({
    create: trpc.procedure.input(roleInput).mutation(createRole),
    count: trpc.procedure.query(roleCount),
    guarded: trpc.procedure.input(roleInput).mutation(({ input, ctx }) => guardedRole({ input, ctx, access: "token" })),
    changes: trpc.procedure.input(String).subscription(changes.subscribe),
    logs: trpc.procedure.subscription(logs.subscribe),
    log: trpc.procedure.mutation(() => logs.publish("message")),
    other: trpc.procedure.query(() => value()),
  }),
});
declare const flowClient: TRPCClient<Resolved<typeof flowInputs>>;
const created: Promise<string> = flowClient.create.mutate({ id: "r1" });
const counted: Promise<number> = flowClient.count.query();
void created;
void counted;
// @ts-expect-error The exposure's input type reaches the client.
void flowClient.create.mutate({ id: 1 });

trpcRouter({
  requirements: { createRole, guardedRole },
  routes: ({ trpc, createRole, guardedRole }) => ({
    // @ts-expect-error The schema's type differs from the exposure's input.
    other: trpc.procedure.input(otherInput).mutation(createRole),
    // @ts-expect-error The exposure needs an input the procedure does not declare.
    missing: trpc.procedure.mutation(createRole),
    // @ts-expect-error The procedure does not supply the exposure's named guard input.
    unnamed: trpc.procedure.input(roleInput).mutation(guardedRole),
  }),
});

trpcRouter({
  trpc: custom,
  requirements: { createRole },
  routes: ({ trpc, createRole }) => ({
    // @ts-expect-error A custom context must carry the execution fields a Flow input receives.
    create: trpc.procedure.input(roleInput).mutation(createRole),
  }),
});

// Outside routes, an exposure keeps its own form.
declare const invoker: Resolved<typeof createRole>;
const invoked: Promise<string> = invoker({ input: { id: "r1" } });
void invoked;
