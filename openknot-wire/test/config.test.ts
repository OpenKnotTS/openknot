import {
  composeModule,
  config,
  defineApplication,
  describeApplication,
  override,
  requiredBy,
  resource,
  runApplication,
  unit,
} from "@openknot-ts/wire";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import assert from "node:assert/strict";
import { test } from "node:test";

// A minimal Standard Schema: Wire depends on the specification, not on a schema library.
function integer(fallback: number, delay = false): StandardSchemaV1<unknown, number> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate(value) {
        const parsed = value === undefined ? fallback : Number(value);
        const result = Number.isInteger(parsed) ? { value: parsed } : { issues: [{ message: "expected an integer" }] };
        return delay ? Promise.resolve(result) : result;
      },
    },
  };
}

test("config reads its variables from the environment through schemas or parse functions", async () => {
  const httpConfig = config({
    PORT: integer(3000),
    HTTP_HOST: (value = "127.0.0.1") => value,
  });
  const address = unit({
    requirements: { httpConfig },
    factory: ({ httpConfig }) => {
      const port: number = httpConfig.PORT;
      const host: string = httpConfig.HTTP_HOST;
      return `${host}:${port}`;
    },
  });
  const definition = defineApplication({ modules: [composeModule({ providers: { address } })] });
  for (const [env, expected] of [
    [{ PORT: "8080", HTTP_HOST: "0.0.0.0" }, "0.0.0.0:8080"],
    [{}, "127.0.0.1:3000"],
  ] as const) {
    const app = await runApplication(definition, { env });
    try {
      assert.equal(app.resolve(address), expected);
      assert.equal(Object.isFrozen(app.resolve(httpConfig)), true);
    } finally {
      await app.stop();
    }
  }
  process.env.OPENKNOT_CONFIG_TEST = "7";
  const fromProcess = config({ OPENKNOT_CONFIG_TEST: integer(1, true) });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { fromProcess } })] }));
  try {
    assert.deepEqual(app.resolve(fromProcess), { OPENKNOT_CONFIG_TEST: 7 });
  } finally {
    delete process.env.OPENKNOT_CONFIG_TEST;
    await app.stop();
  }
});

test("a config only a definition outside the roots reaches is read and checked at startup", async () => {
  const retryConfig = config({ RETRIES: integer(3) });
  const retries = unit({ requirements: { retryConfig }, factory: ({ retryConfig }) => retryConfig.RETRIES });
  const status = unit({ factory: () => "up" });
  const definition = defineApplication({
    modules: [composeModule({ providers: { status, retries } }).includeOnly([status])],
  });
  const app = await runApplication(definition, { env: { RETRIES: "5" } });
  try {
    assert.equal(app.resolve(retries), 5);
  } finally {
    await app.stop();
  }
  await assert.rejects(runApplication(definition, { env: { RETRIES: "many" } }), /RETRIES/);
  // An overridden definition resolves nothing, so a config only it requires is not read.
  const stubbed = await runApplication(definition, { env: { RETRIES: "many" }, overrides: [override(retries, 1)] });
  try {
    assert.equal(stubbed.resolve(retries), 1);
  } finally {
    await stubbed.stop();
  }
});

test("invalid variables stop startup before any resource, reported together without their values", async () => {
  let acquisitions = 0;
  const credentials = config({
    PORT: integer(3000),
    API_SECRET: (value) => {
      if (value === undefined || value.length < 8) {
        throw new Error("must have at least 8 characters");
      }
      return value;
    },
  });
  const client = resource({
    requirements: { credentials },
    initialize() {
      acquisitions++;
      return Promise.resolve({ value: 1, release() {} });
    },
  });
  const definition = defineApplication({
    modules: requiredBy(composeModule({ providers: { client } })),
  });
  await assert.rejects(runApplication(definition, { env: { PORT: "eighty", API_SECRET: "short" } }), (error: Error) => {
    assert.equal(
      error.message,
      "Invalid configuration:\n- PORT: expected an integer\n- API_SECRET: must have at least 8 characters",
    );
    assert.doesNotMatch(error.message, /eighty|short/);
    return true;
  });
  assert.equal(acquisitions, 0);
});

test("a schema that throws or rejects is reported by its variable's name, with the other problems", async () => {
  const broken = (rejects: boolean): StandardSchemaV1<unknown, string> => ({
    "~standard": {
      version: 1,
      vendor: "test",
      validate() {
        if (rejects) {
          return Promise.reject(new Error("schema rejected"));
        }
        throw new Error("schema threw");
      },
    },
  });
  const settings = config({ THROWS: broken(false), REJECTS: broken(true), PORT: integer(3000) });
  const definition = defineApplication({ modules: [composeModule({ providers: { settings } })] });
  await assert.rejects(runApplication(definition, { env: { PORT: "eighty" } }), {
    message: "Invalid configuration:\n- THROWS: schema threw\n- REJECTS: schema rejected\n- PORT: expected an integer",
  });
});

test("each variable has one owning config, an override wins, and the description lists the environment", async () => {
  const httpConfig = config({ PORT: integer(3000), HTTP_HOST: (value = "localhost") => value });
  const metricsConfig = config({ PORT: integer(9100) });
  const both = composeModule({ providers: { httpConfig, metricsConfig } });
  await assert.rejects(
    runApplication(defineApplication({ modules: [both] }), { env: {} }),
    /environment variable PORT is declared by more than one config/,
  );
  const single = defineApplication({ modules: [composeModule({ providers: { httpConfig } })] });
  const app = await runApplication(single, {
    env: { PORT: "not read" },
    overrides: [override(httpConfig, { PORT: 1, HTTP_HOST: "stub" })],
  });
  try {
    assert.deepEqual(app.resolve(httpConfig), { PORT: 1, HTTP_HOST: "stub" });
  } finally {
    await app.stop();
  }
  const description = await describeApplication(single);
  assert.deepEqual(description.environment, ["HTTP_HOST", "PORT"]);
  assert.equal(description.definitions.find((definition) => definition.kind === "config")?.binding, "implementation");
  assert.throws(() => Reflect.apply(config, undefined, [{ PORT: 42 }]), /needs a Standard Schema or a parse function/);
});
