import { pinoLogging } from "../src/index.ts";
import { providePinoLogging } from "../src/wire.ts";
import { logger } from "@openknot-ts/logging/wire";
import { composeModule, defineApplication, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";
import { pino } from "pino";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const instance = pino({ level: "debug" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
  return { lines, instance };
}

test("records reach pino with their level, message, attributes and serialized errors", () => {
  const { lines, instance } = capture();
  const failure = new Error("connection reset");
  pinoLogging(instance).write({
    level: "error",
    message: "delivery failed",
    attributes: { queue: "roles", error: failure },
  });
  assert.deepEqual(
    lines.map(({ level, msg, queue, error }) => {
      const { type, message } = error as { readonly type: string; readonly message: string };
      return { level, msg, queue, type, message };
    }),
    [{ level: 50, msg: "delivery failed", queue: "roles", type: "Error", message: "connection reset" }],
  );
});

test("the module replaces the console default with the instance its requirements build", async () => {
  const { lines, instance } = capture();
  const native = unit({ factory: () => instance });
  const app = await runApplication(
    defineApplication({
      modules: [
        composeModule({ providers: { logger, native } }),
        providePinoLogging({ requirements: { native }, factory: ({ native }) => native }),
      ],
    }),
    { env: { LOG_LEVEL: "debug" } },
  );
  try {
    app.resolve(logger).child({ roleId: "r1" }).debug("renamed");
  } finally {
    await app.stop();
  }
  assert.deepEqual(
    lines.map(({ level, msg, roleId }) => ({ level, msg, roleId })),
    [{ level: 20, msg: "renamed", roleId: "r1" }],
  );
});
