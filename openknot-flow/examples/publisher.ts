import type { InputInvoker } from "../src/index.ts";
import { listener, publisher } from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
import { success } from "@openknot-ts/behavior";
import { plug, composeModule, defineApplication, runApplication } from "@openknot-ts/wire";

type Notice = { readonly type: "NoticePublished"; readonly text: string };

const publishNotice = publisher<Notice>();

const onNotice = listener<Notice>()({
  run: (message) => {
    console.log("MQ listener:", message.text);
    return success();
  },
});

// A local "broker": the publisher plug delivers straight to the listener plug.
let consume: InputInvoker<typeof onNotice> | undefined;

const localConsumer = plug({
  port: onNotice,
  bind: ({ invoke }) => {
    consume = invoke;

    return {
      release() {
        consume = undefined;
      },
    };
  },
});

const localPublisher = plug({
  port: publishNotice,
  bind:
    () =>
    async (input, { signal }) => {
      if (consume === undefined) {
        throw new Error("The consumer is stopped");
      }

      await consume({
        input,
        trigger: { messageId: "notice-1", attempt: 1 },
        ...(signal === undefined ? {} : { signal }),
      });
    },
});

const app = await runApplication(
  defineApplication({
    modules: [provideFlow([publishNotice, onNotice]), composeModule({ providers: { localPublisher, localConsumer } })],
  }),
);

try {
  await app.withScope((scope) =>
    scope.resolve(publishNotice).publish({ type: "NoticePublished", text: "No client connection is needed" }),
  );
} finally {
  await app.stop();
}
