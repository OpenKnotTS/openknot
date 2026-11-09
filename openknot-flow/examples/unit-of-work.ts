import { command, defaultUnitOfWork, hook, publisher, unitOfWork } from "../src/index.ts";
import type { UowCommitted } from "../src/index.ts";
import type {} from "../src/wire.ts";
import { success } from "@openknot-ts/behavior";
import { composeModule, defineApplication, runApplication, plug, unit } from "@openknot-ts/wire";

const events = publisher<string>();

const afterCommit = hook<UowCommitted>()({
  run: () => {
    console.log("afterCommit");
    return success();
  },
});

const databaseUow = unitOfWork({ hooks: { afterCommit: [afterCommit] } });

// The publication waits for the commit; the effect runs after it.
const action = command({
  requirements: { events },
  run: async (_, ctx) => {
    console.log("execute");

    ctx.uow.afterCommit(() => {
      console.log("effect");
    });

    await ctx.events.publish("changed");

    return success();
  },
});

const app = await runApplication(
  defineApplication({
    modules: [
      composeModule({
        providers: {
          command: action,

          // A real database plug supplies its native transaction or session boundary here.
          selection: unit({
            provides: defaultUnitOfWork,
            lifetime: "scoped",
            requirements: { databaseUow },
            factory: ({ databaseUow }) => databaseUow,
          }),

          transaction: plug({
            port: databaseUow,
            bind: () => ({
              async transaction(work) {
                const result = await work();
                console.log("commit");
                return result;
              },
            }),
          }),

          delivery: plug({
            port: events,
            bind: () => (event) => {
              console.log("publish", event);
            },
          }),
        },
      }),
    ],
  }),
);

try {
  console.log(await app.withScope((scope) => scope.resolve(action)()));
} finally {
  await app.stop();
}
