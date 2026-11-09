export interface Success<T> {
  readonly isError: false;
  readonly value: T;
}

export interface Failure<E extends Error> {
  readonly isError: true;
  readonly error: E;
}

export type Outcome<T, E extends Error = never> = Success<T> | Failure<E>;
export type SuccessOf<T> = T extends Success<infer Value> ? Value : never;
export type ErrorOf<T> = T extends Failure<infer E> ? E : never;

export function success(): Success<void>;
export function success<T>(value: T): Success<T>;
export function success<T>(value?: T): Success<T | undefined> {
  return Object.freeze({ isError: false, value });
}

export function failure<E extends Error>(error: E): Failure<E> {
  if (!(error instanceof Error)) {
    throw new TypeError("failure() requires an Error instance.");
  }
  return Object.freeze({ isError: true, error });
}

export function isOutcome(value: unknown): value is Outcome<unknown, Error> {
  if (typeof value !== "object" || value === null || !("isError" in value)) {
    return false;
  }
  return value.isError === false
    ? "value" in value
    : value.isError === true && "error" in value && value.error instanceof Error;
}
