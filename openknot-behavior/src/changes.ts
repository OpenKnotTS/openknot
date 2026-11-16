/** A declared creation carrying the new state. */
export interface Created<State> {
  readonly changeType: "created";
  readonly next: State;
}

/** A declared update carrying the new state. */
export interface Updated<State> {
  readonly changeType: "updated";
  readonly next: State;
}

/** A declared deletion carrying an application-defined payload, with no required identity shape. */
export interface Deleted<Payload> {
  readonly changeType: "deleted";
  readonly previous: Payload;
}

/** A declared no-op carrying the current state. */
export interface Unchanged<State> {
  readonly changeType: "unchanged";
  readonly current: State;
}

/** Change descriptors retain the caller's state and freeze only their own wrapper. */
export function created<State>(next: State): Created<State> {
  return Object.freeze({ changeType: "created", next });
}

export function updated<State>(next: State): Updated<State> {
  return Object.freeze({ changeType: "updated", next });
}

/** Constructs a descriptor without executing or verifying a deletion. */
export function deleted<Payload>(previous: Payload): Deleted<Payload> {
  return Object.freeze({ changeType: "deleted", previous });
}

export function unchanged<State>(current: State): Unchanged<State> {
  return Object.freeze({ changeType: "unchanged", current });
}
