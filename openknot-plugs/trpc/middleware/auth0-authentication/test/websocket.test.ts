import { fixture } from "./fixture.ts";
import type { Router } from "./fixture.ts";
import { createTRPCClient, createWSClient, wsLink, TRPCClientError } from "@trpc/client";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { WebSocketServer } from "ws";

async function websocket(t: TestContext) {
  const server = await fixture(t);
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  applyWSSHandler({ wss, router: server.router, createContext: server.createContext });
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close((cause) => (cause === undefined ? resolve() : reject(cause)));
      }),
  );
  await once(wss, "listening");
  const address = wss.address();
  assert.ok(address !== null && typeof address !== "string");
  return { ...server, url: `ws://127.0.0.1:${address.port}` };
}

test(
  "WebSocket connection parameters authenticate queries and subscriptions through the same middleware",
  { timeout: 10_000 },
  async (t) => {
    const server = await websocket(t);
    const socket = createWSClient({ url: server.url, connectionParams: { token: server.token } });
    t.after(() => socket.close());
    const client = createTRPCClient<Router>({ links: [wsLink({ client: socket })] });
    assert.deepEqual(await client.me.query(), { userId: "auth0|alice" });
    const received = Promise.withResolvers<string>();
    const subscription = client.changes.subscribe(undefined, {
      onData: received.resolve,
      onError: received.reject,
    });
    t.after(() => subscription.unsubscribe());

    assert.equal(await received.promise, "update");
    assert.deepEqual(server.counts(), { authentications: 1, executions: 1, admissions: 2 });
  },
);

test(
  "WebSocket authentication failures retain their typed data and never admit Flow",
  { timeout: 10_000 },
  async (t) => {
    const server = await websocket(t);
    for (const [token, status, code, authenticationError] of [
      [undefined, 200, "UNAUTHORIZED", "ActorAuthenticationError"],
      ["invalid", 200, "UNAUTHORIZED", "ActorAuthenticationError"],
      [server.token, 503, "INTERNAL_SERVER_ERROR", null],
    ] as const) {
      server.respond(status);
      const socket = createWSClient({
        url: server.url,
        connectionParams: token === undefined ? {} : { token },
      });
      t.after(() => socket.close());
      const client = createTRPCClient<Router>({ links: [wsLink({ client: socket })] });
      const rejected = Promise.withResolvers<TRPCClientError<Router>>();
      const subscription = client.changes.subscribe(undefined, { onError: rejected.resolve });
      t.after(() => subscription.unsubscribe());
      const cause = await rejected.promise;

      assert.ok(cause instanceof TRPCClientError);
      assert.equal(cause.data?.code, code);
      assert.equal(cause.data?.authenticationError?.type ?? null, authenticationError);
      subscription.unsubscribe();
      await socket.close();
    }
    assert.equal(server.counts().admissions, 0);
  },
);
