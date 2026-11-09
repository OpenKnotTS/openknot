import { trpcHandler, trpcHttpConfig } from "../src/index.ts";
import { defineApplication, providePlugs, runApplication, unit } from "@openknot-ts/wire";
import { initTRPC } from "@trpc/server";
import assert from "node:assert/strict";
import { test } from "node:test";

test("handler configuration rejects invalid limits before constructing the router", async () => {
  let built = 0;
  const router = unit({
    factory: () => {
      built++;
      return initTRPC.create().router({});
    },
  });
  const handler = trpcHandler({ router });
  const application = defineApplication({ modules: [providePlugs([handler])] });
  for (const value of ["", " ", "-1", "1.5", "+1", "1e3", "0x10", "unknown", "Infinity ", "9007199254740992"]) {
    await assert.rejects(
      runApplication(application, { env: { TRPC_MAX_BODY_SIZE: value } }).then((app) => app.stop()),
      /TRPC_MAX_BODY_SIZE/,
    );
  }
  assert.equal(built, 0);
});

test("configuration preserves absent overrides, path normalization and unlimited bodies", async () => {
  const application = defineApplication({ modules: [providePlugs([trpcHttpConfig])] });
  for (const { env, basePath, maxBodySize } of [
    { env: {}, basePath: undefined, maxBodySize: undefined },
    { env: { TRPC_BASE_PATH: "/api", TRPC_MAX_BODY_SIZE: "000" }, basePath: "/api/", maxBodySize: 0 },
    { env: { TRPC_BASE_PATH: "/api/", TRPC_MAX_BODY_SIZE: "Infinity" }, basePath: "/api/", maxBodySize: Infinity },
    {
      env: { TRPC_BASE_PATH: "/", TRPC_MAX_BODY_SIZE: "9007199254740991" },
      basePath: "/",
      maxBodySize: Number.MAX_SAFE_INTEGER,
    },
  ]) {
    const app = await runApplication(application, { env, stopOn: [] });
    try {
      const settings = app.resolve(trpcHttpConfig);
      assert.equal(settings.TRPC_BASE_PATH, basePath);
      assert.equal(settings.TRPC_MAX_BODY_SIZE, maxBodySize);
    } finally {
      await app.stop();
    }
  }
  await assert.rejects(
    runApplication(application, { env: { TRPC_BASE_PATH: "api" } }),
    /TRPC_BASE_PATH: must start with \//,
  );
});
