/** A declared deletion carrying an application-defined payload, with no required identity shape. */
export interface Deleted<Payload> {
  readonly changeType: "deleted";
  readonly previous: Payload;
}

/** Change descriptors retain the caller's state and freeze only their own wrapper. */
export function created<State>(next: State): { readonly changeType: "created"; readonly next: State } {
  return Object.freeze({ changeType: "created", next });
}

export function updated<State>(next: State): { readonly changeType: "updated"; readonly next: State } {
  return Object.freeze({ changeType: "updated", next });
}

/** Constructs a descriptor without executing or verifying a deletion. */
export function deleted<Payload>(previous: Payload): Deleted<Payload> {
  return Object.freeze({ changeType: "deleted", previous });
}

export function unchanged<State>(current: State): { readonly changeType: "unchanged"; readonly current: State } {
  return Object.freeze({ changeType: "unchanged", current });
}
