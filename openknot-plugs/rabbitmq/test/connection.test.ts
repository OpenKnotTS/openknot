import { rabbitConnectionOf, rabbitErrors, rabbitTopology } from "../src/index.ts";
import type { ErrorReport } from "@openknot-ts/error-reporting";
import { errorReporter } from "@openknot-ts/error-reporting/wire";
import { defineApplication, providePlugs, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { test } from "node:test";

function native() {
  const emitter = new EventEmitter() as EventEmitter & { ready: boolean };
  emitter.ready = true;
  return emitter;
}

test("a connection reports one loss and one restoration per outage to every watcher", () => {
  const connection = native();
  const watched = rabbitConnectionOf(connection as never);
  const seen: string[] = [];
  const stopFirst = watched.watch({ lost: () => seen.push("first lost"), restored: () => seen.push("first restored") });
  watched.watch({ lost: () => seen.push("second lost"), restored: () => seen.push("second restored") });

  connection.emit("error", new Error("channel error while connected"));
  connection.ready = false;
  connection.emit("error", new Error("socket closed"));
  connection.emit("error", new Error("reconnect refused"));
  connection.ready = true;
  connection.emit("connection");
  connection.emit("connection");
  assert.deepEqual(seen, ["first lost", "second lost", "first restored", "second restored"]);

  stopFirst();
  stopFirst();
  connection.ready = false;
  connection.emit("error", new Error("socket closed"));
  assert.deepEqual(seen.slice(4), ["second lost"]);
});

test("native listeners attach with the first watcher and are removed with the last", () => {
  const connection = native();
  const watched = rabbitConnectionOf(connection as never);
  const handlers = { lost: () => undefined, restored: () => undefined };
  const stops = [watched.watch(handlers), watched.watch(handlers)];
  assert.deepEqual([connection.listenerCount("error"), connection.listenerCount("connection")], [1, 1]);
  stops[0]!();
  assert.deepEqual([connection.listenerCount("error"), connection.listenerCount("connection")], [1, 1]);
  stops[1]!();
  assert.deepEqual([connection.listenerCount("error"), connection.listenerCount("connection")], [0, 0]);
});

test("connection failures reach the application's rabbitErrors binding instead of the console", async () => {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address() as { readonly port: number };
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  const errors: unknown[] = [];
  const reports: ErrorReport[] = [];
  const controller = new AbortController();
  const report = unit({
    provides: rabbitErrors,
    factory: () => (error: unknown) => {
      errors.push(error);
    },
  });
  const reporter = unit({
    provides: errorReporter,
    factory: () => (reported: ErrorReport) => {
      reports.push(reported);
      controller.abort(new Error("reported"));
    },
  });
  const { rabbitConnection } = rabbitTopology({
    exchanges: [{ exchange: "events", type: "topic" }],
    queues: [{ queue: "events" }],
    routes: [{ exchange: "events", routingKey: "event" }],
  });
  await assert.rejects(
    runApplication(defineApplication({ modules: [providePlugs([rabbitConnection, report, reporter])] }), {
      env: { RABBITMQ_URL: `amqp://127.0.0.1:${port}` },
      signal: controller.signal,
      stopOn: [],
    }),
    /reported/,
  );
  assert.ok(errors.length > 0);
  assert.deepEqual(
    reports.map((each) => [each.error, each.source, each.expected]),
    errors.map((error) => [error, "openknot.rabbitmq", false]),
  );
});
