import type { HttpMiddleware } from "../src/index.ts";
import { http, httpHandler, httpMiddleware, httpServer } from "../src/index.ts";
import { defineApplication, providePlugs, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import type { RequestListener, Server } from "node:http";
import { test } from "node:test";

test("selected native middleware preserves order, server context, streaming and short-circuiting", async () => {
  const order: string[] = [];
  let native: Server | undefined;
  const privateMiddleware = unit({
    provides: httpMiddleware,
    factory: (): HttpMiddleware => () => {
      throw new Error("An unlisted middleware must not run.");
    },
  });
  const first = unit({
    provides: httpMiddleware,
    requirements: { privateMiddleware },
    factory: (): HttpMiddleware =>
      function (_request, response, next) {
        assert.equal(this, native);
        order.push("first");
        response.setHeader("x-native", "first");
        next();
      },
  });
  const second = unit({
    provides: httpMiddleware,
    factory: (): HttpMiddleware => (request, response, next) => {
      order.push("second");
      if (request.url === "/intercept") {
        response.end("intercepted");
      } else {
        next();
      }
    },
  });
  const handler = unit({
    provides: httpHandler,
    factory: (): RequestListener =>
      function (this: Server, request, response) {
        assert.equal(this, native);
        order.push("handler");
        request.pipe(response);
      },
  });
  const app = await runApplication(
    defineApplication({
      modules: [http, providePlugs([first, second, handler])],
    }),
    { env: { PORT: "0", HTTP_HEALTH_PATH: "unused" } },
  );
  const server = app.resolve(httpServer);
  native = server.native;
  try {
    const response = await fetch(server.url, { method: "POST", body: "native-stream" });
    assert.equal(response.headers.get("x-native"), "first");
    assert.equal(await response.text(), "native-stream");
    assert.deepEqual(order, ["first", "second", "handler"]);
    order.length = 0;
    assert.equal(await (await fetch(`${server.url}/intercept`)).text(), "intercepted");
    assert.deepEqual(order, ["first", "second"]);
  } finally {
    await app.stop();
  }
});
