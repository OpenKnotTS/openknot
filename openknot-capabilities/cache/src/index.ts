import { isAsyncIterable, keyOf, layered, layerStartup, storeWaits } from "./layers.ts";
import type { CacheResult } from "./result.ts";
import { asCacheResult } from "./result.ts";
import type { ReaderComposition, ReaderDefinition, ReaderFunction } from "@openknot-ts/behavior";
import { isReader, isReaderComposition } from "@openknot-ts/behavior";
import { managedIdentity, isList, itemsOf, versionOf } from "@openknot-ts/behavior/internal/managed";
import type { UnattendedFailures } from "@openknot-ts/error-reporting";
import { unattendedFailures } from "@openknot-ts/error-reporting/wire";
import type { CommittedChange, EntityKey, UnitOfWorkChanges } from "@openknot-ts/flow/wire";
import { unitOfWorkChanges } from "@openknot-ts/flow/wire";
import type { HealthCheckDefinition } from "@openknot-ts/health";
import { healthCheck } from "@openknot-ts/health";
import type { Tracing } from "@openknot-ts/tracing";
import { withTrace } from "@openknot-ts/tracing";
import { trace } from "@openknot-ts/tracing/wire";
import type {
  Decoration,
  PlugDefinition,
  Provider,
  Requirements,
  ResolvedReferences,
  ConnectionWatch,
} from "@openknot-ts/wire";
import { decorate, optional, resource, unit } from "@openknot-ts/wire";
import type { BindPort } from "@openknot-ts/wire/internal/marker";
import { isThenable } from "@openknot-ts/wire/internal/synchronous";
import { AsyncLocalStorage } from "node:async_hooks";

export { completed, empty, isCacheResult, unsupported } from "./result.ts";
export type { CacheResult } from "./result.ts";

export type CacheStrategy = "read-through" | "write-through" | "snapshot";

export type CacheOrder = number | bigint | string;

export type CacheChange =
  | { readonly type: "set"; readonly key: EntityKey; readonly value: unknown }
  | { readonly type: "delete"; readonly key: EntityKey }
  | { readonly type: "clear" };

type Dependencies<R extends Requirements> = ResolvedReferences<R>;

type Members<P> = P extends ReaderComposition<infer M> ? M : { readonly value: P };

type Returned<D> = D extends { readonly [BindPort]: (implementation: infer F) => unknown }
  ? F extends (...args: never[]) => infer Result
    ? Awaited<Result>
    : never
  : never;

type MemberRead<D> = D extends { readonly [BindPort]: (implementation: infer F) => unknown }
  ? F extends (...args: infer A) => unknown
    ? (
        ...args: A
      ) =>
        | Returned<D>
        | undefined
        | CacheResult<Returned<D>>
        | PromiseLike<Returned<D> | undefined | CacheResult<Returned<D>>>
    : never
  : never;

type StateOf<T> = T extends readonly (infer S)[] ? S : T extends { readonly items: readonly (infer S)[] } ? S : T;

type EntityOf<T> =
  StateOf<NonNullable<T>> extends infer S ? (S extends { readonly entity: infer E extends string } ? E : never) : never;

/** The \`entity\` literals of the managed states the port's members return. */
export type PortEntity<P> = { readonly [K in keyof Members<P>]: EntityOf<Returned<Members<P>[K]>> }[keyof Members<P>];

/** The union of managed states returned by the port's members. */
export type PortState<P> = {
  readonly [K in keyof Members<P>]: StateOf<NonNullable<Returned<Members<P>[K]>>>;
}[keyof Members<P>];

/** Reader implementations a cache layer binds, one optional member per port member. */
export type CacheMemberReads<P> = { readonly [K in keyof Members<P>]?: MemberRead<Members<P>[K]> };

type Loaded = readonly unknown[] | AsyncIterable<readonly unknown[]>;

interface Options<P extends ReaderDefinition | ReaderComposition, R extends Requirements> {
  /** Names the layer's health check and spans; defaults to `<entity>-cache`. */
  readonly name?: string;
  readonly strategy?: CacheStrategy;
  readonly requirements?: R;
  /** The reader ports this layer answers. */
  readonly port: P;
  /** Applies changes to the consumer's native store. */
  readonly persist: (dependencies: Dependencies<R>) => (changes: readonly CacheChange[]) => void | PromiseLike<void>;
  /** Native reads per member: a value, undefined for a miss, or a CacheResult. */
  readonly bind: (dependencies: Dependencies<R>) => CacheMemberReads<P>;
  readonly connection?: (dependencies: Dependencies<R>) => ConnectionWatch;
  /** write-through: the writers whose committed receipts insert entries. */
  readonly writers?: object;
  /** Limits which states the layer keeps; a state that fails it is removed. */
  readonly include?: (dependencies: Dependencies<R>) => (state: unknown) => boolean;
  /**
   * snapshot: a reader, called without arguments through the layers below, loads a complete set; a function loads a
   * partial set. Large loads may return pages as an async iterable.
   */
  readonly load?: ReaderDefinition | ((dependencies: Dependencies<R>) => Loaded | PromiseLike<Loaded>);
  /** snapshot: \`blocking\` starts the application once the load completes. */
  readonly startup?: "background" | "blocking";
  /** Which of two states of an entity is newer; defaults to its \`version\`. */
  readonly order?: (state: unknown) => CacheOrder;
}

/** A port returning managed states names their entity; a layer over other results caches them by arguments. */
export type CacheOptions<P extends ReaderDefinition | ReaderComposition, R extends Requirements> = Options<P, R> &
  ([PortEntity<P>] extends [never] ? { readonly entity?: never } : { readonly entity: PortEntity<P> });

/** The key of results that are not managed entities: the serialized arguments. */
export function cacheKey(...args: readonly unknown[]): string | undefined {
  return encode(Array.from(args), new Set<object>());
}

function encode(value: unknown, visiting: Set<object>): string | undefined {
  if (value === undefined) {
    return "u";
  }

  if (value === null) {
    return "n";
  }

  if (typeof value === "boolean") {
    return value ? "b1" : "b0";
  }

  if (typeof value === "number") {
    if (Object.is(value, -0)) {
      return "d-0";
    }

    return `d${String(value)}`;
  }

  if (typeof value === "bigint") {
    return `i${value.toString()}`;
  }

  if (typeof value === "string") {
    return `s${JSON.stringify(value)}`;
  }

  if (typeof value === "object") {
    if (Object.prototype.toString.call(value) === "[object Date]") {
      const date = value as { getTime(): number; toISOString(): string };

      if (Number.isNaN(date.getTime())) {
        return undefined;
      }

      return `t${date.toISOString()}`;
    }

    if (Array.isArray(value)) {
      if (visiting.has(value)) {
        return undefined;
      }

      visiting.add(value);

      const parts: string[] = [];

      for (const item of value) {
        const encoded = encode(item, visiting);

        if (encoded === undefined) {
          visiting.delete(value);
          return undefined;
        }

        parts.push(encoded);
      }

      visiting.delete(value);
      return `[${parts.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);

    if (prototype === Object.prototype || prototype === null) {
      if (visiting.has(value)) {
        return undefined;
      }

      visiting.add(value);

      const keys = Object.keys(value as Record<string, unknown>).sort();
      const parts: string[] = [];

      for (const key of keys) {
        const encoded = encode((value as Record<string, unknown>)[key], visiting);

        if (encoded === undefined) {
          visiting.delete(value);
          return undefined;
        }

        parts.push(`${JSON.stringify(key)}:${encoded}`);
      }

      visiting.delete(value);
      return `{${parts.join(",")}}`;
    }
  }
  return undefined;
}

/** What a store call answers once the store is lost; distinct from every answer a store can give. */
const storeLost = Symbol("store lost");

/** The newest change of an entity while operations on it are in flight. */
interface Mark {
  readonly order: CacheOrder | undefined;
  readonly epoch: number;
  readonly deleted: boolean;
  /** What the commit asks of this layer, for a reload that clears the store before the commit settled. */
  readonly change: CacheChange;
}

interface Layer {
  readonly dependencies: unknown;
  readonly read: Readonly<Record<string, ((...args: never[]) => unknown) | undefined>>;
  readonly flights: Map<string, Promise<unknown>>;
  readonly transactionFlights: WeakMap<object, Map<string, Promise<unknown>>>;
  /** The first native store failure; the layer is unavailable from then on. */
  failure: unknown;
  unavailable: boolean;
  ready: boolean;
  complete: boolean;
  disconnected: boolean;
  recovering: Promise<void> | undefined;
  /** The store was restored during a recovery, whose calls may have been lost: another one follows it. */
  recoverAgain: boolean;
  snapshot: (() => unknown) | undefined;
  fail(error: unknown): void;
  /** Ends every wait on the store; a native client may hold a call until it reconnects. */
  release(): void;
  untilLost<T>(work: Promise<T>): Promise<T | typeof storeLost>;
  recover(): Promise<void>;
  apply(changes: readonly CacheChange[]): Promise<void>;
  /** A fill reads from now on; its result is compared with commits that arrive meanwhile. */
  begin(): number;
  fill(start: number, values: readonly unknown[]): void | Promise<void>;
  end(): void;
  load(source: () => unknown): Promise<void>;
}

/** The application's outside flights per entity, so a commit can retire them on every layer of the entity at once. */
const entityFlights = unit({ factory: () => new Map<string, Set<Map<string, Promise<unknown>>>>() });

/**
 * A cache layer: the decorations of its readers, its health check and any startup load. List it in a module beside the
 * reader plug; among several layers of a reader, the first listed is the closest to the source.
 */
export type CacheLayer = Readonly<
  Record<string, Decoration | PlugDefinition | Provider<unknown, never, "unit" | "resource">>
> & {
  readonly state: Provider<unknown, never, "resource">;
  readonly health: HealthCheckDefinition<Requirements>;
};

export function cache<const P extends ReaderDefinition | ReaderComposition, const R extends Requirements = {}>(
  options: CacheOptions<P, R>,
): CacheLayer {
  const strategy = options.strategy ?? "read-through";
  const entity: string | undefined = options.entity;

  if (entity !== undefined && (typeof entity !== "string" || entity.length === 0)) {
    throw new TypeError("A cache's entity must be a non-empty string");
  }

  if (strategy !== "read-through" && entity === undefined) {
    throw new TypeError(`A ${strategy} cache keeps managed entities and names their entity`);
  }

  const members: Readonly<Record<string, ReaderDefinition>> = isReaderComposition(options.port)
    ? options.port.members
    : { value: options.port as ReaderDefinition };

  const memberOf = new Map(Object.entries(members).map(([name, reader]) => [reader, name]));

  const writers = new Set<object>(
    options.writers === undefined
      ? []
      : "members" in options.writers
        ? Object.values((options.writers as { readonly members: Readonly<Record<string, object>> }).members)
        : [options.writers],
  );

  const order: (state: unknown) => CacheOrder | undefined = options.order ?? versionOf;

  const stale = (mark: Mark | undefined, next: CacheOrder | undefined, type: "set" | "delete") =>
    mark !== undefined &&
    mark.order !== undefined &&
    next !== undefined &&
    (next < mark.order || (next === mark.order && mark.deleted && type === "set"));

  const name = options.name ?? `${entity ?? "result"}-cache`;

  function create(
    context: UnitOfWorkChanges,
    dependencies: Dependencies<R>,
    tracing: Tracing | undefined,
    failures: UnattendedFailures,
    flights: Map<string, Set<Map<string, Promise<unknown>>>>,
  ): Layer {
    const persist = options.persist(dependencies);
    const include = options.include?.(dependencies) ?? (() => true);

    const writes = new Map<string, number>();
    const marks = new Map<string, Mark>();
    const waits = storeWaits(storeLost);

    // Captures the context of application startup, including its tracing context.
    // Start the application outside transactions; recovery and its continuations retain this context.
    const outside = AsyncLocalStorage.snapshot();

    let fills = 0;
    let epoch = 0;
    let clearedAt = 0;

    const prune = (key: string) => {
      if (fills === 0 && !writes.has(key)) {
        marks.delete(key);
      }
    };

    const reset = () => {
      clearedAt = ++epoch;
      for (const key of marks.keys()) {
        prune(key);
      }
    };

    const layer: Layer = {
      dependencies,
      read: options.bind(dependencies) as Layer["read"],
      flights: new Map(),
      transactionFlights: new WeakMap(),
      failure: undefined,
      unavailable: false,
      ready: strategy !== "snapshot" || options.load === undefined,
      complete: false,
      disconnected: false,
      recovering: undefined,
      recoverAgain: false,
      snapshot: undefined,
      fail(error) {
        if (layer.failure !== undefined) {
          layer.unavailable = true;
          return;
        }
        layer.failure = error;
        layer.unavailable = true;
        // Logged and reported inside the outage's span, so both link it to the trace.
        void withTrace(tracing, { name: `${name} unavailable`, failure: () => error }, async () =>
          failures({
            error,
            source: "openknot.cache",
            attributes: { "openknot.cache.name": name },
          }),
        );
      },
      release() {
        waits.release();
      },
      untilLost(work) {
        return waits.until(work, layer.disconnected);
      },

      apply(changes) {
        if (changes.length === 0 || layer.unavailable) {
          return Promise.resolve();
        }

        try {
          const pending = persist(changes);
          // A failure after `lost` is dropped: the recovery after `restored` clears what that call may have written.
          if (isThenable(pending)) {
            return layer.untilLost(Promise.resolve(pending)).then(() => undefined, layer.fail);
          }
        } catch (error) {
          layer.fail(error);
        }

        return Promise.resolve();
      },
      begin() {
        fills++;
        return epoch;
      },
      fill(start, values) {
        const changes: CacheChange[] = [];
        for (const value of values) {
          const own = managedIdentity(value);

          if (own === undefined || own.entity !== entity || start < clearedAt) {
            continue;
          }

          const mark = marks.get(keyOf(own.id));
          const next = order(value);

          // A commit that arrived after the fill read wins unless the fill read a strictly newer state.
          const outdated =
            mark !== undefined && mark.epoch > start
              ? next === undefined ||
                mark.order === undefined ||
                next < mark.order ||
                (next === mark.order && mark.deleted)
              : // An unordered state cannot be told apart from one a lower layer answered before this commit.
                (mark !== undefined && next === undefined) || stale(mark, next, "set");

          if (outdated) {
            continue;
          }

          changes.push(include(value) ? { type: "set", key: own.id, value } : { type: "delete", key: own.id });
        }

        return layer.apply(changes);
      },
      end() {
        fills--;
        if (fills === 0) {
          for (const key of marks.keys()) {
            prune(key);
          }
        }
      },
      async load(source) {
        reset();
        await layer.apply([{ type: "clear" }]);
        // The layers below may not hold an unsettled commit yet, and may not even list its row.
        await layer.apply([...marks.values()].map((mark) => mark.change));
        const start = layer.begin();

        try {
          const loaded = await source();

          if (isAsyncIterable(loaded)) {
            for await (const page of loaded) {
              await layer.fill(start, page);
            }
          } else {
            await layer.fill(start, itemsOf(loaded));
          }

          layer.ready = !layer.unavailable;
        } catch (error) {
          layer.fail(error);
        } finally {
          layer.end();
        }
      },
      recover() {
        if (layer.disconnected || layer.recovering !== undefined) {
          return layer.recovering ?? Promise.resolve();
        }

        layer.unavailable = false;

        const promise = outside(async () => {
          try {
            if (layer.snapshot !== undefined) {
              await layer.load(layer.snapshot);
            } else {
              reset();
              await layer.apply([{ type: "clear" }]);
            }

            if (!layer.unavailable) {
              layer.failure = undefined;
            }
          } finally {
            layer.recovering = undefined;

            if (layer.recoverAgain) {
              layer.recoverAgain = false;
              void layer.recover();
            }
          }
        });

        layer.recovering = promise;
        return promise;
      },
    };

    if (entity === undefined) {
      return layer;
    }

    const sameEntity = flights.get(entity) ?? new Set();

    flights.set(entity, sameEntity);
    sameEntity.add(layer.flights);

    const retire = () => {
      for (const flightMap of sameEntity) {
        flightMap.clear();
      }
    };

    context.subscribe({
      recorded(identity) {
        if (identity.entity !== entity) {
          return;
        }
        const key = keyOf(identity.id);
        writes.set(key, (writes.get(key) ?? 0) + 1);
      },
      committed(committed: readonly CommittedChange[]) {
        // Layers receive a commit one at a time, in no guaranteed order, so the first one retires the flights of all.
        const changed = committed.some((change) => change.entity === entity);

        if (changed) {
          retire();
        }

        epoch++;

        const changes: CacheChange[] = [];

        for (const change of committed) {
          if (change.entity !== entity) {
            continue;
          }

          const key = keyOf(change.id);
          const next = order(change.state);

          if (stale(marks.get(key), next, change.type)) {
            continue;
          }

          // A mark on an unordered state would also drop it from the reload that follows the outage.
          const reloads = layer.unavailable && layer.snapshot !== undefined && next === undefined;
          const marked = !reloads && (fills > 0 || writes.has(key));

          const mark = (requested: CacheChange) => {
            if (marked) {
              marks.set(key, { order: next, epoch, deleted: change.type === "delete", change: requested });
            }
          };
          // Before `include` runs, because a throw must not leave a lower store's old entry free to fill this layer.
          mark({ type: "delete", key: change.id });

          const listed = change.writer !== undefined && writers.has(change.writer);

          // Without an order a later commit could not tell an older set apart, so unordered entities are evicted.
          const set =
            change.type === "set" &&
            next !== undefined &&
            include(change.state) &&
            (strategy !== "write-through" || listed);

          const applied: CacheChange = set
            ? { type: "set", key: change.id, value: change.state }
            : { type: "delete", key: change.id };

          mark(applied);
          changes.push(applied);
        }
        // A layer down at the commit keeps its marks: once it recovers, a lower store's old entry must not fill it.
        if (layer.unavailable) {
          void layer.recover();
          return;
        }

        const written = layer.apply(changes);
        // A flight that started during this store write may hold the answer this store gave before it.
        return changed ? written.then(retire) : written;
      },
      settled(identities) {
        for (const identity of identities) {
          if (identity.entity !== entity) {
            continue;
          }

          const key = keyOf(identity.id);
          const count = (writes.get(key) ?? 0) - 1;

          if (count > 0) {
            writes.set(key, count);
          } else {
            writes.delete(key);
            prune(key);
          }
        }
      },
    });
    return layer;
  }

  /** Built at startup, so the layer follows every write from the first one. */
  const activation = resource({
    requirements: {
      ...options.requirements,
      __changes: unitOfWorkChanges,
      __trace: optional(trace),
      __failures: unattendedFailures,
      __flights: entityFlights,
    } as Requirements,

    initialize: async (dependencies: Readonly<Record<string, unknown>>) => {
      const { __changes, __trace, __failures, __flights, ...deps } = dependencies as {
        readonly __changes: UnitOfWorkChanges;
        readonly __trace: Tracing | undefined;
        readonly __failures: UnattendedFailures;
        readonly __flights: Map<string, Set<Map<string, Promise<unknown>>>>;
      } & Record<string, unknown>;
      const layer = create(__changes, deps as Dependencies<R>, __trace, __failures, __flights);

      let unsubscribe: (() => void) | undefined;

      if (options.connection !== undefined) {
        unsubscribe = options.connection(deps as Dependencies<R>).watch({
          lost: () => {
            layer.disconnected = true;
            layer.unavailable = true;
            layer.release();
          },
          restored: () => {
            layer.disconnected = false;
            if (layer.recovering !== undefined) {
              layer.recoverAgain = true;
            } else {
              void layer.recover();
            }
          },
        });
      }

      return { value: layer, release: () => unsubscribe?.() };
    },
  });

  const health = healthCheck({
    name,
    requirements: { state: activation } as Requirements,
    check: async ({ state }) =>
      (state as Layer).unavailable || (state as Layer).recovering !== undefined ? "down" : "up",
  });

  const loader = strategy === "snapshot" ? options.load : undefined;

  function attach(
    reader: ReaderDefinition,
    next: ReaderFunction,
    layer: Layer,
    context: UnitOfWorkChanges,
  ): ReaderFunction | undefined {
    const member = memberOf.get(reader);

    if (member === undefined) {
      return undefined;
    }

    const read = layer.read[member];

    if (read === undefined) {
      return undefined;
    }

    const source = next as (...args: never[]) => unknown;

    const wroteEntity = () => entity !== undefined && context.wrote(entity);

    function remember(value: unknown, args: never[], start: number): void {
      if (entity === undefined) {
        // Result caches key by arguments and do not interact with commits.
        layer.end();

        if (value === undefined || itemsOf(value).length === 0) {
          return;
        }

        const key = cacheKey(...args);

        if (key === undefined) {
          return;
        }

        context.afterCompletion((committed) => {
          if (committed) {
            void layer.apply([{ type: "set", key, value }]);
          }
        });
        return;
      }

      if (wroteEntity()) {
        return layer.end();
      }

      context.afterCompletion((committed) => {
        try {
          if (committed) {
            void layer.fill(start, itemsOf(value));
          }
        } finally {
          layer.end();
        }
      });
    }

    function fromSource(args: never[], fill: boolean): unknown {
      if (wroteEntity()) {
        return source(...args);
      }

      const key = cacheKey(...args);

      if (key === undefined) {
        return source(...args);
      }

      const flightKey = `${member}\u0000${key}`;

      const token = context.transaction();

      let flightMap: Map<string, Promise<unknown>>;

      if (token === undefined) {
        flightMap = layer.flights;
      } else {
        let map = layer.transactionFlights.get(token);

        if (map === undefined) {
          map = new Map();
          layer.transactionFlights.set(token, map);
        }

        flightMap = map;
      }

      const shared = flightMap.get(flightKey);

      if (shared !== undefined) {
        if (token === undefined) {
          return shared.then(
            (value) => value,
            () => source(...args),
          );
        }

        return shared.then(
          (value) => (context.touched(value) ? source(...args) : value),
          () => source(...args),
        );
      }

      const start = fill ? layer.begin() : 0;

      let result: unknown;

      try {
        result = source(...args);
      } catch (error) {
        if (fill) {
          layer.end();
        }

        throw error;
      }

      if (!isThenable(result)) {
        if (fill) {
          remember(result, args, start);
        }

        return result;
      }

      const flight = Promise.resolve(result).then(
        (value) => {
          if (fill) {
            remember(value, args, start);
          }

          return value;
        },
        (error: unknown) => {
          if (fill) {
            layer.end();
          }
          throw error;
        },
      );

      flightMap.set(flightKey, flight);

      const settle = () => {
        if (flightMap.get(flightKey) === flight) {
          flightMap.delete(flightKey);
        }
      };

      flight.then(settle, settle);
      return flight;
    }

    function answer(args: never[], result: CacheResult<unknown>): unknown {
      if (result.kind === "unsupported") {
        return fromSource(args, false);
      }

      if (result.kind === "empty" && !layer.complete) {
        return fromSource(args, true);
      }

      const value = result.kind === "completed" ? result.value : undefined;
      const list = isList(value);

      // A managed layer holds single entities, so only a complete snapshot answers lists, unless this work wrote them.
      if (list && entity !== undefined && !layer.complete) {
        return fromSource(args, false);
      }

      if (context.touched(value)) {
        return fromSource(args, false);
      }

      if (layer.complete && (list || value === undefined) && wroteEntity()) {
        return fromSource(args, false);
      }

      return value;
    }

    return ((...args: never[]) => {
      if (layer.recovering !== undefined) {
        return source(...args);
      }

      if (layer.unavailable) {
        void layer.recover();
        return source(...args);
      }

      if (!layer.ready) {
        return source(...args);
      }

      let cached: unknown;

      try {
        cached = read(...args);
      } catch (error) {
        layer.fail(error);
        return source(...args);
      }

      if (!isThenable(cached)) {
        return answer(args, asCacheResult(cached));
      }

      return layer.untilLost(Promise.resolve(cached)).then(
        (value) => (value === storeLost ? source(...args) : answer(args, asCacheResult(value))),
        (error: unknown) => {
          layer.fail(error);
          return source(...args);
        },
      );
    }) as ReaderFunction;
  }

  const reads = new Map<ReaderDefinition, string>(memberOf);

  if (isReader(loader) && !reads.has(loader)) {
    reads.set(loader, "load");
  }

  const startup =
    loader === undefined
      ? undefined
      : layerStartup({
          layer: activation,
          requirements: { state: activation } as Requirements,
          reads: isReader(loader) ? [loader] : [],
          start: ({ state }, below) => {
            const layer = state as Layer;
            layer.complete = isReader(loader) && options.include === undefined;
            layer.snapshot = isReader(loader)
              ? (below(loader) as () => unknown)
              : () => (loader as (dependencies: unknown) => unknown)(layer.dependencies);
            const loading = layer.recover();
            return options.startup === "blocking" ? loading : undefined;
          },
        });

  return Object.freeze({
    ...Object.fromEntries(
      [...reads].map(([reader, member]) => [
        `read:${member}`,
        decorate(reader, {
          requirements: { state: activation, changes: unitOfWorkChanges } as Requirements,
          wrap: (inner: unknown, { state, changes }: Readonly<Record<string, unknown>>) => {
            const next = inner as ReaderFunction;
            return layered(
              activation,
              attach(reader, next, state as Layer, changes as UnitOfWorkChanges) ?? next,
              next,
            );
          },
        } as never),
      ]),
    ),
    ...(startup === undefined ? {} : { startup }),
    state: activation,
    health,
  }) as unknown as CacheLayer;
}
