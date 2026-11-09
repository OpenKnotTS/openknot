import { expose, InternalFlowError, listener, publisher } from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
import { reader, success } from "@openknot-ts/behavior";
import { plug, composeModule, defineApplication, override, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

test("publishers bind independently and deliver through an MQ listener without a client connection", async () => {
  const messages = publisher<{ readonly id: string }>();
  const received: string[] = [];
  const onMessage = listener<{ readonly id: string }>()({
    run: (message, ctx) => {
      received.push(`${ctx.trigger.messageId}:${message.id}`);
      return success();
    },
  });
  let deliver: ((message: { readonly id: string }) => Promise<void>) | undefined;
  const source = plug({
    port: onMessage,
    bind: ({ invoke }) => {
      deliver = async (input) => {
        await invoke({ input, trigger: { messageId: "one", attempt: 1 } });
      };
      return {
        release() {
          deliver = undefined;
        },
      };
    },
  });
  const output = plug({
    port: messages,
    bind: () => async (message) => {
      assert.ok(deliver);
      await deliver(message);
    },
  });
  const app = await runApplication(
    defineApplication({
      modules: [provideFlow([messages, onMessage]), composeModule({ providers: { source, output } })],
    }),
  );
  try {
    assert.throws(() => app.resolve(messages), /withScope/);
    await app.withScope((scope) => scope.resolve(messages).publish({ id: "first" }));
    assert.deepEqual(received, ["one:first"]);
  } finally {
    await app.stop();
  }
  assert.equal(deliver, undefined);
});

test("publishers preserve cancellation, driver failures and application execution boundaries", async () => {
  const messages = publisher<number>();
  const defect = new Error("broker unavailable"),
    cancelled = new Error("cancelled");
  let calls = 0;
  const binding = plug({
    port: messages,
    bind: () => () => {
      calls++;
      throw defect;
    },
  });
  const command = expose<number>()({
    requirements: { messages },
    run: async (message, ctx) => {
      await ctx.messages.publish(message, { signal: ctx.signal });
      return success();
    },
  });
  const app = await runApplication(
    defineApplication({ modules: [provideFlow([command]), composeModule({ providers: { binding } })] }),
  );
  try {
    await app.withScope(async (scope) => {
      await assert.rejects(
        scope.resolve(messages).publish(1, { signal: AbortSignal.abort(cancelled) }),
        (error) => error === cancelled,
      );
      assert.equal(calls, 0);
      await assert.rejects(scope.resolve(messages).publish(1), (error) => error === defect);
    });
    await assert.rejects(
      app.resolve(command)({ input: 1 }),
      (error) => InternalFlowError.is(error) && error.cause === defect,
    );
  } finally {
    await app.stop();
  }
});

test("mixed output plugs share scoped bindings and retain independent reader and publisher overrides", async () => {
  const read = reader<() => number>(),
    messages = publisher<number>();
  let binds = 0;
  const sent: number[] = [];
  const output = {
    read: plug({
      port: read,
      bind: () => {
        binds++;
        return () => 42;
      },
    }),
    messages: plug({
      port: messages,
      bind: () => {
        binds++;
        return (message) => {
          sent.push(message);
        };
      },
    }),
  };
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { ...output } })] }), {
    overrides: [
      override(messages, {
        publishNow: async (message: number) => {
          sent.push(message * 2);
        },
        publish: async (message: number) => {
          sent.push(message * 2);
        },
      }),
    ],
  });
  try {
    await app.withScope(async (scope) => {
      assert.equal(scope.resolve(read)(), 42);
      await scope.resolve(messages).publish(2);
    });
    assert.equal(binds, 1);
    assert.deepEqual(sent, [4]);
  } finally {
    await app.stop();
  }
});

test("publisher output plugs validate identity coverage, conflicts and native lifetime restrictions", async () => {
  const messages = publisher<number>(),
    other = publisher<number>();
  for (const [bindings, error] of [
    [[], /must be a function/],
    [{ publish() {} }, /must be a function/],
    [plug({ port: other, bind: () => () => {} }), /must be a function/],
  ] as const) {
    const output = Reflect.apply(plug, undefined, [{ port: messages, bind: () => bindings }]);
    const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { output } })] }));
    try {
      await assert.rejects(
        app.withScope((scope) => scope.resolve(messages)),
        error,
      );
    } finally {
      await app.stop();
    }
  }
  const first = plug({ port: messages, bind: () => () => {} }),
    second = plug({ port: messages, bind: () => () => {} });
  await assert.rejects(
    runApplication(defineApplication({ modules: [composeModule({ providers: { first, second } })] })),
    /multiple implementations supplied for/,
  );
  const scoped = unit({ lifetime: "scoped", factory: () => 1 });
  const output = plug({
    port: messages,
    requirements: { scoped },
    bind:
      ({ scoped }) =>
      () => {
        void scoped;
      },
  });
  const root = unit({ requirements: { messages }, factory: ({ messages }) => messages });
  await assert.rejects(
    runApplication(defineApplication({ modules: [composeModule({ providers: { output, root } })] })),
    /shorter lifetime/,
  );
});
