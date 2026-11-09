import { command, expose, query, writer } from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
import { reader, success } from "@openknot-ts/behavior";
import { composeModule, defineApplication, runApplication, plug } from "@openknot-ts/wire";

const readCount = reader<() => number>();
const addCount = writer<(amount: number) => number>();

const current = query({
  requirements: { readCount },
  run: (_, ctx) => success(ctx.readCount()),
});

// A command calls the query it requires, as any resolved handler.
const increment = command<number>()({
  requirements: { addCount, current },
  run: async (amount, ctx) => {
    ctx.addCount(amount);
    return ctx.current();
  },
});

const endpoint = expose<number>()({
  requirements: { increment },
  run: (amount, ctx) => ctx.increment(amount),
});

let count = 0;

const app = await runApplication(
  defineApplication({
    modules: [
      provideFlow([endpoint]),
      composeModule({
        providers: {
          read: plug({ port: readCount, bind: () => () => count }),
          write: plug({ port: addCount, bind: () => (amount) => (count += amount) }),
        },
      }),
    ],
  }),
);

try {
  console.log(await app.resolve(endpoint)({ input: 2, actor: { userId: "example-user" } }));
} finally {
  await app.stop();
}
