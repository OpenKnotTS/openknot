import type { HttpHandler } from "../src/index.ts";
import { bunHttpServer } from "../src/index.ts";
import type { ErrorReport } from "@openknot-ts/error-reporting";
import { errorReporter } from "@openknot-ts/error-reporting/wire";
import type { LogRecord } from "@openknot-ts/logging";
import { logging } from "@openknot-ts/logging/wire";
import { composeModule, defineApplication, runApplication, unit } from "@openknot-ts/wire";
import { test } from "bun:test";
import assert from "node:assert/strict";

test("a failing handler answers 500 and is logged and reported once", async () => {
  const failure = new Error("private failure");
  const handler = unit({
    factory: (): HttpHandler => (request) => {
      if (new URL(request.url).pathname === "/throws") {
        throw failure;
      }
      return Promise.reject(failure);
    },
  });
  const server = bunHttpServer({ handler });
  const records: LogRecord[] = [];
  const recorded = unit({
    provides: logging,
    factory: () => ({ write: (record: LogRecord) => void records.push(record) }),
  });
  const reports: ErrorReport[] = [];
  const reporter = unit({ provides: errorReporter, factory: () => (report: ErrorReport) => reports.push(report) });
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { server, recorded, reporter } })] }),
    { env: { PORT: "0" }, stopOn: [] },
  );
  try {
    const { url } = app.resolve(server);
    for (const path of ["/throws", "/rejects"]) {
      const response = await fetch(`${url}${path}`);
      assert.equal(response.status, 500);
      assert.equal(await response.text(), "Internal Server Error");
    }
    assert.deepEqual(
      records.map((record) => [record.level, record.message, record.attributes.error]),
      Array.from({ length: 2 }, () => ["error", "HTTP request handler failed", failure]),
    );
    assert.deepEqual(
      reports.map((report) => [report.error, report.source, report.expected]),
      Array.from({ length: 2 }, () => [failure, "openknot.http", false]),
    );
  } finally {
    await app.stop();
  }
});
