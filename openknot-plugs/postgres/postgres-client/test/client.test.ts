import { postgresClient } from "../src/index.ts";
import { defineApplication, providePlugs, runApplication } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import type { Socket } from "node:net";
import { createServer } from "node:net";
import { test } from "node:test";
import pg from "pg";

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { readonly port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("an unreachable server fails startup and ends the pool", async () => {
  const port = await closedPort();
  const pools: pg.Pool[] = [];
  const postgres = postgresClient({
    create: () => {
      const pool = new pg.Pool({ host: "127.0.0.1", port, user: "app", database: "app" });
      pools.push(pool);
      return pool;
    },
  });
  await assert.rejects(
    runApplication(defineApplication({ modules: [providePlugs([postgres])] }), { stopOn: [] }),
    /ECONNREFUSED/,
  );
  assert.equal(pools.length, 1);
  assert.equal(pools[0]!.ended, true);
});

test("a startup cancelled while a silent server holds the connection attempt stops at once", async () => {
  const sockets = new Set<Socket>();
  const controller = new AbortController();
  // The server accepts the connection and never answers, so node-postgres waits on it without a deadline.
  const silent = createServer((socket) => {
    sockets.add(socket);
    controller.abort(new Error("stopped during startup"));
  });
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const { port } = silent.address() as { readonly port: number };
  const pools: pg.Pool[] = [];
  const postgres = postgresClient({
    create: () => {
      const pool = new pg.Pool({ host: "127.0.0.1", port, user: "app", database: "app" });
      pools.push(pool);
      return pool;
    },
  });
  try {
    await assert.rejects(
      runApplication(defineApplication({ modules: [providePlugs([postgres])] }), {
        stopOn: [],
        signal: controller.signal,
      }),
      /stopped during startup/,
    );
    assert.equal(pools[0]!.ending, true);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }
});

test("a cancelled startup ends the pool it created", async () => {
  const controller = new AbortController();
  const pools: pg.Pool[] = [];
  const postgres = postgresClient({
    create: () => {
      const pool = new pg.Pool({ host: "127.0.0.1", port: 1, user: "app", database: "app" });
      pools.push(pool);
      controller.abort(new Error("stopped during startup"));
      return pool;
    },
  });
  await assert.rejects(
    runApplication(defineApplication({ modules: [providePlugs([postgres])] }), {
      stopOn: [],
      signal: controller.signal,
    }),
  );
  assert.equal(pools[0]!.ended, true);
});
