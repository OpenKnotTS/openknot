import { command, expose, guard } from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
import { reader, success } from "@openknot-ts/behavior";
import { runApplication, composeModule, defineApplication, plug } from "@openknot-ts/wire";
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

test("an application lists an exposure composition as its inputs, and each member's requirements are validated", async () => {
  const count = reader<() => number>();
  const first = expose({ requirements: { count }, run: (_input, ctx) => success(ctx.count()) });
  const second = expose({ run: () => success(2) });
  const api = expose.compose({ first, second });

  // @ts-expect-error The compiler reports the missing reader as well.
  await assert.rejects(runApplication(defineApplication({ inputs: [api] })), /reader 'count' has no implementation/);

  const app = await runApplication(
    defineApplication({ inputs: [api], modules: [plug({ port: count, bind: () => () => 1 })] }),
  );
  try {
    assert.equal(await app.resolve(first)({ input: undefined }), 1);
    assert.equal(await app.resolve(second)({ input: undefined }), 2);
  } finally {
    await app.stop();
  }

  // Handlers, guards and output contracts join through requirements; they cannot be listed as inputs.
  const handler = command({ run: () => success(1) });
  const policy = guard({ run: () => success() });
  assert.throws(
    () =>
      defineApplication({
        // @ts-expect-error A command is not an input port.
        inputs: [handler],
      }),
    /not a command/,
  );
  assert.throws(
    () =>
      defineApplication({
        // @ts-expect-error A guard is not an input port.
        inputs: [policy],
      }),
    /not a guard/,
  );
  assert.throws(
    () =>
      defineApplication({
        // @ts-expect-error A reader composition groups no input ports.
        inputs: [reader.compose({ count })],
      }),
    /not a reader/,
  );
});
