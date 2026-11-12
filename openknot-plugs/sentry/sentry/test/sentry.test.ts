import type { SentryClient, SentrySdk } from "../src/index.ts";
import { sentryModule } from "../src/index.ts";
import { defineApplication, runApplication } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

interface Options {
  readonly shutdownTimeout?: number;
}

/** An SDK that records the calls the module makes; the runtime plugs test the real SDKs. */
function recordingSdk() {
  const calls: string[] = [];
  let current: SentryClient | undefined;
  const sdk: SentrySdk<Options> = {
    init(options) {
      calls.push("init");
      current = {
        getOptions: () => options,
        async close(timeout) {
          calls.push(`client.close ${timeout}`);
          return true;
        },
      };
    },
    isInitialized: () => current !== undefined,
    getClient: () => current,
    async close(timeout) {
      calls.push(`close ${timeout}`);
      current = undefined;
      return true;
    },
    withScope: (callback) => callback({ setTag: () => undefined, setContext: () => undefined }),
    captureException: () => "",
  };
  return { sdk, calls };
}

test("shutdown waits for pending events as long as the client's shutdownTimeout, or Sentry's two seconds", async () => {
  for (const [shutdownTimeout, expected] of [
    [5000, "close 5000"],
    [undefined, "close 2000"],
    [0, "close 2000"],
  ] as const) {
    const { sdk, calls } = recordingSdk();
    const options = shutdownTimeout === undefined ? {} : { shutdownTimeout };
    const app = await runApplication(defineApplication({ modules: [sentryModule(sdk)({ options: () => options })] }));
    await app.stop();
    assert.deepEqual(calls, ["init", expected]);
  }
});
