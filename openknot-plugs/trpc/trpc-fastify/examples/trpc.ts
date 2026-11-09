import { trpcFastify } from "../src/index.ts";
import { success } from "@openknot-ts/behavior";
import { fastifyHttp, fastifyServer } from "@openknot-ts/fastify-server";
import { command, expose } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import { trpcRouter } from "@openknot-ts/trpc-router";
import { defineApplication, providePlugs, runApplication } from "@openknot-ts/wire";

const greet = expose({
  handler: command<{ readonly name: string }, string>()({
    run: (input) => success(`hello ${input.name}`),
  }),
});

const router = trpcRouter({
  requirements: { greet },
  routes: ({ trpc, greet }) => ({
    greet: trpc.procedure.input((value) => value as { name: string }).mutation(greet),
  }),
});

const application = defineApplication({
  modules: [provideFlow([greet]), providePlugs([router]), fastifyHttp, trpcFastify],
});

const app = await runApplication(application);

console.log(`tRPC on Fastify at ${app.resolve(fastifyServer).url}/trpc`);

await app.stopped;
