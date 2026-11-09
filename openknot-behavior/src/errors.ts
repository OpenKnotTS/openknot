import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * What a describer returns: the message and cause, plus the error's own readonly fields. `name`, `stack` and `type`
 * belong to the error itself: its type names it, discriminates it and heads its stack.
 */
export interface ErrorDescription {
  readonly message?: string;
  readonly cause?: unknown;
  readonly name?: never;
  readonly stack?: never;
  readonly type?: never;
}

const reserved = ["name", "stack", "type"] as const;

type NoFields = Readonly<Record<never, never>>;

/** A frozen, real Error with a literal type discriminator and its described fields. */
export type TypedError<Type extends string, Fields = NoFields> = Readonly<
  Error & { readonly type: Type } & Omit<Fields, "message" | "cause">
>;

export interface ErrorFactory<Type extends string, Args extends readonly unknown[], Fields> {
  (...args: Args): TypedError<Type, Fields>;
  readonly type: Type;
  /** Narrows unknown values, such as caught errors, by their type; works across copies of a package. */
  is(value: unknown): value is TypedError<Type, Fields>;
}

/** Engines that support it (Node, Bun, Deno) start the stack at the caller instead of the factory. */
const captureStackTrace = (
  Error as { readonly captureStackTrace?: (target: object, constructor?: (...args: never[]) => unknown) => void }
).captureStackTrace;

/** error("AccessDenied") creates errors from (message?, options?); a describer defines other arguments and fields. */
export function error<const Type extends string>(
  type: Type,
): ErrorFactory<Type, [message?: string, options?: ErrorOptions], NoFields>;

export function error<
  const Type extends string,
  Args extends readonly unknown[],
  const Fields extends ErrorDescription,
>(type: Type, describe: (...args: Args) => Fields): ErrorFactory<Type, Args, Fields>;

export function error(
  type: string,
  describe?: (...args: never[]) => ErrorDescription,
): ErrorFactory<string, readonly unknown[], ErrorDescription> {
  if (typeof type !== "string" || type.length === 0) {
    throw new TypeError("error() requires a non-empty type.");
  }

  if (describe !== undefined && typeof describe !== "function") {
    throw new TypeError("error() describe must be a function.");
  }

  function create(...args: unknown[]): TypedError<string, ErrorDescription> {
    const description: ErrorDescription =
      describe === undefined ? describeMessage(args) : describe(...(args as never[]));
    const { message, cause, ...fields } = description;
    for (const key of reserved) {
      if (key in fields) {
        throw new TypeError(`error("${type}") field '${key}' is reserved; name the field differently.`);
      }
    }
    const instance = new Error(message ?? type, "cause" in description ? { cause } : undefined);
    Object.defineProperty(instance, "name", { value: type });
    captureStackTrace?.(instance, create);
    return Object.freeze(Object.assign(instance, fields, { type }));
  }

  return Object.freeze(
    Object.assign(create, {
      type,
      is: (value: unknown): value is TypedError<string, ErrorDescription> =>
        typeof value === "object" && value !== null && "type" in value && value.type === type,
    }),
  );
}

function describeMessage(args: readonly unknown[]): ErrorDescription {
  const [message, options] = args as readonly [string | undefined, ErrorOptions | undefined];
  return {
    ...(message === undefined ? {} : { message }),
    ...(options !== undefined && "cause" in options ? { cause: options.cause } : {}),
  };
}

export const InternalBehaviorError = error("InternalBehaviorError", (cause: unknown, boundary: string) => ({
  message: `Unexpected behavior failure in ${boundary}`,
  cause,
  boundary,
}));

export interface InternalBehaviorError extends ReturnType<typeof InternalBehaviorError> {}

/** Definition and binding errors are startup errors, outside operation execution. */
export const BehaviorBindingError = error("BehaviorBindingError");
export interface BehaviorBindingError extends ReturnType<typeof BehaviorBindingError> {}

/** Expected model validation failure, independent of the schema library. */
export const ModelValidationError = error("ModelValidationError", (issues: readonly StandardSchemaV1.Issue[]) => ({
  message: issues.map((issue) => issue.message).join("; ") || "Model state failed schema validation.",
  issues: Object.freeze([...issues]),
}));

export interface ModelValidationError extends ReturnType<typeof ModelValidationError> {}
