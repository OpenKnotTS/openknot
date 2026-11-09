import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

test("plugs keep guard declarations inside Flow", () => {
  const plugs = new URL("../src/plugs/", import.meta.url);
  for (const name of readdirSync(plugs, { recursive: true, encoding: "utf8" })) {
    if (!name.endsWith(".ts") || name.includes("node_modules/") || name.includes("dist/")) {
      continue;
    }
    const source = readFileSync(new URL(name, plugs), "utf8");
    assert.doesNotMatch(source, /\bguards\s*:|\bguardInputs\s*:|\/guards(?:\.ts)?["']/, name);
  }
});
