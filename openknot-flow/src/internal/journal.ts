import { UnitOfWorkError } from "../errors.ts";
import type { CommitContext } from "../unit-of-work.ts";
import type { CommittedChange, EntityIdentity } from "./wire/changes.ts";
import { itemsOf, managedIdentity, versionOf } from "@openknot-ts/behavior/internal/managed";

type EntityKey = string | number | bigint;

export interface JournalEntry {
  readonly entity: string;
  readonly id: EntityKey;
  readonly descriptor: object;
  readonly writer: object | undefined;
}

function receiptState(descriptor: unknown): unknown {
  if (typeof descriptor !== "object" || descriptor === null) {
    return undefined;
  }

  const { changeType, next, previous } = descriptor as {
    readonly changeType?: unknown;
    readonly next?: unknown;
    readonly previous?: unknown;
  };

  if (changeType === "upserted") {
    return next;
  }

  if (changeType === "deleted") {
    return previous;
  }

  return undefined;
}

function versioned(state: unknown): boolean {
  return versionOf(state) !== undefined;
}

function requireNextVersion(
  descriptor: unknown,
  state: unknown,
  identity: { readonly entity: string; readonly id: EntityKey },
  args: readonly unknown[],
): void {
  const input = args
    .flatMap((arg) => (Array.isArray(arg) ? arg : [arg]))
    .find((candidate) => {
      const other = managedIdentity(candidate);
      return other?.entity === identity.entity && other.id === identity.id && versioned(candidate);
    }) as { readonly version: number } | undefined;

  if (input === undefined) {
    return;
  }

  const deletion = (descriptor as { readonly changeType: unknown }).changeType === "deleted";
  const expected = deletion ? input.version : input.version + 1;
  const actual = (state as { readonly version: number }).version;

  if (actual !== expected) {
    throw new TypeError(
      `Versioned ${identity.entity} ${String(identity.id)} returned version ${actual}; expected ${expected}`,
    );
  }
}

function isOlder(entry: JournalEntry, current: JournalEntry): boolean {
  const version = versionOf(receiptState(entry.descriptor));
  const latest = versionOf(receiptState(current.descriptor));
  return version !== undefined && latest !== undefined && version < latest;
}

interface WriteToken {
  readonly start: number;
}

/** Receipts of managed entities, keyed by `entity` + `id`; the last receipt per key is the Unit of Work's latest. */
export function createJournal(record?: (identity: EntityIdentity) => void) {
  const entries = new Map<string, Map<EntityKey, JournalEntry>>();
  const receipts = new WeakMap<object, JournalEntry>();
  const failures: unknown[] = [];
  const recordFailures: unknown[] = [];
  const inflight = new Set<Promise<unknown>>();
  let sequence = 0;
  const running = new Set<WriteToken>();
  const finished: { readonly end: number; readonly keys: readonly string[] }[] = [];

  const committed: CommitContext = Object.freeze({
    latest(receipt: object): never {
      const original = receipts.get(receipt);
      if (original === undefined) {
        throw UnitOfWorkError("latest() requires a persistence receipt from this Unit of Work");
      }
      return entries.get(original.entity)!.get(original.id)!.descriptor as never;
    },
  });

  function begin(): WriteToken {
    const token = { start: ++sequence };
    running.add(token);
    return token;
  }

  function settle(token: WriteToken): void {
    running.delete(token);
    let oldest = Infinity;
    for (const other of running) {
      oldest = Math.min(oldest, other.start);
    }
    for (let index = finished.length - 1; index >= 0; index--) {
      if (finished[index]!.end < oldest) {
        finished.splice(index, 1);
      }
    }
  }

  /** Records the receipts of one write; unversioned entities written by overlapping writes fail the Unit of Work. */
  function finish(token: WriteToken, result: unknown, args: readonly unknown[], writer?: object): boolean {
    const batch: readonly unknown[] = Array.isArray(result) ? result : [result];
    const recorded: JournalEntry[] = [];
    const unversioned: string[] = [];
    const overlaps = running.size > 1 || finished.length > 0;
    let managed = false;

    for (const descriptor of batch) {
      const state = receiptState(descriptor);
      const identity = managedIdentity(state);
      managed ||= identity !== undefined;

      if (identity === undefined || receipts.has(descriptor as object)) {
        continue;
      }

      if (versioned(state)) {
        requireNextVersion(descriptor, state, identity, args);
      }

      if (overlaps && !versioned(state)) {
        unversioned.push(JSON.stringify([identity.entity, typeof identity.id, String(identity.id)]));
      }

      recorded.push({ entity: identity.entity, id: identity.id, descriptor: descriptor as object, writer });
    }

    const conflict = finished.some(
      (other) => other.end > token.start && other.keys.some((key) => unversioned.includes(key)),
    );

    const end = ++sequence;
    if (overlaps) {
      finished.push({ end, keys: unversioned });
    }

    settle(token);

    if (conflict) {
      throw UnitOfWorkError("Overlapping writes produced the same unversioned entity");
    }

    for (const entry of recorded) {
      let changes = entries.get(entry.entity);
      if (changes === undefined) {
        changes = new Map();
        entries.set(entry.entity, changes);
      }

      const current = changes.get(entry.id);

      if (current === undefined) {
        try {
          record?.({ entity: entry.entity, id: entry.id });
        } catch (error) {
          recordFailures.push(error);
        }
      }

      // Overlapping versioned writes may finish out of order: the higher version is the entity's latest.
      if (current === undefined || !isOlder(entry, current)) {
        changes.set(entry.id, entry);
      }

      receipts.set(entry.descriptor, entry);
    }

    return managed;
  }

  function changes(): CommittedChange[] {
    return [...entries.values()].flatMap((byId) =>
      [...byId.values()].map((entry): CommittedChange => {
        const deletion = (entry.descriptor as { readonly changeType: unknown }).changeType === "deleted";
        return Object.freeze({
          entity: entry.entity,
          id: entry.id,
          type: deletion ? "delete" : "set",
          state: receiptState(entry.descriptor),
          writer: entry.writer,
        });
      }),
    );
  }

  function touched(result: unknown): boolean {
    const items = itemsOf(result);
    return items.some((item) => {
      const identity = managedIdentity(item);
      return identity !== undefined && (entries.get(identity.entity)?.has(identity.id) ?? false);
    });
  }

  const wrote = (entity: string) => (entries.get(entity)?.size ?? 0) > 0;
  const identities = (): EntityIdentity[] =>
    [...entries.values()].flatMap((byId) => [...byId.values()].map(({ entity, id }) => ({ entity, id })));

  return {
    entries,
    failures,
    recordFailures,
    inflight,
    committed,
    begin,
    finish,
    settle,
    changes,
    touched,
    wrote,
    identities,
  };
}
export type Journal = ReturnType<typeof createJournal>;
