import { command, expose, guard, listener, query, scheduler, unitOfWork } from "../src/index.ts";
import { application, recording } from "./fixtures/unit-of-work.ts";
import { failure, success } from "@openknot-ts/behavior";
import { composeModule, defineApplication, plug, runApplication } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

test("input ports forward to one handler, keeping guards, input, output and errors", async () => {
  const denied = new Error("denied");
  const ticks: string[] = [];
  const rename = command<string>()({
    run: (name) => (name === "" ? failure(denied) : success(name.toUpperCase())),
  });
  const tick = query({
    run: () => {
      ticks.push("tick");
      return success();
    },
  });
  const access = guard<string>()({ run: (token) => (token === "ok" ? success() : failure(denied)) });
  const exposed = expose({ handler: rename, guards: { access } });
  const received = listener({ handler: rename });
  const scheduled = scheduler({ handler: tick, schedule: { every: { minutes: 1 } } });
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { exposed, received, scheduled } })] }),
  );
  try {
    assert.deepEqual(await app.resolve(exposed)({ input: "role", access: "ok" }), "ROLE");
    await assert.rejects(app.resolve(exposed)({ input: "role", access: "no" }), (error) => error === denied);
    await assert.rejects(app.resolve(exposed)({ input: "", access: "ok" }), (error) => error === denied);
    assert.deepEqual(await app.resolve(received)({ input: "log" }), "LOG");
    assert.deepEqual(await app.resolve(scheduled)({ trigger: { scheduledAt: Date.now() } }), undefined);
    assert.deepEqual(ticks, ["tick"]);
  } finally {
    await app.stop();
  }
});

test("an exposure's view responds with a query of the handler's output inside the handler's Unit of Work", async () => {
  const steps: string[] = [];
  const handlerDenied = new Error("handler denied");
  const viewDenied = new Error("view denied");
  const database = unitOfWork();
  const rename = command<string>()({
    unitOfWork: database,
    run: (name) => {
      steps.push(`rename ${name}`);
      return name === "" ? failure(handlerDenied) : success(name.toUpperCase());
    },
  });
  const show = query<string>()({
    unitOfWork: database,
    run: (name) => {
      steps.push(`view ${name}`);
      return name === "HIDDEN" ? failure(viewDenied) : success({ name, length: name.length });
    },
  });
  const exposed = expose({ handler: rename, view: show });
  const app = await application([exposed, plug({ port: database, bind: () => recording(steps) })]);
  try {
    assert.deepEqual(await app.resolve(exposed)({ input: "role" }), { name: "ROLE", length: 4 });
    assert.deepEqual(steps.splice(0), ["rename role", "view ROLE", "commit"]);
    await assert.rejects(app.resolve(exposed)({ input: "hidden" }), (error) => error === viewDenied);
    assert.deepEqual(steps.splice(0), ["rename hidden", "view HIDDEN", "rollback"]);
    await assert.rejects(app.resolve(exposed)({ input: "" }), (error) => error === handlerDenied);
    assert.deepEqual(steps.splice(0), ["rename ", "rollback"]);
  } finally {
    await app.stop();
  }
});

test("an exposure's view is a query of its handler's Unit of Work", () => {
  const rename = command<string>()({ run: (name) => success(name) });
  const create = (options: object) => Reflect.apply(expose, undefined, [options]);
  assert.throws(() => create({ handler: rename, view: rename }), /view must be a query/);
  assert.throws(
    () =>
      create({ handler: rename, view: query<string>()({ unitOfWork: unitOfWork(), run: (name) => success(name) }) }),
    /handler's Unit of Work/,
  );
  assert.throws(
    () => create({ requirements: {}, run: () => success(), view: query({ run: () => success() }) }),
    /view requires a command\(\) or query\(\) handler/,
  );
});

test("a forwarding port rejects requirements or run() and targets that are not handlers", () => {
  const rename = command<string>()({ run: (name) => success(name) });
  const schedule = { every: { minutes: 1 } };
  const factories = [
    (options: object) => Reflect.apply(expose, undefined, [options]),
    (options: object) => Reflect.apply(listener, undefined, [options]),
    (options: object) => Reflect.apply(scheduler, undefined, [{ ...options, schedule }]),
  ];
  for (const create of factories) {
    assert.throws(() => create({ handler: rename, run: () => success() }), /either handler or requirements/);
    assert.throws(() => create({ handler: rename, requirements: {} }), /either handler or requirements/);
    assert.throws(() => create({ handler: { run: () => success() } }), /command\(\) or query\(\)/);
  }
});
