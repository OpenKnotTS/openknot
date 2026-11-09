import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { Connection } from "rabbitmq-client";

export async function observer(t: TestContext) {
  const url = process.env.RABBITMQ_URL;
  assert.ok(url, "Set RABBITMQ_URL for managed integration tests");
  const connection = new Connection(url);
  connection.on("error", console.error);
  const cleanups: (() => unknown | PromiseLike<unknown>)[] = [() => connection.close()];
  const cleanup = (action: () => unknown | PromiseLike<unknown>) => {
    cleanups.push(action);
  };
  t.after(async () => {
    const errors: unknown[] = [];
    for (const action of cleanups.reverse()) {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Managed broker cleanup failed");
    }
  });
  await connection.onConnect();
  const queue = `openknot.managed.${randomUUID()}`;
  return { connection, queue, cleanup, env: { RABBITMQ_URL: url } };
}
