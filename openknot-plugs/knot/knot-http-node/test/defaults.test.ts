import { http, httpHandler, httpServer } from "../src/index.ts";
import { defineApplication, providePlugs, resource, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

test("the ready-made HTTP host rejects a missing protocol binding before acquiring resources", async () => {
  let acquired = false;
  const database = resource({
    initialize: async () => {
      acquired = true;
      return { value: {}, release() {} };
    },
  });
  const definition = defineApplication({
    modules: [http, providePlugs([database])],
  });
  // @ts-expect-error A native handler implementation is required for the default HTTP server.
  await assert.rejects(runApplication(definition, { env: { PORT: "0" } }), /handler.*has no implementation/);
  assert.equal(acquired, false);
});

test("a plain native handler binds to the default host without any protocol package", async () => {
  const implementation = unit({
    provides: httpHandler,
    factory: () => (_request, response) => {
      response.end("native");
    },
  });
  const app = await runApplication(
    defineApplication({
      modules: [http, providePlugs([implementation])],
    }),
    { env: { PORT: "0", TRPC_BASE_PATH: "unused", TRPC_MAX_BODY_SIZE: "unused" } },
  );
  const server = app.resolve(httpServer);
  try {
    const response = await fetch(server.url);
    assert.equal(await response.text(), "native");
  } finally {
    await app.stop();
  }
  assert.equal(server.listening, false);
});
