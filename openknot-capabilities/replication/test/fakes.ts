import type {
  ReplicaChange,
  ReplicaMarker,
  ReplicaStore,
  ReplicationChannel,
  ReplicationHandlers,
  ReplicationMessage,
} from "../src/index.ts";
import { ReplicaFenced } from "../src/index.ts";
import type { Lease, Lock, LockResult } from "@openknot-ts/lock";
import type { ConnectionWatch } from "@openknot-ts/wire";
import { randomUUID } from "node:crypto";

interface Hold {
  readonly captured: () => void;
  readonly released: Promise<void>;
}

/** A hold the next matching store call captures; that call resolves once `release` is called. */
function createHold() {
  let captured: () => void = () => undefined;
  const reading = new Promise<void>((resolve) => {
    captured = resolve;
  });
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hold: Hold = { captured, released };
  return { hold, controls: { reading, release } };
}

async function pass(held: Hold | undefined): Promise<void> {
  if (held === undefined) {
    return;
  }
  held.captured();
  await held.released;
}

interface Stored {
  readonly order: ReplicaChange["order"];
  readonly value?: unknown;
}

/** One shared in-process store; each instance connects with its own controls. */
export function memoryStore() {
  let runId = randomUUID();
  let markerHold: Hold | undefined;
  let markHold: Hold | undefined;
  let applyHold: Hold | undefined;
  let dropHold: Hold | undefined;
  let clearHold: Hold | undefined;
  const spaces = new Map<string, Map<string, Stored>>();
  /** Each completed `apply` call's changes, in order. */
  const applies: (readonly ReplicaChange[])[] = [];
  const markers = new Map<string, ReplicaMarker>();
  const drops = new Map<string, number>();
  const markerReadHolds: { readonly keyspace: string; remaining: number; readonly hold: Hold }[] = [];
  const dropWaiters: { readonly keyspace: string; readonly times: number; readonly resolve: () => void }[] = [];
  function checkFence(keyspace: string, fence: string | undefined): void {
    if (fence !== undefined && markers.get(keyspace)?.holder !== fence) {
      throw ReplicaFenced(keyspace);
    }
  }
  const keyOf = (entity: string, id: unknown) => `${entity}\u0000${typeof id}\u0000${String(id)}`;
  function space(keyspace: string): Map<string, Stored> {
    let found = spaces.get(keyspace);
    if (found === undefined) {
      found = new Map();
      spaces.set(keyspace, found);
    }
    return found;
  }
  function connect() {
    let getHold: Hold | undefined;
    let failApply = false;
    let failGet = false;
    let outage: ReturnType<typeof createHold> | undefined;
    const watchers = new Set<Parameters<ConnectionWatch["watch"]>[0]>();
    const calls: string[] = [];
    const store: ReplicaStore & { readonly connection: ConnectionWatch } = {
      connection: {
        watch(handlers) {
          watchers.add(handlers);
          return () => watchers.delete(handlers);
        },
      },
      async runId() {
        calls.push("runId");
        if (outage !== undefined) {
          await pass(outage.hold);
        }
        return runId;
      },
      async marker(keyspace) {
        calls.push("marker");
        if (outage !== undefined) {
          await pass(outage.hold);
        }
        const counted = markerReadHolds.find((each) => each.keyspace === keyspace);
        if (counted !== undefined && --counted.remaining === 0) {
          markerReadHolds.splice(markerReadHolds.indexOf(counted), 1);
          await pass(counted.hold);
        }
        const held = markerHold;
        markerHold = undefined;
        await pass(held);
        return markers.get(keyspace);
      },
      async mark(keyspace, marker, fence) {
        calls.push("mark");
        if (outage !== undefined) {
          await pass(outage.hold);
        }
        const held = markHold;
        markHold = undefined;
        await pass(held);
        checkFence(keyspace, fence);
        const holder = marker.holder ?? markers.get(keyspace)?.holder;
        markers.set(keyspace, { ...marker, ...(holder === undefined ? {} : { holder }) });
      },
      async apply(keyspace, changes, fence) {
        calls.push("apply");
        if (outage !== undefined) {
          await pass(outage.hold);
        }
        if (failApply) {
          failApply = false;
          throw new Error("store unavailable");
        }
        const held = applyHold;
        applyHold = undefined;
        await pass(held);
        checkFence(keyspace, fence);
        applies.push(changes);
        const target = space(keyspace);
        const applied: ReplicaChange[] = [];
        for (const change of changes) {
          const key = keyOf(change.entity, change.id);
          const stored = target.get(key);
          const newer =
            stored === undefined ||
            change.order > stored.order ||
            (change.order === stored.order && change.type === "delete" && stored.value !== undefined);
          if (!newer) {
            continue;
          }
          target.set(
            key,
            change.type === "set" ? { order: change.order, value: change.value } : { order: change.order },
          );
          applied.push(change);
        }
        return applied;
      },
      async clear(keyspace, fence) {
        calls.push("clear");
        if (outage !== undefined) {
          await pass(outage.hold);
        }
        const held = clearHold;
        clearHold = undefined;
        await pass(held);
        checkFence(keyspace, fence);
        spaces.delete(keyspace);
      },
      async get(keyspace, entity, id) {
        calls.push("get");
        if (outage !== undefined) {
          await pass(outage.hold);
        }
        if (failGet) {
          failGet = false;
          throw new Error("store read unavailable");
        }
        const value = spaces.get(keyspace)?.get(keyOf(entity, id))?.value;
        const held = getHold;
        getHold = undefined;
        await pass(held);
        return value;
      },
      async list(keyspace) {
        calls.push("list");
        if (outage !== undefined) {
          await pass(outage.hold);
        }
        return [...(spaces.get(keyspace)?.values() ?? [])].flatMap((stored) =>
          stored.value === undefined ? [] : [stored.value],
        );
      },
      async drop(keyspace) {
        calls.push("drop");
        if (outage !== undefined) {
          await pass(outage.hold);
        }
        const heldDrop = dropHold;
        dropHold = undefined;
        await pass(heldDrop);
        spaces.delete(keyspace);
        markers.delete(keyspace);
        const times = (drops.get(keyspace) ?? 0) + 1;
        drops.set(keyspace, times);
        for (const waiter of dropWaiters) {
          if (waiter.keyspace !== keyspace || waiter.times !== times) {
            continue;
          }
          dropWaiters.splice(dropWaiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      },
    };
    return {
      store,
      calls,
      watchers,
      lose() {
        outage = createHold();
        for (const watcher of watchers) {
          watcher.lost();
        }
        return outage.controls;
      },
      restore() {
        outage?.controls.release();
        outage = undefined;
        for (const watcher of watchers) {
          watcher.restored();
        }
      },
      failNextGet() {
        failGet = true;
      },
      failNextApply() {
        failApply = true;
      },
      /** The next read captures its value and resolves once released. */
      holdNextGet() {
        const { hold, controls } = createHold();
        getHold = hold;
        return controls;
      },
    };
  }
  return {
    spaces,
    markers,
    applies,
    connect,
    /** Resolves when `keyspace` has been dropped `times` times; subscribe before the action that drops it. */
    dropped(keyspace: string, times: number): Promise<void> {
      return new Promise((resolve) => dropWaiters.push({ keyspace, times, resolve }));
    },
    holdNextMarker() {
      const { hold, controls } = createHold();
      markerHold = hold;
      return controls;
    },
    /** Holds the given read of a keyspace's marker, counted from this call; it reads the marker once released. */
    holdMarkerRead(keyspace: string, read: number) {
      const { hold, controls } = createHold();
      markerReadHolds.push({ keyspace, remaining: read, hold });
      return controls;
    },
    holdNextDrop() {
      const { hold, controls } = createHold();
      dropHold = hold;
      return controls;
    },
    holdNextClear() {
      const { hold, controls } = createHold();
      clearHold = hold;
      return controls;
    },
    holdNextMark() {
      const { hold, controls } = createHold();
      markHold = hold;
      return controls;
    },
    holdNextApply() {
      const { hold, controls } = createHold();
      applyHold = hold;
      return controls;
    },
    restart() {
      runId = randomUUID();
      spaces.clear();
      markers.clear();
    },
  };
}

/** An in-process broadcast; each instance connects with its own subscription controls. */
export function memoryBus() {
  const subscribers = new Map<ReplicationHandlers, { readonly drops: Set<ReplicationMessage["type"]> }>();
  const waiters: { readonly match: (message: ReplicationMessage) => boolean; readonly resolve: () => void }[] = [];
  function next(match: (message: ReplicationMessage) => boolean): Promise<void> {
    return new Promise((resolve) => waiters.push({ match, resolve }));
  }
  function connect() {
    const drops = new Set<ReplicationMessage["type"]>();
    const published: ReplicationMessage[] = [];
    let handlers: ReplicationHandlers | undefined;
    let failNextPublish = false;
    let throwNextPublish = false;
    let publishHold: Hold | undefined;
    const attempts: ReplicationMessage[] = [];
    let resolveClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const channel: ReplicationChannel = {
      async subscribe(own) {
        handlers = own;
        subscribers.set(own, { drops });
        return {
          async close() {
            subscribers.delete(own);
            resolveClosed();
          },
        };
      },
      publish(message) {
        attempts.push(message);
        if (throwNextPublish) {
          throwNextPublish = false;
          throw new Error("publish threw");
        }
        const failing = failNextPublish;
        failNextPublish = false;
        const held = publishHold;
        publishHold = undefined;
        return deliver(message, failing, held);
      },
    };
    /** Delivers before its first await, so an unheld publish is visible to the caller's next line. */
    async function deliver(message: ReplicationMessage, failing: boolean, held: Hold | undefined): Promise<void> {
      if (held !== undefined) {
        await pass(held);
      }
      if (failing) {
        throw new Error("publish failed");
      }
      published.push(message);
      for (const [subscriber, { drops: dropped }] of subscribers) {
        if (!dropped.has(message.type)) {
          subscriber.message(message);
        }
      }
      for (const waiter of waiters) {
        if (!waiter.match(message)) {
          continue;
        }
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
    return {
      channel,
      closed,
      published,
      /** Every publish call, delivered or failed. */
      attempts,
      drop(type: ReplicationMessage["type"]) {
        drops.add(type);
      },
      lose() {
        handlers?.lost();
      },
      restore() {
        handlers?.restored();
      },
      failNextPublish() {
        failNextPublish = true;
      },
      /** The next publish call throws instead of returning a promise. */
      throwNextPublish() {
        throwNextPublish = true;
      },
      /** The next publish call waits until released; a failure set before that call applies after the release. */
      holdNextPublish() {
        const { hold, controls } = createHold();
        publishHold = hold;
        return controls;
      },
    };
  }
  return { connect, next };
}

/** A lock shared by the instances of one test. */
export function memoryLock() {
  const held = new Map<string, string>();
  const leases: { readonly token: string; readonly finished: Promise<void> }[] = [];
  let releaseHold: Hold | undefined;
  return {
    leases,
    expire(name: string) {
      held.delete(name);
    },
    /** The next acquired lock's release is issued and settles once released, as a native offline queue answers it. */
    holdNextRelease() {
      const { hold, controls } = createHold();
      releaseHold = hold;
      return controls;
    },
    async tryRun<T>(
      name: string,
      _options: { readonly leaseMs: number },
      work: (lease: Lease) => Promise<T>,
    ): Promise<LockResult<T>> {
      if (held.has(name)) {
        return { acquired: false };
      }
      const token = randomUUID();
      held.set(name, token);
      const finished = Promise.withResolvers<void>();
      leases.push({ token, finished: finished.promise });
      try {
        return { acquired: true, value: await work({ token }) };
      } finally {
        const release = releaseHold;
        releaseHold = undefined;
        if (release !== undefined) {
          await pass(release);
        }
        if (held.get(name) === token) {
          held.delete(name);
        }
        finished.resolve();
      }
    },
  } satisfies Lock & {
    readonly leases: typeof leases;
    expire(name: string): void;
    holdNextRelease(): ReturnType<typeof createHold>["controls"];
  };
}
