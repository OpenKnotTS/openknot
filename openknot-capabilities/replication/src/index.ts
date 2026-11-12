import type { ReaderComposition, ReaderDefinition, ReaderFunction } from "@openknot-ts/behavior";
import { error, isReader, isReaderComposition } from "@openknot-ts/behavior";
import { managedIdentity, isList, itemsOf, versionOf } from "@openknot-ts/behavior/internal/managed";
import type { CacheChange, CacheOrder, CacheMemberReads, CacheResult, PortEntity, PortState } from "@openknot-ts/cache";
import type { LayerStop } from "@openknot-ts/cache/layers";
import { isAsyncIterable, keyOf, layered, layerStartup, storeWaits } from "@openknot-ts/cache/layers";
import { asCacheResult } from "@openknot-ts/cache/result";
import type { ErrorReporter } from "@openknot-ts/error-reporting";
import { reportError } from "@openknot-ts/error-reporting";
import { errorReporter } from "@openknot-ts/error-reporting/wire";
import type { CommittedChange, EntityKey, UnitOfWorkChanges } from "@openknot-ts/flow/wire";
import { unitOfWorkChanges } from "@openknot-ts/flow/wire";
import type { HealthCheckDefinition } from "@openknot-ts/health";
import { healthCheck } from "@openknot-ts/health";
import type { Lock } from "@openknot-ts/lock";
import { lock } from "@openknot-ts/lock/wire";
import type { Tracing } from "@openknot-ts/tracing";
import { withTrace } from "@openknot-ts/tracing";
import { trace } from "@openknot-ts/tracing/wire";
import type {
  Decoration,
  Plug,
  PlugDefinition,
  Provider,
  Requirements,
  ResolvedReferences,
  ConnectionWatch,
} from "@openknot-ts/wire";
import { decorate, isPlug, optional, unit } from "@openknot-ts/wire";
import { isThenable } from "@openknot-ts/wire/internal/synchronous";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/** One state or tombstone of the shared store; a `delete` keeps its order as a tombstone. */
export interface ReplicaChange {
  readonly entity: string;
  readonly id: EntityKey;
  readonly order: CacheOrder;
  readonly type: "set" | "delete";
  readonly value?: unknown;
}

export interface ReplicaMarker {
  readonly state: "loading" | "complete";
  readonly dirty: boolean;
  readonly runId: string;
  readonly holder?: string;
}

export const ReplicaFenced = error("ReplicaFenced", (keyspace: string) => ({
  message: `Keyspace ${keyspace} has a newer hydration holder`,
  keyspace,
}));
export interface ReplicaFenced extends ReturnType<typeof ReplicaFenced> {}

/** The shared store of replications; a plug implements each operation atomically. */
export interface ReplicaStore {
  readonly connection?: ConnectionWatch;
  /** Identifies the store's current run; it changes when the store restarts without its contents. */
  runId(): Promise<string>;
  marker(keyspace: string): Promise<ReplicaMarker | undefined>;
  /**
   * With a fence, writes only while the stored marker's holder equals it, otherwise rejects with ReplicaFenced.
   * An unfenced mark without a holder keeps the stored holder.
   */
  mark(keyspace: string, marker: ReplicaMarker, fence?: string): Promise<void>;
  /**
   * Stores each change whose order is newer than the stored state or tombstone, and a delete of the stored state's own
   * order; returns the stored ones. With a fence, writes only while the stored marker's holder equals it,
   * otherwise rejects with ReplicaFenced.
   */
  apply(keyspace: string, changes: readonly ReplicaChange[], fence?: string): Promise<readonly ReplicaChange[]>;
  /**
   * Removes states and tombstones but keeps the marker. Writes only while the stored marker's holder equals
   * the fence, otherwise rejects with ReplicaFenced.
   */
  clear(keyspace: string, fence: string): Promise<void>;
  /** The stored state, or undefined for a missing or deleted entity. */
  get(keyspace: string, entity: string, id: EntityKey): Promise<unknown>;
  list(keyspace: string, entity: string): Promise<readonly unknown[]>;
  /** Removes a keyspace with its marker and tombstones. */
  drop(keyspace: string): Promise<void>;
}

export type ReplicationMessage =
  | {
      readonly type: "changes";
      readonly origin: string;
      readonly keyspace: string;
      readonly changes: readonly Omit<ReplicaChange, "value">[];
    }
  | { readonly type: "clear" | "ready"; readonly origin: string; readonly keyspace: string };

export interface ReplicationHandlers {
  message(message: ReplicationMessage): void;
  /** The native subscription is lost; messages may be missed until `restored`. */
  lost(): void;
  restored(): void;
}

export interface ReplicationChannel {
  /** Resolves once the subscription receives messages. */
  subscribe(handlers: ReplicationHandlers): Promise<{ close(): Promise<void> }>;
  publish(message: ReplicationMessage): Promise<void>;
}

export const replicaStore = unit.contract<ReplicaStore>();
export const replicationChannel = unit.contract<ReplicationChannel>();

/** The distributed layer's typed reads of its keyspace. */
export interface ReplicaView {
  get(id: EntityKey): Promise<unknown>;
  list(): Promise<readonly unknown[]>;
}

const SectionMarker = Symbol.for("@openknot-ts/replication/section");

export interface InstanceOptions<P extends ReaderDefinition | ReaderComposition, R extends Requirements> {
  readonly requirements?: R;
  readonly port: P;
  readonly persist: (
    dependencies: ResolvedReferences<R>,
  ) => (changes: readonly CacheChange[]) => void | PromiseLike<void>;
  readonly bind: (dependencies: ResolvedReferences<R>) => CacheMemberReads<P>;
  readonly include?: (dependencies: ResolvedReferences<R>) => (state: unknown) => boolean;
}

export interface DistributedOptionsBase<P extends ReaderDefinition | ReaderComposition> {
  readonly entity: PortEntity<P>;
  readonly port: P;
  readonly namespace: string;
  /** Bump it by one when the stored shape, mapping or codec changes; instances on an older revision read the source. */
  readonly revision?: number;
  /** A reader of the source, called without arguments, that returns every state. */
  readonly load: ReaderDefinition;
  readonly startup?: "background" | "blocking";
  readonly include?: (state: unknown) => boolean;
  /** Reads per member; a `byId` member reads `store.get` by default. */
  readonly bind?: (view: { readonly store: ReplicaView }) => CacheMemberReads<P>;
  /** Bounds a hydration whose holder crashed; defaults to one minute. */
  readonly leaseMs?: number;
}

export type DistributedOptions<P extends ReaderDefinition | ReaderComposition> = DistributedOptionsBase<P> &
  ([PortState<P>] extends [{ readonly version: number }]
    ? { readonly order?: (state: PortState<P>) => CacheOrder }
    : { readonly order: (state: PortState<P>) => CacheOrder });

export interface InstanceSection {
  readonly [SectionMarker]: "instance";
  readonly options: InstanceOptions<ReaderDefinition | ReaderComposition, Requirements>;
}

export interface DistributedSection {
  readonly [SectionMarker]: "distributed";
  readonly options: DistributedOptionsBase<ReaderDefinition | ReaderComposition> & {
    readonly order?: (state: unknown) => CacheOrder;
  };
}

type ReplicationContracts = {
  readonly __replicaStore: typeof replicaStore;
  readonly __replicationChannel: typeof replicationChannel;
  readonly __lock: typeof lock;
};

type SourceOf<T> = Extract<T[keyof T], Plug<object, Requirements>>;

/** The source plug, the decorations of its readers and the replication's own definitions; list it in a module. */
export type Replication<S> =
  S extends Plug<infer P, infer R>
    ? Readonly<Record<string, Decoration | PlugDefinition | Provider<unknown, never, "unit" | "resource">>> & {
        readonly source: Plug<P, R & ReplicationContracts>;
        /** Rebuilds the shared keyspace from the source, under the lock. */
        readonly rebuild: Provider<() => Promise<void>, never, "unit">;
        readonly health: HealthCheckDefinition<Requirements>;
      }
    : never;

interface Instance {
  disabledAll: boolean;
  /** A reload or refresh failed and the next read or commit reloads it. */
  failed: boolean;
  /** Invalidates in-flight answers across a refresh enabling a key, a reload or a clear. */
  changes: number;
  readonly disabled: Set<string>;
  readonly read: Readonly<Record<string, ((...args: never[]) => unknown) | undefined>>;
  disable(ids: readonly EntityKey[]): void;
  refresh(ids: readonly EntityKey[]): void;
  reload(): Promise<void>;
  clear(): void;
}

interface Checked {
  /** The marker, when it shows the keyspace is current for this store run. */
  readonly current: ReplicaMarker | undefined;
  readonly runId: string;
  /** The instance reload that a verified readiness started. */
  readonly reload?: Promise<void> | undefined;
}

interface Replica {
  /** The marker that made reads answer from the store, a new object per readiness; undefined while they go to the source. */
  ready: ReplicaMarker | undefined;
  superseded: boolean;
  suspended: boolean;
  healthy: boolean;
  readonly instance: Instance | undefined;
  readonly read: Readonly<Record<string, ((...args: never[]) => unknown) | undefined>>;
  lose(error: unknown): void;
  generation(): number;
  confirm(verified: ReplicaMarker, started: number): Promise<boolean>;
  recheck(): void;
  start(
    load: () => unknown,
    byId: ((id: EntityKey) => unknown) | undefined,
  ): Promise<{ first: Promise<void>; stop: LayerStop }>;
  rebuild(): Promise<void>;
  flushBacklog(): void;
  untilLost<T>(work: Promise<T>): Promise<T | undefined>;
}

function isCurrent(marker: ReplicaMarker | undefined, runId: string): marker is ReplicaMarker {
  return marker !== undefined && marker.state === "complete" && !marker.dirty && marker.runId === runId;
}

function readersOf(port: ReaderDefinition | ReaderComposition): readonly ReaderDefinition[] {
  return isReaderComposition(port) ? Object.values(port.members) : [port];
}

function membersOf(port: ReaderDefinition | ReaderComposition): Readonly<Record<string, ReaderDefinition>> {
  return isReaderComposition(port) ? port.members : { value: port };
}

function isReaderPlug(
  value: unknown,
): value is PlugDefinition & { readonly port: ReaderDefinition | ReaderComposition } {
  return isPlug(value) && (isReader(value.port) || isReaderComposition(value.port));
}

function section(value: unknown): "instance" | "distributed" | undefined {
  return typeof value === "object" && value !== null
    ? (Reflect.get(value, SectionMarker) as "instance" | "distributed" | undefined)
    : undefined;
}

function instanceSection<const P extends ReaderDefinition | ReaderComposition, const R extends Requirements = {}>(
  options: InstanceOptions<P, R>,
): InstanceSection {
  return Object.freeze({ [SectionMarker]: "instance" as const, options: options as InstanceSection["options"] });
}

function distributedSection<const P extends ReaderDefinition | ReaderComposition>(
  options: DistributedOptions<P>,
): DistributedSection {
  if (typeof options.namespace !== "string" || options.namespace.length === 0) {
    throw new TypeError("A distributed replication layer requires a namespace");
  }

  const entity: unknown = options.entity;

  if (typeof entity !== "string" || entity.length === 0) {
    throw new TypeError("A distributed replication layer names the entity it replicates");
  }

  const revision = options.revision ?? 1;

  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new TypeError("A replication revision is a positive integer");
  }

  if (!isReader(options.load)) {
    throw new TypeError("A replication loads through a reader of its source");
  }

  return Object.freeze({
    [SectionMarker]: "distributed" as const,
    options: options as unknown as DistributedSection["options"],
  });
}

function compose<const T extends Readonly<Record<string, unknown>>>(parts: T): Replication<SourceOf<T>> {
  const values = Object.values(parts);
  const sources = values.filter(isReaderPlug);
  const instances = values.filter((value): value is InstanceSection => section(value) === "instance");
  const shared = values.filter((value): value is DistributedSection => section(value) === "distributed");

  if (sources.length !== 1) {
    throw new TypeError("A replication has exactly one source reader plug");
  }

  if (shared.length !== 1) {
    throw new TypeError("A replication has exactly one distributed layer");
  }

  if (instances.length > 1) {
    throw new TypeError("A replication has at most one instance layer");
  }

  if (values.length !== sources.length + instances.length + shared.length) {
    throw new TypeError("A replication lists only its source plug, instance layer and distributed layer");
  }

  const source = sources[0]!;
  const distributed = shared[0]!.options;
  const local = instances[0]?.options;

  const sourceReaders = new Set(readersOf(source.port));

  for (const port of [distributed.port, ...(local === undefined ? [] : [local.port])]) {
    if (!readersOf(port).every((reader) => sourceReaders.has(reader))) {
      throw new TypeError("A replication layer only answers readers of its source");
    }
  }

  if (!sourceReaders.has(distributed.load)) {
    throw new TypeError("A replication loads through a reader of its source");
  }

  const entity = distributed.entity as string;
  const namespace = distributed.namespace;
  const revision = distributed.revision ?? 1;
  const keyspace = `${namespace}:v${revision}`;

  const revisionOf = (other: string): number | undefined => {
    const match = other.startsWith(`${namespace}:v`) ? /^(\d+)$/.exec(other.slice(namespace.length + 2)) : null;
    return match === null ? undefined : Number(match[1]);
  };

  const order: (state: unknown) => CacheOrder | undefined = distributed.order ?? versionOf;
  const includeShared = distributed.include ?? (() => true);

  const leaseMs = distributed.leaseMs ?? 60_000;
  const sharedMembers = membersOf(distributed.port);
  const localMembers = local === undefined ? {} : membersOf(local.port);
  // The instance layer loads from the shared layer, so an include on either leaves it with a subset.
  const partialInstance = local?.include !== undefined || distributed.include !== undefined;

  function createInstance(
    dependencies: ResolvedReferences<Requirements>,
    view: ReplicaView,
    report: (error: unknown) => void,
    outside: <T>(work: () => T) => T,
  ): Instance | undefined {
    if (local === undefined) {
      return undefined;
    }

    const persist = local.persist(dependencies);
    const include = local.include?.(dependencies) ?? (() => true);

    const refreshing = new Map<string, number>();
    const ids = new Map<string, EntityKey>();

    let generation = 0;
    let epoch = 0;

    async function refreshOne(id: EntityKey): Promise<void> {
      const key = keyOf(id);
      instance.disable([id]);
      const own = ++generation;
      const started = epoch;
      refreshing.set(key, own);

      // The most recently started refresh of a key wins; an older one that completes later is discarded.
      const current = () => refreshing.get(key) === own && epoch === started;

      try {
        const value = await view.get(id);

        if (!current()) {
          return;
        }

        await persist([
          value !== undefined && include(value) ? { type: "set", key: id, value } : { type: "delete", key: id },
        ]);

        if (!current()) {
          return;
        }

        refreshing.delete(key);

        // A reload in flight may answer with an older list, so the key stays disabled for its last pass to refresh.
        if (instance.disabledAll) {
          return;
        }

        instance.changes++;
        instance.disabled.delete(key);
        ids.delete(key);
      } catch (error) {
        if (refreshing.get(key) === own) {
          refreshing.delete(key);
        }

        instance.failed = true;

        report(error);
      }
    }

    const instance: Instance = {
      disabledAll: true,
      failed: false,
      changes: 0,
      disabled: new Set(),
      read: local.bind(dependencies) as Instance["read"],
      disable(list) {
        for (const id of list) {
          ids.set(keyOf(id), id);
          instance.disabled.add(keyOf(id));
        }
      },
      refresh(ids) {
        outside(() => {
          for (const id of ids) {
            void refreshOne(id);
          }
        });
      },
      async reload() {
        const started = ++epoch;
        instance.changes++;
        instance.disabledAll = true;
        instance.failed = false;
        try {
          await persist([{ type: "clear" }]);

          if (epoch !== started) {
            return;
          }

          const values = await view.list();

          if (epoch !== started) {
            return;
          }

          const changes: CacheChange[] = [];

          for (const value of values) {
            const own = managedIdentity(value);

            if (own !== undefined && include(value)) {
              changes.push({ type: "set", key: own.id, value });
            }
          }

          await persist(changes);

          if (epoch !== started) {
            return;
          }

          instance.disabledAll = false;
          // Keys committed while the list was read may hold older states; they stay disabled until refreshed.
          instance.refresh([...instance.disabled].flatMap((key) => (ids.has(key) ? [ids.get(key)!] : [])));
        } catch (error) {
          instance.failed = true;
          report(error);
        }
      },
      clear() {
        outside(() => {
          epoch++;
          instance.disabledAll = true;
          instance.changes++;

          refreshing.clear();
          instance.disabled.clear();
          ids.clear();

          try {
            const pending = persist([{ type: "clear" }]);

            if (pending !== undefined) {
              pending.then(undefined, report);
            }
          } catch (error) {
            report(error);
          }
        });
      },
    };
    return instance;
  }

  function createReplica(
    context: UnitOfWorkChanges,
    store: ReplicaStore,
    channel: ReplicationChannel,
    locks: Lock,
    tracing: Tracing | undefined,
    reporter: ErrorReporter | undefined,
    dependencies: ResolvedReferences<Requirements>,
  ): Replica {
    const origin = randomUUID();
    // Captures the context of application startup, including its tracing context.
    // Start the application outside transactions; background work and its continuations retain this context.
    const outside = AsyncLocalStorage.snapshot();

    const view: ReplicaView = {
      get: (id) => store.get(keyspace, entity, id),
      list: () => store.list(keyspace, entity),
    };

    let dirty = false;
    /** Counts what outdates a marker reply: a clear, a ready, a lost or restored connection, an own hydration. */
    let generation = 0;
    let stopped = false;
    let disabled = false;
    let publishing = false;
    let publishAgain = false;
    /** The highest newer revision seen while the replica is suspended. */
    let newer: number | undefined;
    let reviewing: Promise<void> | undefined;
    let reviewAgain = false;
    let storeLost = false;
    let channelLost = false;
    const waits = storeWaits(undefined);
    /** The attempt in flight must be followed by a readiness check. */
    let checkAgain = false;
    let checking = false;
    let reported = false;
    let hydrating: Promise<void> | undefined;
    let abandonLoad: (() => void) | undefined;
    let source: { readonly load: () => unknown; readonly byId: ((id: EntityKey) => unknown) | undefined } | undefined;
    const pending = new Set<Promise<unknown>>();
    /** The keys to publish, newest change per entity and id; a failed publish keeps them for the next attempt. */
    const backlog = new Map<string, Omit<ReplicaChange, "value">>();
    const halted = () => stopped || storeLost || disabled;
    const idle = () => halted() || replica.superseded || replica.suspended;
    /** A stop that no longer waits: nothing new reaches the store or the channel. */
    const abandoned = () => stopped && storeLost;

    /**
     * The work's result, or undefined once the store is lost: a native client may hold a call until it reconnects, so
     * nothing that shuts down or answers a request waits for it beyond that.
     */
    function untilLost<T>(work: Promise<T>): Promise<T | undefined> {
      return waits.until(work, storeLost);
    }

    function background(work: () => Promise<unknown>, onError: (error: unknown) => void): Promise<void> {
      return outside(() => {
        const task = work().then(() => undefined, onError);
        pending.add(task);
        task.then(() => pending.delete(task));
        return task;
      });
    }

    function report(error: unknown): void {
      replica.healthy = false;

      if (reported) {
        return;
      }

      reported = true;
      // Reported inside the failure's span, so a reporter links it to the trace.
      void withTrace(tracing, { name: `${namespace} replication failed`, failure: () => error }, async () =>
        reportError(reporter, {
          error,
          source: "openknot.replication",
          expected: false,
          attributes: { "openknot.replication.namespace": namespace },
        }),
      );
    }

    /** Reads go to the source, and a marker reply already in flight no longer counts. */
    function unready(): void {
      generation++;
      replica.ready = undefined;
      replica.instance?.clear();
    }

    /**
     * Whether absence or a list read from the store holds: the verified marker was read before that read and this one
     * after its reply. Each hydration generates its own holder, so matching complete markers exclude a clear between them.
     */
    async function confirm(verified: ReplicaMarker, started: number): Promise<boolean> {
      try {
        if (idle() || channelLost || generation !== started) {
          return false;
        }

        const marker = await untilLost(store.marker(keyspace));

        if (idle() || channelLost || generation !== started || replica.ready !== verified) {
          return false;
        }

        if (isCurrent(marker, verified.runId) && marker.holder === verified.holder) {
          return true;
        }

        unready();
      } catch (error) {
        lose(error);
      }
      return false;
    }

    /** The shared layer may be stale for this instance: read the source until the next readiness check. */
    function lose(error: unknown): void {
      report(error);
      unready();
    }
    /** A change may be missing from the shared layer: mark it dirty and rebuild on the next event. */
    function fail(error: unknown): void {
      lose(error);
      dirty = true;
    }
    /** Final: reads go to the source, and store writes, publishing, hydrations and rebuilds stop. */
    function disable(error: unknown): void {
      if (disabled) {
        return;
      }

      disabled = true;
      reported = false;

      report(error);
      unready();
    }
    /** Undefined when the state has no order, which disables the replication. */
    function changeOf(state: unknown, type: "set" | "delete", id: EntityKey): ReplicaChange | undefined {
      const ordered = order(state);

      if (ordered === undefined) {
        disable(new TypeError(`A replicated ${entity} has no order; give it a version or an order`));
        return undefined;
      }

      return type === "set" && includeShared(state)
        ? { entity, id, order: ordered, type: "set", value: state }
        : { entity, id, order: ordered, type: "delete" };
    }

    /** Final: a newer revision completed. Commits stop applying and keep publishing keys, so it adopts them. */
    function supersede(): void {
      replica.superseded = true;
      replica.suspended = false;
      // Removes keys this instance recreated after the newer revision dropped this keyspace.
      background(() => store.drop(keyspace), report);
    }

    /** The rollout looks gone and commits from newer instances may be missed, so a check that finds no other rollout rebuilds. */
    function resume(): void {
      replica.suspended = false;
      newer = undefined;
      dirty = true;
      void ensure(false);
    }

    /** A newer revision is rolling out: reads go to the source while own commits keep reaching this keyspace. */
    function suspend(other: number): void {
      if (replica.superseded) {
        return;
      }

      newer = Math.max(newer ?? other, other);

      if (!replica.suspended) {
        replica.suspended = true;
        unready();
      }

      void reviewSuccession();
    }

    /** Only a complete marker supersedes; a missing or abandoned rollout resumes unless a higher one appeared. */
    async function review(target: number): Promise<void> {
      const targetKeyspace = `${namespace}:v${target}`;
      let state = (await store.marker(targetKeyspace))?.state;

      if (state === "loading" && !halted()) {
        const result = await locks.tryRun(`${targetKeyspace}:hydration`, { leaseMs }, async () => {
          if (storeLost) {
            return state;
          }

          const current = (await store.marker(targetKeyspace))?.state;

          if (current !== "loading" || storeLost) {
            return current;
          }

          await store.drop(targetKeyspace);
          return undefined;
        });

        if (result.acquired) {
          state = result.value;
        }
      }
      reported = false;

      if (halted()) {
        return;
      }

      // The store answered, and a suspended replica has no readiness to wait for.
      if (!channelLost && backlog.size === 0) {
        replica.healthy = true;
      }

      if (state === "loading") {
        return;
      }

      if (state === "complete") {
        supersede();
      } else if (newer === target) {
        resume();
      }
    }

    /** One review at a time; a request during a review runs another after it, of the highest revision seen. */
    function reviewSuccession(): Promise<void> {
      if (reviewing !== undefined) {
        reviewAgain = true;
        return reviewing;
      }

      if (halted()) {
        return Promise.resolve();
      }

      reviewing = background(async () => {
        do {
          reviewAgain = false;
          const target = newer;
          if (target === undefined) {
            break;
          }
          await review(target).catch(lose);
        } while (reviewAgain && replica.suspended && !halted());
        reviewing = undefined;
      }, lose);

      return reviewing;
    }

    function markReady(marker: ReplicaMarker): Promise<void> | undefined {
      if (idle() || channelLost || (replica.ready && !replica.instance?.failed)) {
        return undefined;
      }

      replica.ready = { ...marker };
      replica.healthy = true;

      const { instance } = replica;
      return instance === undefined ? undefined : background(() => instance.reload(), report);
    }

    /** Whether the keyspace is current for this store run; a pending dirty mark is written first. */
    async function check(): Promise<Checked> {
      const runId = await store.runId();
      let current: ReplicaMarker | undefined;

      if (halted()) {
        return { current, runId };
      }

      if ((await store.marker(`${namespace}:v${revision + 1}`)) !== undefined) {
        suspend(revision + 1);
      } else {
        if (halted()) {
          return { current, runId };
        }

        const marker = await store.marker(keyspace);

        if (halted()) {
          return { current, runId };
        }

        if (dirty) {
          await store.mark(keyspace, {
            state: marker?.state ?? "loading",
            runId: marker?.runId ?? runId,
            dirty: true,
          });
        } else {
          current = isCurrent(marker, runId) ? marker : undefined;
        }
      }

      reported = false;

      return { current, runId };
    }

    /** The only way to readiness: a current marker read that started after the latest change of generation. */
    async function verify(): Promise<Checked> {
      let started: number;
      let checked: Checked;
      do {
        started = generation;
        checked = await check();
      } while (started !== generation && !idle());
      return checked.current ? { ...checked, reload: markReady(checked.current) } : checked;
    }

    async function hydrate(force: boolean, checked?: Checked): Promise<void> {
      if (idle() || source === undefined) {
        return;
      }

      const load = source.load;

      if (!force) {
        checked ??= await verify();
        if (checked.current) {
          return checked.reload;
        }
      }

      const runId = checked?.runId ?? (await store.runId());

      if (idle()) {
        return;
      }

      const outcome = await locks
        .tryRun(`${keyspace}:hydration`, { leaseMs }, async () => {
          if (halted()) {
            return false;
          }

          // Lease tokens may be reused after work ends; the store fence also identifies this snapshot incarnation.
          const holder = randomUUID();
          dirty = false;
          unready();
          await store.mark(keyspace, { state: "loading", dirty: false, runId, holder });

          if (halted()) {
            return false;
          }

          await channel.publish({ type: "clear", origin, keyspace });

          if (halted()) {
            return false;
          }

          await store.clear(keyspace, holder);

          if (halted()) {
            return false;
          }

          // Stop ends this wait, and the attempt reaches its halted check; a late result or failure goes nowhere.
          const loaded = await new Promise<unknown>((resolve, reject) => {
            abandonLoad = () => resolve(undefined);
            Promise.resolve(load()).then(resolve, reject);
          });

          const pages: AsyncIterable<readonly unknown[]> | Iterable<readonly unknown[]> = isAsyncIterable(loaded)
            ? loaded
            : [itemsOf(loaded)];

          for await (const page of pages) {
            if (halted()) {
              return false;
            }

            const changes: ReplicaChange[] = [];

            for (const state of page) {
              const own = managedIdentity(state);

              if (own === undefined || own.entity !== entity || !includeShared(state)) {
                continue;
              }

              const changed = changeOf(state, "set", own.id);

              if (changed === undefined) {
                return false;
              }

              changes.push(changed);
            }

            if (changes.length > 0) {
              await store.apply(keyspace, changes, holder);
            }
          }

          // A change this load may have missed keeps the keyspace from being announced as complete.
          if (halted() || dirty) {
            return false;
          }

          await store.mark(keyspace, { state: "complete", dirty: false, runId, holder }, holder);

          if (revision > 1 && !halted()) {
            await store.drop(`${namespace}:v${revision - 1}`);
          }

          if (halted() || dirty) {
            return false;
          }

          await channel.publish({ type: "ready", origin, keyspace });
          return true;
        })
        .catch((error: unknown) => {
          if (!ReplicaFenced.is(error)) {
            throw error;
          }
        });

      if (!outcome?.acquired) {
        return;
      }

      if (dirty) {
        checkAgain = true;
      }

      // The lease may have expired after the completing mark, so a marker read decides this as for any other instance.
      else if (outcome.value) {
        await (
          await verify()
        ).reload;
      }
    }

    function run(force: boolean, checked?: Checked): Promise<void> {
      // Both callers, ensure() and readiness(), run inside the startup context, including these continuations.
      // The hydration that takes the lock clears it, so a rebuild outlives an attempt interrupted before that.
      if (force) {
        dirty = true;
      }

      const attempt = hydrate(force, checked).then(undefined, lose);

      hydrating = attempt;

      pending.add(attempt);

      attempt.then(() => {
        if (hydrating === attempt) {
          hydrating = undefined;
        }

        pending.delete(attempt);

        const again = checkAgain;
        checkAgain = false;

        if (again && forced === undefined) {
          void ensure(false);
        }
      });
      return attempt;
    }

    /** Waits only for the marker check; a needed hydration starts in the background and reports through `lose`. */
    async function readiness(): Promise<void> {
      if (halted() || replica.superseded) {
        return;
      }

      if (replica.suspended) {
        void reviewSuccession();
        return;
      }

      if (hydrating !== undefined || checking) {
        return;
      }

      checking = true;

      try {
        const checked = await verify();

        if (!checked.current && hydrating === undefined && (!replica.ready || dirty)) {
          void run(false, checked);
        }

        flushBacklog();
      } finally {
        checking = false;
      }
    }

    /** Something only a check can start; a ready and clean instance owes nothing and makes no store call. */
    const owed = () => !replica.ready || dirty || replica.instance?.failed;

    /** Tracked, unlike a commit's check, because a read's check is work stop drains. */
    function recheck(): void {
      if (owed()) {
        void background(readiness, lose);
      }
    }

    let forced: Promise<void> | undefined;

    function ensure(force = false): Promise<void> {
      return outside(() => {
        if (stopped || disabled || replica.superseded) {
          return Promise.resolve();
        }
        if (storeLost) {
          // `restored` performs it.
          if (force) {
            dirty = true;
          }

          return Promise.resolve();
        }

        if (replica.suspended) {
          return reviewSuccession();
        }

        if (hydrating === undefined) {
          return run(force);
        }

        if (!force) {
          return hydrating;
        }

        if (forced === undefined) {
          forced = hydrating.then(() => {
            forced = undefined;
            return ensure(true);
          });
        }

        return forced;
      });
    }
    /** A restored connection checks the keyspace; an attempt in flight may have lost its calls, so it checks after it. */
    function recover(): void {
      // A superseded replica serves nothing from the store and has no readiness to wait for.
      if (replica.superseded && !disabled && !storeLost && !channelLost) {
        replica.healthy = true;
      }

      if (hydrating !== undefined) {
        checkAgain = true;
      } else {
        void ensure(false);
      }
    }

    /** Changes an older revision published reach this keyspace through the source. */
    async function adopt(changes: readonly Omit<ReplicaChange, "value">[]): Promise<void> {
      const byId = source?.byId;
      if (byId === undefined) {
        dirty = true;
        return ensure(true);
      }

      const adopted: ReplicaChange[] = [];

      for (const change of changes) {
        if (change.entity !== entity) {
          continue;
        }

        const state = change.type === "delete" ? undefined : await byId(change.id);

        if (state === undefined) {
          adopted.push({ ...change, type: "delete" });
          continue;
        }

        const changed = changeOf(state, "set", change.id);

        if (changed === undefined) {
          return;
        }

        adopted.push(changed);
      }

      if (stopped || disabled || replica.superseded) {
        return;
      }

      const applied = storeLost ? undefined : await untilLost(store.apply(keyspace, adopted));

      if (applied === undefined) {
        // As for a commit: a rebuild brings the changes into this keyspace once the store is restored.
        dirty = true;
        recordChanges(adopted);
        return;
      }

      publishChanges(applied);

      if (replica.ready) {
        replica.instance?.refresh(applied.map((change) => change.id));
      }
    }
    /** One publish at a time; a failure is only reported, because the stored changes are not in doubt. */
    async function drainBacklog(): Promise<void> {
      publishing = true;
      do {
        publishAgain = false;
        const sent = [...backlog];

        try {
          await channel.publish({ type: "changes", origin, keyspace, changes: sent.map(([, change]) => change) });

          // Only what was sent leaves the backlog; a change merged during the publish is still owed.
          for (const [key, change] of sent) {
            if (backlog.get(key) === change) {
              backlog.delete(key);
            }
          }

          const serving = replica.superseded || (replica.ready && !replica.instance?.failed);

          if (serving && !disabled && !storeLost && !channelLost) {
            replica.healthy = true;
            reported = false;
          }
        } catch (error) {
          report(error);
        }
      } while (publishAgain && backlog.size > 0 && !disabled && !abandoned());
      publishing = false;
    }
    function recordChanges(changes: readonly ReplicaChange[]): void {
      for (const { entity: owner, id, order: ordered, type } of changes) {
        const key = `${owner}\u0000${keyOf(id)}`;
        const held = backlog.get(key);

        if (held === undefined || ordered >= held.order) {
          backlog.set(key, { entity: owner, id, order: ordered, type });
        }
      }

      if (publishing) {
        publishAgain = true;
      }
    }

    function publishChanges(changes: readonly ReplicaChange[]): void {
      if (disabled || abandoned()) {
        return;
      }

      recordChanges(changes);

      if (!publishing && backlog.size > 0) {
        void background(drainBacklog, report);
      }
    }
    /** On-demand retry: it never starts a publish beside one in flight. */
    function flushBacklog(): void {
      if (!publishing && !stopped) {
        publishChanges([]);
      }
    }

    const handlers: ReplicationHandlers = {
      message(message) {
        if (stopped || disabled || message.origin === origin) {
          return;
        }

        const other = message.keyspace === keyspace ? undefined : revisionOf(message.keyspace);
        const adoptable = other !== undefined && other < revision && message.type === "changes";

        if (storeLost) {
          // It cannot be adopted now, and the check after `restored` would find a current marker.
          if (adoptable && !replica.superseded) {
            dirty = true;
          }
          return;
        }

        if (message.keyspace !== keyspace) {
          if (other !== undefined && other > revision) {
            suspend(other);
          } else if (adoptable && !replica.superseded) {
            background(() => adopt(message.changes), fail);
          }

          return;
        }

        if (message.type === "clear") {
          unready();
        } else if (message.type === "ready") {
          generation++;

          if (dirty) {
            background(() => ensure(true), lose);
          } else if (hydrating !== undefined) {
            checkAgain = true;
          } else {
            recheck();
          }
        } else if (message.type === "changes" && replica.ready) {
          replica.instance?.refresh(
            message.changes.filter((change) => change.entity === entity).map((change) => change.id),
          );
        }
      },
      lost() {
        channelLost = true;
        replica.healthy = false;
        unready();
      },
      restored() {
        channelLost = false;
        if (stopped) {
          return;
        }
        generation++;
        publishChanges([]);
        recover();
      },
    };
    context.subscribe({
      recorded: () => undefined,
      settled: () => undefined,
      async committed(committed: readonly CommittedChange[]) {
        const mine = committed.filter((change) => change.entity === entity);

        if (mine.length === 0 || stopped || disabled) {
          return;
        }

        const ids = mine.map((change) => change.id);
        const mapped: ReplicaChange[] = [];
        let changes: readonly ReplicaChange[] | undefined = mapped;

        try {
          for (const change of mine) {
            const changed = changeOf(change.state, change.type, change.id);

            if (changed === undefined) {
              return;
            }

            mapped.push(changed);
          }

          if (storeLost) {
            changes = undefined;
          } else if (!replica.superseded) {
            changes = await untilLost(store.apply(keyspace, mapped));
          }
        } catch (error) {
          fail(error);
          return;
        }

        if (changes === undefined) {
          // A rebuild brings the change into this keyspace, and `restored` publishes its key for a newer revision.
          dirty = true;
          recordChanges(mapped);
          return;
        }

        publishChanges(changes);
        // Untracked, so stop never waits for a marker reply that a restored store need not send.
        const check = () => outside(() => readiness().then(undefined, lose));

        if (replica.ready) {
          replica.instance?.refresh(ids);
          if (owed()) {
            void check();
          }
        } else if (!replica.superseded) {
          await untilLost(check());
        }
      },
    });

    const replica: Replica = {
      ready: undefined,
      superseded: false,
      suspended: false,
      healthy: true,
      instance: createInstance(dependencies, view, report, outside),
      read: (distributed.bind?.({ store: view }) ??
        ("byId" in sharedMembers ? { byId: (id: EntityKey) => view.get(id) } : {})) as Replica["read"],
      lose,
      generation: () => generation,
      confirm,
      recheck,
      flushBacklog,
      untilLost,

      async start(load, byId) {
        source = { load, byId };
        const subscription = await channel.subscribe(handlers);
        const unsubscribe = store.connection?.watch({
          lost() {
            storeLost = true;
            replica.healthy = false;
            unready();
            waits.release();
          },
          restored() {
            storeLost = false;
            flushBacklog();
            recover();
          },
        });
        const first = ensure(false);
        return {
          first,
          async stop() {
            stopped = true;
            abandonLoad?.();
            const drained = (async () => {
              await subscription.close();
              await Promise.allSettled(pending);
            })();
            // The work a lost store leaves over issues nothing new: it checks `halted` before its next call.
            try {
              await untilLost(drained);
            } finally {
              unsubscribe?.();
            }
          },
        };
      },
      rebuild: () => ensure(true),
    };

    return replica;
  }

  /** Built at startup, so the replication follows every commit from the first one. */
  const replica = unit({
    requirements: {
      ...local?.requirements,
      __changes: unitOfWorkChanges,
      __store: replicaStore,
      __channel: replicationChannel,
      __lock: lock,
      __trace: optional(trace),
      __reporter: optional(errorReporter),
    } as Requirements,
    factory: ({
      __changes,
      __store,
      __channel,
      __lock,
      __trace,
      __reporter,
      ...dependencies
    }: Record<string, unknown>) =>
      createReplica(
        __changes as UnitOfWorkChanges,
        __store as ReplicaStore,
        __channel as ReplicationChannel,
        __lock as Lock,
        __trace as Tracing | undefined,
        __reporter as ErrorReporter | undefined,
        dependencies as ResolvedReferences<Requirements>,
      ),
  });

  const localMemberNames = new Map<ReaderDefinition, string>(
    Object.entries(localMembers).map(([name, reader]) => [reader, name]),
  );

  const sharedMemberNames = new Map<ReaderDefinition, string>(
    Object.entries(sharedMembers).map(([name, reader]) => [reader, name]),
  );

  function instanceRead(
    reader: ReaderDefinition,
    next: ReaderFunction,
    state: Replica,
    context: UnitOfWorkChanges,
  ): ReaderFunction | undefined {
    const name = localMemberNames.get(reader);
    const instance = state.instance;
    const read = name === undefined ? undefined : instance?.read[name];

    if (instance === undefined || read === undefined) {
      return undefined;
    }

    const source = next as (...args: never[]) => unknown;

    return ((...args: never[]) => {
      state.recheck();

      if (instance.disabledAll) {
        return source(...args);
      }

      const started = instance.changes;

      const answer = (cached: unknown) => {
        if (instance.changes !== started) {
          return source(...args);
        }

        const result = asCacheResult(cached);

        if (result.kind !== "completed" || result.value === undefined) {
          return source(...args);
        }

        const value = result.value;

        // Lists are disabled while any key refreshes; other results while one of their keys does.
        if (isList(value) && (partialInstance || context.wrote(entity) || instance.disabled.size > 0)) {
          return source(...args);
        }

        const disabled = itemsOf(value).some((item) => {
          const key = managedIdentity(item);
          return key !== undefined && instance.disabled.has(keyOf(key.id));
        });

        return disabled || context.touched(value) ? source(...args) : value;
      };

      let cached: unknown;

      try {
        cached = read(...args);
      } catch (error) {
        state.lose(error);
        return source(...args);
      }

      return isThenable(cached)
        ? Promise.resolve(cached).then(answer, (error: unknown) => {
            state.lose(error);
            return source(...args);
          })
        : answer(cached);
    }) as ReaderFunction;
  }

  function distributedRead(
    reader: ReaderDefinition,
    next: ReaderFunction,
    state: Replica,
    context: UnitOfWorkChanges,
  ): ReaderFunction | undefined {
    const name = sharedMemberNames.get(reader);
    const read = name === undefined ? undefined : state.read[name];

    if (read === undefined) {
      return undefined;
    }

    const source = next as (...args: never[]) => unknown;
    const partial = distributed.include !== undefined;

    return (async (...args: never[]) => {
      state.flushBacklog();
      state.recheck();
      const verified = state.ready;

      if (verified === undefined) {
        return source(...args);
      }

      const started = state.generation();
      let result: CacheResult<unknown>;

      try {
        const answered = await state.untilLost(Promise.resolve(read(...args)));
        // A whole ready/unready/ready cycle also outdates an asynchronous store's earlier reply.
        if (!state.ready || state.generation() !== started) {
          return source(...args);
        }

        result = asCacheResult(answered);
      } catch (error) {
        state.lose(error);
        return source(...args);
      }

      if (result.kind === "unsupported") {
        return source(...args);
      }

      const value = result.kind === "completed" ? result.value : undefined;

      if (context.touched(value)) {
        return source(...args);
      }
      // Without an include the shared layer holds the complete set: absence and lists are answered unless this work
      // wrote the entity.
      if (value === undefined || isList(value)) {
        if (partial || context.wrote(entity)) {
          return source(...args);
        }

        if (!(await state.confirm(verified, started))) {
          return source(...args);
        }
      }

      return value;
    }) as ReaderFunction;
  }

  const distributedLayer = Object.freeze({});
  const instanceLayer = Object.freeze({});

  function decorated(
    readers: Iterable<ReaderDefinition>,
    prefix: string,
    layer: object,
    read: typeof instanceRead,
  ): readonly (readonly [string, Decoration])[] {
    return [...readers].map((reader, index) => [
      `${prefix}:${index}`,
      decorate(reader, {
        requirements: { replica, changes: unitOfWorkChanges } as Requirements,
        wrap: (inner: unknown, { replica: state, changes }: Readonly<Record<string, unknown>>) => {
          const next = inner as ReaderFunction;
          return layered(layer, read(reader, next, state as Replica, changes as UnitOfWorkChanges) ?? next, next);
        },
      } as never),
    ]);
  }

  const byIdReader = sharedMembers.byId;

  const startup = layerStartup({
    layer: distributedLayer,
    requirements: { replica } as Requirements,
    reads: byIdReader === undefined ? [distributed.load] : [distributed.load, byIdReader],
    start: async ({ replica: state }, below) => {
      const load = below(distributed.load) as () => unknown;
      const byId = byIdReader === undefined ? undefined : (below(byIdReader) as (id: EntityKey) => unknown);
      const { first, stop } = await (state as Replica).start(load, byId);
      if (distributed.startup === "blocking") {
        await first;
      }
      return stop;
    },
  });

  const rebuild = unit({
    requirements: { replica },
    factory:
      ({ replica: state }) =>
      () =>
        (state as Replica).rebuild(),
  });

  const health = healthCheck({
    name: `${namespace}-replication`,
    requirements: { replica } as Requirements,
    check: async ({ replica: state }) => ((state as Replica).healthy ? "up" : "down"),
  });

  // The distributed layer is listed first, so it is the closer one to the source.
  return Object.freeze({
    source,
    ...Object.fromEntries(
      decorated(
        new Set([...sharedMemberNames.keys(), distributed.load]),
        "distributed",
        distributedLayer,
        distributedRead,
      ),
    ),
    ...Object.fromEntries(decorated(localMemberNames.keys(), "instance", instanceLayer, instanceRead)),
    startup,
    rebuild,
    health,
  }) as unknown as Replication<SourceOf<T>>;
}

/** Keeps a per-instance layer and a shared store coherent with managed writes across instances. */
export const replication: typeof compose & {
  readonly instance: typeof instanceSection;
  readonly distributed: typeof distributedSection;
} = Object.assign(compose, { instance: instanceSection, distributed: distributedSection });
