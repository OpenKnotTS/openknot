import type { HttpHandler } from "../src/index.ts";
import { bunHttpServer } from "../src/index.ts";
import type { ErrorReport } from "@openknot-ts/error-reporting";
import { errorReporter } from "@openknot-ts/error-reporting/wire";
import { composeModule, defineApplication, runApplication, unit } from "@openknot-ts/wire";
import { test } from "bun:test";
import assert from "node:assert/strict";

test("a failing handler is reported, then answered by Bun's own error handling", async () => {
  const failure = new Error("private failure");
  const handler = unit({
    factory: (): HttpHandler => (request) => {
      if (new URL(request.url).pathname === "/throws") {
        throw failure;
      }
      return Promise.reject(failure);
    },
  });
  // The application's native error handler answers after the report, as Bun's own handling would.
  const server = bunHttpServer({
    handler,
    options: { error: () => new Response("Internal Server Error", { status: 500 }) },
  });
  const reports: ErrorReport[] = [];
  const reporter = unit({ provides: errorReporter, factory: () => (report: ErrorReport) => reports.push(report) });
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { server, reporter } })] }),
    { env: { PORT: "0" }, stopOn: [] },
  );
  try {
    const { url } = app.resolve(server);
    for (const path of ["/throws", "/rejects"]) {
      assert.equal((await fetch(`${url}${path}`)).status, 500);
    }
    assert.deepEqual(
      reports.map((report) => [report.error, report.source, report.expected]),
      Array.from({ length: 2 }, () => [failure, "openknot.http", false]),
    );
  } finally {
    await app.stop();
  }
});
