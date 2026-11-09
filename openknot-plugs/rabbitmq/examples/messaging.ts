import { rabbitTopology } from "../src/index.ts";
import { success } from "@openknot-ts/behavior";
import { command, expose, listener, publisher } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import { defineApplication, providePlugs, runApplication } from "@openknot-ts/wire";

type Greeting = { readonly name: string };

// Flow: a publisher, a listener and an exposure that publishes
const greetings = publisher<Greeting>();

const greet = command<Greeting>()({
  run: (input) => {
    console.log(`Hello, ${input.name}`);
    return success();
  },
});

const received = listener({ handler: greet });

const send = command<Greeting>()({
  requirements: { greetings },
  run: async (input, ctx) => {
    await ctx.greetings.publish(input);
    return success();
  },
});

const sendGreeting = expose<Greeting>()({
  requirements: { send },
  run: (input, ctx) => ctx.send(input),
});

// RabbitMQ: one topology, and a binding for each port
const { rabbitListener, rabbitPublisher } = rabbitTopology({
  exchanges: [{ exchange: "openknot.greetings", type: "topic" }],
  queues: [{ queue: "openknot.greetings" }],
  routes: [{ exchange: "openknot.greetings", routingKey: "greeting.created" }],
  queueBindings: [
    {
      exchange: "openknot.greetings",
      queue: "openknot.greetings",
      routingKey: "greeting.*",
    },
  ],
});

const consuming = rabbitListener(received);
const publishing = rabbitPublisher(greetings);

const app = await runApplication(
  defineApplication({
    modules: [provideFlow([greetings, received, sendGreeting]), providePlugs([publishing, consuming])],
  }),
);

try {
  await app.withScope((scope) => scope.resolve(sendGreeting)({ input: { name: "OpenKnot" } }));
  console.log("Broker confirmed. Listening until Ctrl+C.");

  await app.stopped;
} finally {
  await app.stop();
}
