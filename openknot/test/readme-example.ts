/** The example shown in the root README, kept compiling so it cannot drift from the API. Each numbered section is one README block. */
import { defineApplication, plug, providePlugs, runApplication } from "@openknot-ts/core";
import { error, failure, model, operation, reader, success, updated } from "@openknot-ts/core/behavior";
import type { Event } from "@openknot-ts/core/behavior";
import { command, expose, guard, publisher, upserted, writer } from "@openknot-ts/core/flow";
import type { Upserted } from "@openknot-ts/core/flow";
import { actorResolver } from "@openknot-ts/core/flow/wire";
import { fastifyHttp, fastifyServer } from "@openknot-ts/fastify-server";
import { trpcAuthentication } from "@openknot-ts/trpc-context/wire";
import { trpcFastify } from "@openknot-ts/trpc-fastify";
import { trpcRouter } from "@openknot-ts/trpc-router";
import { z } from "zod";

// 1. Behavior
const userSchema = z.object({ id: z.string(), name: z.string().min(1), email: z.email() }).readonly();
type UserState = z.infer<typeof userSchema>;

type UserEvent = Event & {
  readonly type: "UserEmailChanged";
  readonly id: string;
  readonly email: string;
};

const User = model({
  invariants: userSchema,
  mutations: {
    changeEmail: (user: UserState, email: string) => success({ ...user, email }),
  },
});

type ChangeEmailInput = { user: UserState; email: string };

const emailExistsReader = reader<(email: string) => Promise<boolean>>();

const EmailAlreadyTaken = error("EmailAlreadyTaken", (email: string) => ({
  message: `Email ${email} is already taken`,
  email,
}));

const changeUserEmailOperation = operation<ChangeEmailInput, UserState, UserEvent>()({
  requirements: { emailExistsReader },
  run: async ({ user, email }, ctx) => {
    if (await ctx.emailExistsReader(email)) {
      return failure(EmailAlreadyTaken(email));
    }

    const changed = User.changeEmail(user, email);

    if (changed.isError) {
      return changed;
    }

    return success({
      output: updated(changed.value),
      events: [{ type: "UserEmailChanged", id: changed.value.id, email }],
    });
  },
});

// 2. Flow: orchestration
type ChangeEmailRequest = { id: string; email: string };

const findUserReader = reader<(id: string) => Promise<UserState | undefined>>();
const saveUserWriter = writer<(user: UserState) => Promise<Upserted<UserState>>>();
const userEventsPublisher = publisher<UserEvent>();

const UserNotFound = error("UserNotFound", (id: string) => ({ message: `User ${id} was not found`, id }));

const changeUserEmailCommand = command<ChangeEmailRequest, UserState>()({
  requirements: { findUserReader, changeUserEmailOperation, saveUserWriter, userEventsPublisher },
  run: async ({ id, email }, ctx) => {
    const user = await ctx.findUserReader(id);

    if (user === undefined) {
      return failure(UserNotFound(id));
    }

    const result = await ctx.changeUserEmailOperation({ user, email });

    if (result.isError) {
      return result;
    }

    const saved = await ctx.saveUserWriter(result.value.output.next);

    for (const event of result.value.events) {
      await ctx.userEventsPublisher.publish(event);
    }

    return success(saved.next);
  },
});

// 3. Flow: exposure
const isAdminReader = reader<(userId: string | undefined) => Promise<boolean>>();
const AccessDenied = error("AccessDenied");

const isAdmin = guard({
  requirements: { isAdminReader },
  run: async (_input, ctx) => ((await ctx.isAdminReader(ctx.actor?.userId)) ? success() : failure(AccessDenied())),
});

const changeEmailEndpoint = expose({ handler: changeUserEmailCommand, guards: { isAdmin } });

const getUserEndpoint = expose<string>()({
  requirements: { findUserReader },
  run: async (id, ctx) => success(await ctx.findUserReader(id)),
});

const userApi = expose.compose({ changeEmailEndpoint, getUserEndpoint });

// 4. Plugs
const usersById = new Map<string, UserState>([["u1", { id: "u1", name: "Ada", email: "ada@example.com" }]]);

const inMemoryUserReaders = plug({
  port: reader.compose({ findUserReader, emailExistsReader, isAdminReader }),
  bind: () => ({
    findUserReader: async (id: string) => usersById.get(id),
    emailExistsReader: async (email: string) => [...usersById.values()].some((user) => user.email === email),
    isAdminReader: async (userId: string | undefined) => userId === "admin",
  }),
});

const inMemoryUserWriter = plug({
  port: saveUserWriter,
  bind: () => async (user: UserState) => {
    usersById.set(user.id, user);
    return upserted(user);
  },
});

const consoleEventsPublisher = plug({
  port: userEventsPublisher,
  bind: () => (event: UserEvent) => {
    console.log(event.type, event.email);
  },
});

const io = providePlugs([inMemoryUserReaders, inMemoryUserWriter, consoleEventsPublisher]);

const tokenActors = actorResolver({
  resolve: (token: string) => (token === "admin-token" ? { userId: "admin" } : undefined),
});

const userRouter = trpcRouter({
  requirements: { authentication: trpcAuthentication, changeEmailEndpoint, getUserEndpoint },
  routes: ({ trpc, authentication, changeEmailEndpoint, getUserEndpoint }) => ({
    changeEmail: trpc.procedure
      .use(authentication)
      .input(z.object({ id: z.string(), email: z.email() }))
      .mutation(changeEmailEndpoint),
    getUser: trpc.procedure.input(z.string()).query(getUserEndpoint),
  }),
});

const transport = providePlugs([tokenActors, userRouter]);

// 5. Application
const app = await runApplication(
  defineApplication({
    inputs: [userApi],
    modules: [io, transport, fastifyHttp, trpcFastify],
  }),
);

console.log(`tRPC on Fastify at ${app.resolve(fastifyServer).url}/trpc`);
