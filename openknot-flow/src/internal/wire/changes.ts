import { unit } from "@openknot-ts/wire";

export type EntityKey = string | number | bigint;

/** A committed change of a managed entity, delivered once per Unit of Work. */
export interface CommittedChange {
  readonly entity: string;
  readonly id: EntityKey;
  readonly type: "set" | "delete";
  readonly state: unknown;
  readonly writer: object | undefined;
}

export interface EntityIdentity {
  readonly entity: string;
  readonly id: EntityKey;
}

/** Follows managed writes from the moment they are recorded until their Unit of Work ends. */
export interface CommitListener {
  /** A Unit of Work recorded its first write of this entity; `settled` follows once that Unit of Work ends. */
  readonly recorded: (identity: EntityIdentity) => void;
  /** Committed changes, after commit hooks and before effects and publications. */
  readonly committed: (changes: readonly CommittedChange[]) => void | PromiseLike<void>;
  /** The Unit of Work that recorded these entities ended, whether it committed or not. */
  readonly settled: (identities: readonly EntityIdentity[]) => void;
}

/** What the managed writes of the current Unit of Work changed, for whatever keeps a view of those entities. */
export interface UnitOfWorkChanges {
  /** Whether the current Unit of Work wrote or deleted a managed entity that appears in `result`. */
  touched(result: unknown): boolean;
  /** Whether the current Unit of Work wrote any entity of this type. */
  wrote(entity: string): boolean;
  /**
   * Runs once the current Unit of Work committed and its changes reached the listeners, before its effects and staged
   * publications; at its end when it rolls back; immediately outside one.
   */
  afterCompletion(effect: (committed: boolean) => void): void;
  subscribe(listener: CommitListener): () => void;
  /** The current Unit of Work as an opaque identity, the same for every nested execution in it; undefined outside one. */
  transaction(): object | undefined;
}

const noUnitOfWork: UnitOfWorkChanges = Object.freeze({
  touched: () => false,
  wrote: () => false,
  afterCompletion: (effect: (committed: boolean) => void) => effect(true),
  subscribe: () => () => undefined,
  transaction: () => undefined,
});

/** An application without Flow definitions has no Unit of Work; Flow's runtime binds this reference otherwise. */
export const unitOfWorkChanges = unit({ factory: (): UnitOfWorkChanges => noUnitOfWork });
