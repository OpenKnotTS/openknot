import { command, expose, writer } from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
import { reader, success } from "@openknot-ts/behavior";
import { defineApplication, describeApplication, plug, providePlugs } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

test("describeApplication shows how each contract is bound and where it is required", async () => {
  const find = reader<(id: string) => string>();
  const save = writer<(name: string) => void>();
  const store = command<string>()({
    requirements: { find, save },
    run: (id, ctx) => success(ctx.save(ctx.find(id))),
  });
  const api = expose({ handler: store });
  const storage = plug({ port: writer.compose({ save }), bind: () => ({ save: () => {} }) });
  const description = await describeApplication(
    defineApplication({ modules: [provideFlow([api]), providePlugs([storage])] }),
  );
  const named = (name: string) => description.definitions.find((definition) => definition.names.includes(name));
  const byId = (id: number | undefined) => description.definitions.find((definition) => definition.id === id);
  assert.partialDeepStrictEqual(named("save"), { kind: "writer", lifetime: "scoped", binding: "implementation" });
  assert.ok(named("save")?.dependencies.some(({ id }) => byId(id)?.kind === "plug"));
  assert.partialDeepStrictEqual(named("find"), { kind: "reader", binding: "unbound" });
  const exposure = description.definitions.find((definition) => definition.kind === "expose");
  assert.deepEqual(exposure?.roles, ["root"]);
  // The handler is a deferred reference of the exposure, resolved per invocation.
  assert.ok(exposure?.references.some((id) => byId(id)?.kind === "command"));
  assert.equal(named("handler")?.kind, "command");
  assert.deepEqual(description.problems, ["- reader 'find' has no implementation (expose → handler → find)"]);
});
