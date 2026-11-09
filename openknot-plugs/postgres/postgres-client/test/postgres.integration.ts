import { postgresClient, postgresHealthCheck } from "../src/index.ts";
import { health, healthProbes } from "@openknot-ts/health";
import { defineApplication, providePlugs, runApplication } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";

const url = process.env.DATABASE_URL ?? "";
const skip = url === "" ? "set DATABASE_URL to run against Postgres" : false;

test("the pool serves queries and health while running and ends on stop", { skip }, async () => {
  let pool: pg.Pool | undefined;
  const postgres = postgresClient({
    create: () => (pool = new pg.Pool({ connectionString: url }).on("error", () => undefined)),
  });
  const app = await runApplication(
    defineApplication({ modules: [providePlugs([postgres, postgresHealthCheck({ postgres })]), health] }),
    { stopOn: [] },
  );
  try {
    const { rows } = await app.resolve(postgres).query<{ readonly answer: number }>("SELECT 41 + 1 AS answer");
    assert.deepEqual(rows, [{ answer: 42 }]);
    const report = await app.resolve(healthProbes).health({ signal: new AbortController().signal });
    assert.deepEqual(report.checks, { postgres: "up" });
  } finally {
    await app.stop();
  }
  assert.equal(pool!.ended, true);
  assert.equal(pool!.totalCount, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    process.getActiveResourcesInfo().filter((name) => name === "TCPSocketWrap"),
    [],
    "every connection's socket has closed",
  );
});

test("a pool the application already queried in create still closes every connection on stop", { skip }, async () => {
  let pool: pg.Pool | undefined;
  const postgres = postgresClient({
    create: async () => {
      pool = new pg.Pool({ connectionString: url }).on("error", () => undefined);
      await pool.query("SELECT 1");
      return pool;
    },
  });
  const app = await runApplication(defineApplication({ modules: [providePlugs([postgres])] }), { stopOn: [] });
  await app.stop();
  assert.equal(pool!.totalCount, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    process.getActiveResourcesInfo().filter((name) => name === "TCPSocketWrap"),
    [],
  );
});
