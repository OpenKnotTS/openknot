import type { Publish, Publisher } from "@openknot-ts/flow";
import { isPublisher } from "@openknot-ts/flow";
import { transactional, unitOfWorkChanges } from "@openknot-ts/flow/wire";
import type { Logger } from "@openknot-ts/logging";
import { logger } from "@openknot-ts/logging/wire";
import type { PropagationCarrier, Tracing } from "@openknot-ts/tracing";
import { trace } from "@openknot-ts/tracing/wire";
import type { ConnectionWatch, Plug, Requirement, Requirements, ResolvedReferences } from "@openknot-ts/wire";
import { optional, plug, resource, unit } from "@openknot-ts/wire";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/** A publication stored with its change: `id` is also the message identity consumers receive. */
export interface OutboxRecord {
  readonly id: string;
  readonly name: string;
  readonly message: unknown;
  readonly propagation?: PropagationCarrier | undefined;
}

/** A record whose sends keep failing; it holds back the later records of its name until delivered or discarded. */
export interface StuckRecord {
  readonly id: string;
  readonly name: string;
  readonly attempts: number;
  readonly error: string | undefined;
}

/** Durable storage for outbox records, implemented by a store plug over the application's database. */
export interface OutboxStore {
  /** Stores records in the current Unit of Work's native transaction, and rejects outside one. */
  save(records: readonly OutboxRecord[]): Promise<void>;
  /**
   * Claims up to `limit` of the oldest records of a name for an owner, in insertion order, unless another owner holds
   * an unexpired claim on that name. Claims expire by the database's clock.
   */
  claim(name: string, owner: string, limit: number): Promise<readonly OutboxRecord[]>;
  /**
   * Extends the owner's claim on these records by a full lease, by the database's clock. False when any of them is no
   * longer claimed by that owner, as when its lease ended and another owner took the name over.
   */
  renew(ids: readonly string[], owner: string): Promise<boolean>;
  /** Milliseconds until another owner's claim on the name ends, by the database's clock; undefined when none holds it. */
  heldFor(name: string, owner: string): Promise<number | undefined>;
  /** Removes delivered records. */
  complete(ids: readonly string[]): Promise<void>;
  /** Records a failed send and releases the owner's claim; a record another owner took over is left untouched. */
  attempted(id: string, owner: string, error: string): Promise<void>;
  /** Releases the owner's claims without counting an attempt; claims of other owners are left untouched. */
  release(ids: readonly string[], owner: string): Promise<void>;
  /** Records with at least `attempts` failed sends, of one name or all. */
  stuck(attempts: number, name?: string): Promise<readonly StuckRecord[]>;
  /** Removes a record without delivering it. */
  discard(id: string): Promise<void>;
}

export const outboxStore = unit.contract<OutboxStore>();

/** Operations on undelivered records: what is stuck, discarding one, and delivering a name again now. */
export interface OutboxControl {
  stuck(attempts: number, name?: string): Promise<readonly StuckRecord[]>;
  discard(id: string): Promise<void>;
  deliver(name: string): void;
}

interface Dispatchers {
  register(name: string, deliver: () => void): void;
  deliver(name: string): void;
}

const dispatchers = unit({
  factory: (): Dispatchers => {
    const names = new Map<string, () => void>();
    return Object.freeze({
      register(name: string, deliver: () => void) {
        if (names.has(name)) {
          throw new TypeError(`outbox() name '${name}' is declared more than once.`);
        }
        names.set(name, deliver);
      },
      deliver(name: string) {
        names.get(name)?.();
      },
    });
  },
});

export const outboxControl = unit({
  requirements: { store: outboxStore, dispatchers },
  factory: ({ store, dispatchers }): OutboxControl =>
    Object.freeze({
      stuck: (attempts: number, name?: string) => store.stuck(attempts, name),
      discard: (id: string) => store.discard(id),
      deliver: (name: string) => dispatchers.deliver(name),
    }),
});

type ResolvesConnection<C extends Requirement> = ResolvedReferences<{
  readonly connection: C;
}>["connection"] extends ConnectionWatch
  ? C
  : never;

const reserved = ["outboxStore", "outboxTracing", "outboxLogger", "outboxDispatchers", "outboxConnection"];

export interface OutboxOptions<M, R extends Requirements, C extends Requirement = never> {
  /** Stable across deployments: a stored record finds its publisher by this name after a restart. */
  readonly name: string;
  /** The native publisher plug; the application lists `outbox()` in its place. */
  readonly plug: Plug<Publisher<M>, R>;
  /** Records claimed per round trip. Defaults to 100. */
  readonly batchSize?: number;
  /** The native publisher's connection, such as `rabbitConnection`: records left undelivered leave once it is restored. */
  readonly connection?: ResolvesConnection<C>;
}

function jsonRoundTrip(message: unknown): unknown {
  // JSON.stringify writes NaN and Infinity as null, so the sent message would differ from the published one.
  const json = JSON.stringify(message, (_key, value: unknown) => {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("Outbox publications must be JSON values");
    }
    return value;
  });
  if (json === undefined) {
    throw new TypeError("Outbox publications must be JSON values");
  }
  return JSON.parse(json);
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Stores a port's publications with the change that published them and delivers them through the native plug after
 * commit, at least once and in order per name. The application lists `outbox()` in place of the native plug.
 */
export function outbox<M, R extends Requirements, C extends Requirement = never>(options: OutboxOptions<M, R, C>) {
  const { name, plug: native, batchSize = 100, connection } = options;

  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("outbox() requires a name.");
  }
  if (!isPublisher(native?.port)) {
    throw new TypeError("outbox() requires a publisher plug.");
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new TypeError("outbox() batchSize must be a positive integer.");
  }
  for (const key of reserved) {
    if (key in native.requirements) {
      throw new TypeError(`outbox() plug requirement '${key}' is reserved.`);
    }
  }

  const dispatcher = resource({
    requirements: {
      ...native.requirements,
      outboxStore,
      outboxTracing: optional(trace),
      outboxLogger: logger,
      outboxDispatchers: dispatchers,
      ...(connection === undefined ? {} : { outboxConnection: connection }),
    } as Requirements,
    async initialize(dependencies) {
      const {
        outboxStore: store,
        outboxTracing: tracing,
        outboxLogger: log,
        outboxDispatchers: registry,
        outboxConnection: watched,
        ...requirements
      } = dependencies as Readonly<Record<string, unknown>> & {
        readonly outboxStore: OutboxStore;
        readonly outboxTracing: Tracing | undefined;
        readonly outboxLogger: Logger;
        readonly outboxDispatchers: Dispatchers;
        readonly outboxConnection?: ConnectionWatch;
      };
      const send = (native.bind as (context: object) => Publish<unknown>)(Object.freeze(requirements));
      const owner = randomUUID();
      // Deliveries start from commits; they run in the dispatcher's own context, not in the request that committed.
      const detached = AsyncLocalStorage.snapshot();
      let running: Promise<void> | undefined;
      let again = false;
      let stopping = false;
      let expiry: ReturnType<typeof setTimeout> | undefined;

      /** Sends the name's records in order until none is left, a send fails or the application stops. */
      async function drain(): Promise<void> {
        for (let first = true; ; first = false) {
          const records = await store.claim(name, owner, batchSize);
          if (records.length === 0) {
            if (first) {
              await awaitLease();
            }
            return;
          }
          for (const [index, record] of records.entries()) {
            if (stopping) {
              await store.release(
                records.slice(index).map((each) => each.id),
                owner,
              );
              return;
            }
            // A batch can outlast its lease; once another owner holds the name, its records are no longer ours to send.
            if (
              !(await store.renew(
                records.slice(index).map((each) => each.id),
                owner,
              ))
            ) {
              return;
            }
            try {
              await send(
                record.message,
                Object.freeze({
                  messageId: record.id,
                  ...(record.propagation === undefined ? {} : { propagation: record.propagation }),
                  ...(tracing === undefined ? {} : { tracing }),
                }),
              );
            } catch (error) {
              log.warn("outbox send failed", { name, recordId: record.id, error });
              await store.attempted(record.id, owner, describe(error));
              await store.release(
                records.slice(index + 1).map((each) => each.id),
                owner,
              );
              return;
            }
            await store.complete([record.id]);
          }
        }
      }

      /**
       * Another owner holds the name, such as an instance that crashed while sending: delivery resumes once its lease
       * ends. The lease's native expiry is the only time this dispatcher follows.
       */
      async function awaitLease(): Promise<void> {
        const held = await store.heldFor(name, owner);
        if (held !== undefined && !stopping) {
          clearTimeout(expiry);
          expiry = setTimeout(deliver, held + 1);
        }
      }

      function deliver(): void {
        if (stopping) {
          return;
        }
        if (running !== undefined) {
          again = true;
          return;
        }
        // A request that arrives during a round, a failed one included, gets one more round, so none is lost.
        running = detached(async () => {
          do {
            again = false;
            await drain();
          } while (again && !stopping);
        })
          .catch((error: unknown) => log.error("outbox delivery failed", { name, error }))
          .finally(() => {
            running = undefined;
          });
      }

      registry.register(name, deliver);
      const unwatch = watched?.watch({ lost: () => undefined, restored: deliver });
      // Records a previous run left undelivered leave now, without waiting for new traffic.
      deliver();

      return {
        value: Object.freeze({ deliver }),
        async release() {
          stopping = true;
          unwatch?.();
          clearTimeout(expiry);
          await running;
        },
      };
    },
  });

  return plug({
    port: native.port,
    requirements: { dispatcher, store: outboxStore, changes: unitOfWorkChanges },
    bind: ({ dispatcher, store, changes }) =>
      transactional(async (message: M, options) => {
        if (changes.transaction() === undefined) {
          throw new TypeError(`outbox() '${name}' publications require a Unit of Work.`);
        }
        await store.save([
          Object.freeze({
            id: randomUUID(),
            name,
            message: jsonRoundTrip(message),
            ...(options.propagation === undefined ? {} : { propagation: options.propagation }),
          }),
        ]);
        changes.afterCompletion((committed) => {
          if (committed) {
            dispatcher.deliver();
          }
        });
      }),
  });
}
