import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("an isolated consumer uses public models, Flow ports and typed tRPC exports", () => {
  const project = mkdtempSync(join(tmpdir(), "openknot-simple-consumer-"));
  try {
    for (const [name, source] of [
      ["@openknot-ts/wire", "../../../../openknot-wire/"],
      ["@modular/behavior", "../../app/behavior/"],
      ["@modular/flow", "../../app/flow/"],
      ["@modular/channels", "../../plugs/channels/"],
      ["@modular/io", "../../plugs/io/"],
      ["@modular/transport", "../../plugs/transport/"],
      ["@openknot-ts/knot-http-node", "../node_modules/@openknot-ts/knot-http-node/"],
      ["@trpc/client", "../node_modules/@trpc/client/"],
      ["@types/node", "../node_modules/@types/node/"],
    ] as const) {
      const destination = join(project, "node_modules", name);
      mkdirSync(join(destination, ".."), { recursive: true });
      symlinkSync(fileURLToPath(new URL(source, import.meta.url)), destination, "junction");
    }
    writeFileSync(join(project, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(
      join(project, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2024",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          lib: ["ES2024", "DOM"],
          types: ["node"],
          strict: true,
          noEmit: true,
          // An application leaves third-party declarations to their authors; the expectations below fail
          // if a package's declarations stop resolving, since unresolved types would read as any.
          skipLibCheck: true,
        },
        include: ["consumer.ts"],
      }),
    );
    writeFileSync(
      join(project, "consumer.ts"),
      `
import type { Application } from "@openknot-ts/wire";
import { Role } from "@modular/behavior/models/role";
import { Log } from "@modular/behavior/models/log";
import { createRoleExposure } from "@modular/flow/exposures";
// @ts-expect-error Commands stay internal to the Flow package.
import type * as Commands from "@modular/flow/commands";
// @ts-expect-error Queries stay internal to the Flow package.
import type * as Queries from "@modular/flow/queries";
// @ts-expect-error Guards stay internal to the Flow package.
import type * as Guards from "@modular/flow/guards";
import { roleChangedListener } from "@modular/flow/listeners";
import { AccessDenied, rolePublisher, saveRoleWriter } from "@modular/flow/ports";
import { roleEvents } from "@modular/channels";
import { database, transaction, roles, logs } from "@modular/io";
import type { AppRouter } from "@modular/transport";
import { httpServer } from "@openknot-ts/knot-http-node";
declare const app: Application;
declare const client: import("@trpc/client").TRPCClient<AppRouter>;
const input = { id: "one", name: "One", active: true };
void Role.create(input); void Log.createFromRole(input);
const rejected: import("@modular/flow/ports").AccessDenied = AccessDenied("Rejected");
void rejected;
void app.resolve(createRoleExposure)({ input, userHasAccessToRoleGuard: undefined, actor: { userId: "example-user" } });
// @ts-expect-error The public actor contract is application-defined and preserves its shape.
void app.resolve(createRoleExposure)({ input, userHasAccessToRoleGuard: undefined, actor: { userId: 123 } });
void app.resolve(roleChangedListener)({ input: { type: "RoleChanged", role: input } });
void app.withScope(scope => scope.resolve(rolePublisher).publish({ type: "RoleChanged", role: input }));
void app.withScope(async scope => {
  const saved: { readonly changeType: "upserted"; readonly next: typeof input } = await scope.resolve(saveRoleWriter)(input);
  return saved.next;
});
void app.resolve(roleEvents); void app.resolve(httpServer).listening;
const nativeServer: import("node:http").Server = app.resolve(httpServer).native;
void nativeServer;
void app.resolve(database).select().from(roles); void app.resolve(transaction).session?.select().from(logs);
void client.createRole.mutate(input); void client.getState.query();
// @ts-expect-error The router declares its procedures.
void client.deleteRole;
// @ts-expect-error Tables declare their columns.
void roles.missing;
`,
    );
    const compiler = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
    const checked = spawnSync(process.execPath, [compiler, "-p", project], { encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("the Flow package keeps handlers and guards unavailable through public runtime imports", async () => {
  for (const path of ["@modular/flow/commands", "@modular/flow/queries", "@modular/flow/guards"]) {
    await assert.rejects(import(path), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  }
});
