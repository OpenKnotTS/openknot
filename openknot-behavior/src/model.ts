import { ModelValidationError } from "./errors.ts";
import { requireOutcome, safely } from "./internal/operation-safety.ts";
import type { ErrorOf, Outcome } from "./outcome.ts";
import { failure, success } from "./outcome.ts";
import { discardedThenable } from "@openknot-ts/wire/internal/synchronous";
import type { StandardSchemaV1 } from "@standard-schema/spec";

export type ModelMutation<State = unknown> = (...args: never[]) => Outcome<State, Error>;
export type ModelMutations<State = unknown> = Readonly<Record<string, ModelMutation<State>>>;
export type ModelQuery = (...args: never[]) => unknown;
export type ModelQueries = Readonly<Record<string, ModelQuery>>;
type NoMethods = Readonly<Record<never, never>>;

type CheckedQueries<Q extends ModelQueries, M extends ModelMutations> = {
  readonly [K in keyof Q]: K extends "name" | keyof M
    ? never
    : Extract<ReturnType<Q[K]>, PromiseLike<unknown>> extends never
      ? Q[K]
      : never;
};

export type BoundModelMutations<State, M extends ModelMutations, InvariantError extends Error> = {
  readonly [K in keyof M]: (...args: Parameters<M[K]>) => Outcome<State, ErrorOf<ReturnType<M[K]>> | InvariantError>;
};

export type Model<
  State,
  M extends ModelMutations,
  Q extends ModelQueries = NoMethods,
  InvariantError extends Error = never,
> = { readonly name?: string } & BoundModelMutations<State, M, InvariantError> & Readonly<Q>;

/** Models without a schema select State once; method signatures and declared errors remain inferred. */
export interface ModelFactory<State> {
  <
    E extends Error,
    const M extends ModelMutations<State> = NoMethods,
    const Q extends ModelQueries = NoMethods,
  >(options: {
    readonly name?: string;
    readonly invariants: (state: Readonly<State>) => Outcome<void, E>;
    readonly mutations?: M & { readonly name?: never };
    readonly queries?: Q & CheckedQueries<Q, NoInfer<M>>;
  }): Model<State, M, Q, E>;
  <const M extends ModelMutations<State> = NoMethods, const Q extends ModelQueries = NoMethods>(options: {
    readonly name?: string;
    readonly invariants?: never;
    readonly mutations?: M & { readonly name?: never };
    readonly queries?: Q & CheckedQueries<Q, NoInfer<M>>;
  }): Model<State, M, Q>;
}

/** A schema owns State: it is inferred from the schema's output, and mutations return its input. */
export function model<
  const Schema extends StandardSchemaV1,
  const M extends ModelMutations<NoInfer<StandardSchemaV1.InferInput<Schema>>> = NoMethods,
  const Q extends ModelQueries = NoMethods,
>(options: {
  readonly name?: string;
  readonly invariants: Schema;
  readonly mutations?: M & { readonly name?: never };
  readonly queries?: Q & CheckedQueries<Q, NoInfer<M>>;
}): Model<StandardSchemaV1.InferOutput<Schema>, M, Q, ModelValidationError>;
/** Without a schema, select State first: model<State>()({ invariants?, mutations, queries }). */
export function model<State>(): ModelFactory<State>;
export function model(options?: Parameters<typeof createModel>[0]): unknown {
  // The factory validates heterogeneous methods at runtime; its public signatures
  // retain each method's inputs, the selected state and its declared errors.
  return options === undefined ? createModel : createModel(options);
}

function createModel(options: {
  readonly name?: string;
  readonly mutations?: ModelMutations;
  readonly queries?: ModelQueries;
  readonly invariants?: StandardSchemaV1 | ((state: never) => Outcome<void, Error>);
}): Readonly<Record<string, unknown>> {
  const modelName = options.name;
  if (modelName !== undefined && (typeof modelName !== "string" || modelName.length === 0)) {
    throw new TypeError("A model name, when given, must be a non-empty diagnostic name.");
  }
  const invariant = options.invariants;
  const schema =
    invariant !== undefined &&
    invariant !== null &&
    (typeof invariant === "object" || typeof invariant === "function") &&
    "~standard" in invariant
      ? invariant["~standard"]
      : undefined;
  if (schema !== undefined) {
    if (
      typeof schema !== "object" ||
      schema === null ||
      schema.version !== 1 ||
      typeof schema.vendor !== "string" ||
      typeof schema.validate !== "function"
    ) {
      throw new TypeError("Model invariants must be a Standard Schema v1 schema or a function.");
    }
  } else if (invariant !== undefined && (typeof invariant !== "function" || "~standard" in invariant)) {
    throw new TypeError("Model invariants must be a Standard Schema v1 schema or a function.");
  }
  const methods: Record<string, ModelQuery> = Object.create(null) as Record<string, ModelQuery>;
  for (const [kind, definitions] of [
    ["mutation", options.mutations],
    ["query", options.queries],
  ] as const) {
    if (definitions === undefined) {
      continue;
    }
    if (typeof definitions !== "object" || definitions === null || Array.isArray(definitions)) {
      throw new TypeError(`Model ${kind} definitions must be a named object of functions.`);
    }
    for (const [name, execute] of Object.entries(definitions)) {
      if (name === "name") {
        throw new TypeError(`Model ${kind} 'name' conflicts with the model's diagnostic name.`);
      }
      if (Object.hasOwn(methods, name)) {
        throw new TypeError(`Duplicate model method '${name}': mutation and query names must be distinct.`);
      }
      if (typeof execute !== "function") {
        throw new TypeError(`Invalid model ${kind}: ${name}`);
      }
      if (kind === "query") {
        methods[name] = (...args: never[]) => {
          const value: unknown = execute(...args);
          if (discardedThenable(value)) {
            throw new TypeError("Model queries must be synchronous.");
          }
          return value;
        };
        continue;
      }
      methods[name] = (...args: never[]) =>
        safely(modelName === undefined ? name : `${modelName}.${name}`, () => {
          const changed: unknown = execute(...args);
          requireOutcome(changed);
          if (changed.isError) {
            return changed;
          }
          if (schema !== undefined) {
            const parsed = schema.validate(changed.value);
            if (discardedThenable(parsed)) {
              throw new TypeError("Model schema validation must be synchronous.");
            }
            return parsed.issues === undefined ? success(parsed.value) : failure(ModelValidationError(parsed.issues));
          }
          if (typeof invariant === "function") {
            const checked = invariant(changed.value as never);
            requireOutcome(checked);
            if (checked.isError) {
              return checked;
            }
          }
          return success(changed.value);
        });
    }
  }
  return Object.freeze({ ...(modelName === undefined ? {} : { name: modelName }), ...methods });
}
