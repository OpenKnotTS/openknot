import { cache } from "../src/index.ts";
import { reader } from "@openknot-ts/behavior";
import { composeModule, defineApplication, plug, resource, runApplication } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

test(
  "cancelling a blocking snapshot aborts loader acquisition and releases acquired resources",
  { timeout: 5_000 },
  async () => {
    const entered = Promise.withResolvers<AbortSignal>();
    const finish = Promise.withResolvers<void>();
    let released = false;
    const acquired = resource({
      lifetime: "scoped",
      initialize: async () => ({
        value: undefined,
        release: () => {
          released = true;
        },
      }),
    });
    const session = resource({
      lifetime: "scoped",
      requirements: { acquired },
      initialize: async (_dependencies, { signal }) => {
        const cancelled = Promise.withResolvers<never>();
        const abort = () => cancelled.reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        entered.resolve(signal);
        try {
          await Promise.race([finish.promise, cancelled.promise]);
        } finally {
          signal.removeEventListener("abort", abort);
        }
        return { value: undefined, release: () => undefined };
      },
    });
    const load = reader<() => Promise<readonly { readonly entity: "role"; readonly id: string }[]>>();
    const source = plug({ port: load, requirements: { session }, bind: () => async () => [] });
    const layer = cache({
      entity: "role",
      strategy: "snapshot",
      startup: "blocking",
      port: load,
      load,
      persist: () => () => undefined,
      bind: () => ({ value: () => [] }),
    });
    const controller = new AbortController();
    const reason = new Error("startup cancelled");
    const running = runApplication(
      defineApplication({
        modules: [
          composeModule({
            providers: [source, ...Object.values(layer)].map((definition) => ({ definition })),
          }),
        ],
      }),
      { signal: controller.signal, stopOn: [] },
    );
    const rejected = assert.rejects(running, (error) => error === reason);
    try {
      const signal = await entered.promise;
      controller.abort(reason);
      assert.equal(signal.aborted, true, "the loader's acquisition must receive startup cancellation");
      await rejected;
      assert.equal(released, true, "startup cancellation must release the loader's acquired dependencies");
    } finally {
      finish.resolve();
      await rejected;
    }
  },
);
