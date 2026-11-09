import { rabbitmqListener } from "../src/listener/listener.ts";
import { fakeConsumerConnection } from "./consumer-fakes.ts";
import { success } from "@openknot-ts/behavior";
import { command, defaultUnitOfWork, listener, publisher } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import { composeModule, defineApplication, plug, providePlugs, resource, runApplication } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

test("Wire activates the source automatically and drains staged confirms before acknowledging and releasing resources", async () => {
  const consumer = fakeConsumerConnection();
  // A publisher whose sends wait for the confirms this test releases.
  const confirms: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  let closed = 0;
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    sent = Promise.withResolvers<void>();
  const completed: string[] = [];
  let transactions = 0;
  let executionSignal: AbortSignal | undefined;
  const events = publisher<number>();
  const action = command<number>()({
    requirements: { events },
    run: async (input, ctx) => {
      executionSignal = ctx.signal;
      entered.resolve();
      await ctx.events.publish(input);
      assert.equal(confirms.length, 0);
      await release.promise;
      ctx.uow.afterCommit(() => {
        completed.push("effect");
      });
      return success();
    },
  });
  const received = listener<number>()({
    requirements: { command: action },
    run: (input, ctx) => ctx.command(input),
  });
  const sending = resource({
    async initialize() {
      return {
        value: {
          async publish(): Promise<void> {
            assert.deepEqual(completed, ["commit", "effect"]);
            const confirm = Promise.withResolvers<void>();
            confirms.push(confirm);
            sent.resolve();
            await confirm.promise;
          },
        },
        release() {
          closed++;
        },
      };
    },
  });
  const output = plug({
    port: events,
    requirements: { sending },
    bind: ({ sending }) => sending.publish,
  });
  const input = plug({
    port: received,
    bind: (context) =>
      rabbitmqListener(
        {
          connection: consumer,
          consumer: { queue: "q", qos: { prefetchCount: 1 } },
          decode: () => 1,
          failurePolicy: (failure) => {
            throw failure.error;
          },
          onError: (error) => {
            throw error;
          },
        },
        context,
      ),
  });
  const app = await runApplication(
    defineApplication({
      modules: [
        provideFlow([received, events]),
        providePlugs([sending, output, input]),
        composeModule({
          providers: {
            uow: plug({
              port: defaultUnitOfWork,
              bind: () => ({
                transaction: async (work) => {
                  transactions++;
                  const value = await work();
                  completed.push("commit");
                  return value;
                },
              }),
            }),
          },
        }),
      ],
    }),
  );
  try {
    assert.ok(consumer.consumer);
    const work = consumer.consumer.deliver();
    await entered.promise;
    const stopping = app.stop();
    await Promise.resolve();
    assert.equal(executionSignal?.aborted, false);
    assert.deepEqual(consumer.consumer.statuses, []);
    assert.equal(closed, 0);
    release.resolve();
    await sent.promise;
    assert.deepEqual(consumer.consumer.statuses, []);
    confirms[0]!.resolve();
    assert.equal(await work, 0);
    await stopping;
    assert.equal(transactions, 1);
    assert.equal(consumer.consumer.closed, 1);
    assert.equal(closed, 1);
  } finally {
    release.resolve();
    for (const confirm of confirms) {
      confirm.resolve();
    }
    await app.stop();
  }
});
