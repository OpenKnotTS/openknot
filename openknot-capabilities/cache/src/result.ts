import { hasMarker } from "@openknot-ts/wire/internal/marker";

/** What one cache layer answers for a read: a value, a miss, or no answer for this request. */
export type CacheResult<T> =
  | { readonly kind: "completed"; readonly value: T }
  | { readonly kind: "empty" }
  | { readonly kind: "unsupported" };

const CacheResultMarker = Symbol.for("@openknot-ts/cache/cache-result");

function marked<T extends object>(result: T): T {
  return Object.freeze(Object.defineProperty(result, CacheResultMarker, { value: true }));
}

export function completed<T>(value: T): CacheResult<T> {
  return marked({ kind: "completed" as const, value });
}

const Empty = marked({ kind: "empty" as const });
const Unsupported = marked({ kind: "unsupported" as const });

export function empty(): CacheResult<never> {
  return Empty;
}

export function unsupported(): CacheResult<never> {
  return Unsupported;
}

/** Whether a value was created by `completed`, `empty` or `unsupported`, rather than being a cached value. */
export function isCacheResult(value: unknown): value is CacheResult<unknown> {
  return hasMarker(value, CacheResultMarker);
}

export function asCacheResult(value: unknown): CacheResult<unknown> {
  if (isCacheResult(value)) {
    return value;
  }

  return value === undefined ? empty() : completed(value);
}
