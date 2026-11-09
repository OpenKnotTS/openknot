import { expose } from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
import { success } from "@openknot-ts/behavior";
import { runApplication, composeModule, defineApplication } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

test("provided flow modules combine through composeModule and retain selections and hard exclusions", async () => {
  const first = expose({ run: () => success(1) });
  const second = expose({ run: () => success(2) });
  const one = provideFlow([first]);
  const two = provideFlow([second]);
  const ports = composeModule({ modules: [one.includeOnly([first]), two] });
  assert.equal(ports.when(true), ports);
  const app = await runApplication(defineApplication({ modules: [ports] }));
  try {
    assert.deepEqual(await app.resolve(first)({ input: undefined }), 1);
    assert.deepEqual(await app.resolve(second)({ input: undefined }), 2);
  } finally {
    await app.stop();
  }
  const excluded = await runApplication(defineApplication({ modules: [ports.exclude([two])] }));
  try {
    assert.deepEqual(await excluded.resolve(first)({ input: undefined }), 1);
    assert.throws(() => excluded.resolve(second), /excluded|unavailable/);
  } finally {
    await excluded.stop();
  }
});
