import type { NoRequirements } from "./internal/requirements.ts";
import type { Provider } from "./providers.ts";
import { unit } from "./providers.ts";
import type { StandardSchemaV1 } from "@standard-schema/spec";

const ConfigMarker = Symbol.for("@openknot-ts/wire/config");

/** Reads one environment variable: a Standard Schema over its raw value, or a function that parses or throws. */
export type ConfigVariable<T = unknown> = StandardSchemaV1<unknown, T> | ((value: string | undefined) => T);
export type ConfigVariables = Readonly<Record<string, ConfigVariable>>;
export type ConfigValues<V extends ConfigVariables> = {
  readonly [K in keyof V]: V[K] extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<V[K]>
    : V[K] extends (value: string | undefined) => infer T
      ? T
      : never;
};
/** The environment a run reads configuration from. */
export type Environment = Readonly<Record<string, string | undefined>>;

/** An ordinary singleton reference whose value runApplication() reads from the environment and validates. */
export interface Config<V extends ConfigVariables = ConfigVariables> extends Provider<
  ConfigValues<V>,
  never,
  "unit",
  NoRequirements
> {
  readonly [ConfigMarker]: V;
}

function isSchema(value: unknown): value is StandardSchemaV1 {
  return (
    typeof value === "object" &&
    value !== null &&
    "~standard" in value &&
    typeof (value["~standard"] as { validate?: unknown } | undefined)?.validate === "function"
  );
}

/** Declares the environment variables a plug reads, by their real names. */
export function config<const V extends ConfigVariables>(variables: V): Config<V> {
  if (typeof variables !== "object" || variables === null || Array.isArray(variables)) {
    throw new TypeError("config() requires an object of environment variables.");
  }

  const snapshot = Object.freeze({ ...variables });

  if (Object.keys(snapshot).length === 0) {
    throw new TypeError("config() requires at least one environment variable.");
  }

  for (const [name, variable] of Object.entries(snapshot)) {
    if (typeof variable !== "function" && !isSchema(variable)) {
      throw new TypeError(`Config variable ${name} needs a Standard Schema or a parse function.`);
    }
  }

  const provider = unit({
    factory: (): ConfigValues<V> => {
      throw new Error("A config is read from the environment by runApplication().");
    },
  });

  return Object.freeze({ ...provider, [ConfigMarker]: snapshot }) as Config<V>;
}

export function isConfig(value: unknown): value is Config {
  return typeof value === "object" && value !== null && ConfigMarker in value;
}

/** The variables a config declares, in declaration order. */
export function configVariables(definition: Config): ConfigVariables {
  return definition[ConfigMarker];
}

export interface ConfigReading {
  readonly values: object;
  readonly problems: readonly string[];
}

type Read = { readonly value: unknown } | { readonly problem: string };

function message(error: unknown): string {
  return typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error);
}

function readVariable(name: string, variable: ConfigVariable, raw: string | undefined): Read | Promise<Read> {
  // A parse function or schema that throws is reported by the variable's name, together with the other problems.
  const thrown = (error: unknown): Read => ({ problem: `- ${name}: ${message(error)}` });

  if (typeof variable === "function") {
    try {
      return { value: variable(raw) };
    } catch (error) {
      return thrown(error);
    }
  }

  const settle = (result: StandardSchemaV1.Result<unknown>): Read =>
    result.issues === undefined
      ? { value: result.value }
      : { problem: `- ${name}: ${result.issues.map((issue) => issue.message).join("; ")}` };

  let result: StandardSchemaV1.Result<unknown> | Promise<StandardSchemaV1.Result<unknown>>;
  try {
    result = variable["~standard"].validate(raw);
  } catch (error) {
    return thrown(error);
  }

  return result instanceof Promise ? result.then(settle, thrown) : settle(result);
}

function collect(entries: readonly (readonly [string, Read])[]): ConfigReading {
  const values: Record<string, unknown> = {};
  const problems: string[] = [];

  for (const [name, read] of entries) {
    if ("problem" in read) {
      problems.push(read.problem);
      continue;
    }
    values[name] = read.value;
  }

  return { values: Object.freeze(values), problems };
}

/** Reads and validates one config; problems name the variable and never echo its value. */
export async function readConfig(definition: Config, environment: Environment): Promise<ConfigReading> {
  const entries = Object.entries(configVariables(definition));
  const reads = await Promise.all(entries.map(([name, variable]) => readVariable(name, variable, environment[name])));
  return collect(entries.map(([name], index) => [name, reads[index] as Read] as const));
}
