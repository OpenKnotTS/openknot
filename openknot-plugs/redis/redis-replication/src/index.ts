import { ReplicaFenced } from "@openknot-ts/replication";
import type {
  ReplicaChange,
  ReplicaMarker,
  ReplicaStore,
  ReplicationChannel,
  ReplicationMessage,
} from "@openknot-ts/replication";
import { createHash } from "node:crypto";
import type { RedisClient, RedisClientType } from "redis";

export type ReplicaCommands = {
  sendCommand(...args: Parameters<RedisClientType["sendCommand"]>): ReturnType<RedisClientType["sendCommand"]>;
};

export type ReplicaSubscriber = {
  subscribe: typeof RedisClient.prototype.subscribe<false>;
  unsubscribe: typeof RedisClient.prototype.unsubscribe<false>;
  on(...args: Parameters<RedisClientType["on"]>): void;
  off(...args: Parameters<RedisClientType["off"]>): void;
};

export interface ReplicaStoreOptions {
  readonly prefix?: string | undefined;
  /** How long a tombstone outlives its entity, in milliseconds; defaults to one hour. */
  readonly tombstoneTtl?: number | undefined;
  readonly encode?: ((state: unknown) => string) | undefined;
  readonly decode?: ((text: string) => unknown) | undefined;
  readonly connection?: ReplicaStore["connection"];
}

/** A Lua script with its precomputed SHA1. */
const script = (text: string) => ({ text, sha: createHash("sha1").update(text).digest("hex") });

/** Clients reject with their own error types, so a rejection is recognized by its message alone. */
function messageOf(error: unknown): string {
  return typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error);
}

async function runScript(
  commands: ReplicaCommands,
  keyspace: string,
  { text, sha }: ReturnType<typeof script>,
  keys: readonly string[],
  args: readonly string[],
): Promise<unknown> {
  try {
    try {
      return await commands.sendCommand(["EVALSHA", sha, String(keys.length), ...keys, ...args]);
    } catch (error) {
      if (!messageOf(error).startsWith("NOSCRIPT")) {
        throw error;
      }
    }

    return await commands.sendCommand(["EVAL", text, String(keys.length), ...keys, ...args]);
  } catch (error) {
    if (messageOf(error).includes("REPLICA_FENCED")) {
      throw ReplicaFenced(keyspace);
    }

    throw error;
  }
}

// KEYS[1] is the marker key, followed by the (values, orders, tombstone) triples.
// ARGV[1] is the ttl and ARGV[2] the fence ("" for none).
const applyScript = script(`
if ARGV[2] ~= '' and redis.call('HGET', KEYS[1], 'holder') ~= ARGV[2] then return redis.error_reply('REPLICA_FENCED') end
local applied = {}
for index = 1, (#KEYS - 1) / 3 do
  local values, orders, tomb = KEYS[index * 3 - 1], KEYS[index * 3], KEYS[index * 3 + 1]
  local field, kind, order, value = ARGV[index * 4 - 1], ARGV[index * 4], ARGV[index * 4 + 1], ARGV[index * 4 + 2]
  local live = redis.call('HGET', orders, field)
  local dead = redis.call('GET', tomb)
  local newer
  if kind == 'set' then
    newer = (not live or order > live) and (not dead or order > dead)
  else
    newer = (not live or order >= live) and (not dead or order > dead)
  end
  if newer then
    if kind == 'set' then
      redis.call('HSET', values, field, value)
      redis.call('HSET', orders, field, order)
      redis.call('DEL', tomb)
    else
      redis.call('HDEL', values, field)
      redis.call('HDEL', orders, field)
      redis.call('SET', tomb, order, 'PX', ARGV[1])
    end
    applied[#applied + 1] = index
  end
end
return applied
`);

const markScript = script(`
if ARGV[3] ~= '' and redis.call('HGET', KEYS[1], 'holder') ~= ARGV[3] then return redis.error_reply('REPLICA_FENCED') end
redis.call('HSET', KEYS[1], 'state', ARGV[1], 'dirty', ARGV[2], 'runId', ARGV[4])
if ARGV[5] ~= '' then redis.call('HSET', KEYS[1], 'holder', ARGV[5]) end
return 1
`);

const clearScript = script(`
if redis.call('HGET', KEYS[1], 'holder') ~= ARGV[1] then return redis.error_reply('REPLICA_FENCED') end
if #KEYS > 1 then redis.call('UNLINK', unpack(KEYS, 2)) end
return 1
`);

const orderLimit = 10n ** 20n;

/** Orders as strings that Redis compares in the same order: padded integers, then strings. */
export function encodeOrder(order: ReplicaChange["order"]): string {
  if (typeof order === "string") {
    return `s${order}`;
  }

  const value = typeof order === "bigint" ? order : Number.isSafeInteger(order) ? BigInt(order) : undefined;

  if (value === undefined || value < 0n || value >= orderLimit) {
    throw new TypeError("A Redis replica order is a string or a non-negative integer below 10^20");
  }

  return `n${value.toString().padStart(20, "0")}`;
}

const field = (id: ReplicaChange["id"]) => `${typeof id}:${String(id)}`;

export function encodeMessage(message: ReplicationMessage): string {
  return JSON.stringify(message, (_key, value: unknown) =>
    typeof value === "bigint" ? { $bigint: value.toString() } : value,
  );
}

export function decodeMessage(text: string): ReplicationMessage | undefined {
  let value: unknown;

  try {
    value = JSON.parse(text, (_key, item: unknown) =>
      typeof item === "object" && item !== null && typeof (item as { $bigint?: unknown }).$bigint === "string"
        ? BigInt((item as { readonly $bigint: string }).$bigint)
        : item,
    );
  } catch {
    return undefined;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const { type, origin, keyspace, changes } = value as Partial<Record<string, unknown>>;

  if (typeof origin !== "string" || typeof keyspace !== "string") {
    return undefined;
  }

  if (type === "clear" || type === "ready") {
    return value as ReplicationMessage;
  }

  if (type !== "changes" || !Array.isArray(changes)) {
    return undefined;
  }

  if (
    !changes.every((change: unknown) => {
      if (typeof change !== "object" || change === null || Array.isArray(change)) {
        return false;
      }

      return (
        "entity" in change &&
        typeof change.entity === "string" &&
        "id" in change &&
        (typeof change.id === "string" ||
          typeof change.id === "bigint" ||
          (typeof change.id === "number" && Number.isFinite(change.id))) &&
        "order" in change &&
        (typeof change.order === "string" ||
          typeof change.order === "bigint" ||
          (typeof change.order === "number" && Number.isFinite(change.order))) &&
        "type" in change &&
        (change.type === "set" || change.type === "delete")
      );
    })
  ) {
    return undefined;
  }

  return value as ReplicationMessage;
}

function pairs(reply: unknown): Readonly<Record<string, string>> {
  if (Array.isArray(reply)) {
    const entries: [string, string][] = [];

    for (let index = 0; index + 1 < reply.length; index += 2) {
      entries.push([String(reply[index]), String(reply[index + 1])]);
    }

    return Object.fromEntries(entries);
  }

  return typeof reply === "object" && reply !== null
    ? Object.fromEntries(Object.entries(reply).map(([key, value]) => [key, String(value)]))
    : {};
}

export function redisReplicaStoreOf(commands: ReplicaCommands, options: ReplicaStoreOptions = {}): ReplicaStore {
  const prefix = options.prefix ?? "openknot:replica";
  const ttl = options.tombstoneTtl ?? 3_600_000;

  if (!Number.isSafeInteger(ttl) || ttl <= 0) {
    throw new TypeError("A tombstone TTL is a positive integer");
  }

  const encode = options.encode ?? ((state: unknown) => JSON.stringify(state));
  const decode = options.decode ?? ((text: string) => JSON.parse(text) as unknown);
  // The hash tag keeps a keyspace in one cluster slot, so its scripts may touch all of its keys.
  const base = (keyspace: string) => `${prefix}:{${keyspace}}`;
  /** A SCAN pattern of a keyspace's keys; a keyspace may contain glob characters. */
  const keysOf = (keyspace: string) => `${base(keyspace).replace(/[*?[\]\\]/g, "\\$&")}:*`;
  const values = (keyspace: string, entity: string) => `${base(keyspace)}:values:${entity}`;
  const orders = (keyspace: string, entity: string) => `${base(keyspace)}:orders:${entity}`;
  const tomb = (keyspace: string, entity: string, id: ReplicaChange["id"]) =>
    `${base(keyspace)}:tomb:${JSON.stringify([entity, field(id)])}`;
  const marker = (keyspace: string) => `${base(keyspace)}:marker`;

  return Object.freeze({
    async runId() {
      const info = String(await commands.sendCommand(["INFO", "server"]));
      const match = /run_id:([0-9a-f]+)/.exec(info);
      if (match === null) {
        throw new Error("The Redis server reported no run_id");
      }
      return match[1]!;
    },
    async marker(keyspace: string): Promise<ReplicaMarker | undefined> {
      const stored = pairs(await commands.sendCommand(["HGETALL", marker(keyspace)]));

      if (stored.state !== "loading" && stored.state !== "complete") {
        return undefined;
      }

      return {
        state: stored.state as "loading" | "complete",
        dirty: stored.dirty === "1",
        runId: stored.runId ?? "",
        ...(stored.holder === undefined ? {} : { holder: stored.holder }),
      };
    },
    async mark(keyspace: string, value: ReplicaMarker, fence?: string) {
      const key = marker(keyspace);

      if (fence === undefined) {
        const cmd = ["HSET", key, "state", value.state, "dirty", value.dirty ? "1" : "0", "runId", value.runId];

        if (value.holder !== undefined) {
          cmd.push("holder", value.holder);
        }

        await commands.sendCommand(cmd);
        return;
      }

      await runScript(
        commands,
        keyspace,
        markScript,
        [key],
        [value.state, value.dirty ? "1" : "0", fence, value.runId, value.holder ?? ""],
      );
    },
    async apply(keyspace: string, changes: readonly ReplicaChange[], fence?: string) {
      if (changes.length === 0 && fence === undefined) {
        return [];
      }

      const keys = [
        marker(keyspace),
        ...changes.flatMap((change) => [
          values(keyspace, change.entity),
          orders(keyspace, change.entity),
          tomb(keyspace, change.entity, change.id),
        ]),
      ];

      const argv = changes.flatMap((change) => [
        field(change.id),
        change.type,
        encodeOrder(change.order),
        change.type === "set" ? encode(change.value) : "",
      ]);

      const applied = (await runScript(commands, keyspace, applyScript, keys, [
        String(ttl),
        fence ?? "",
        ...argv,
      ])) as readonly unknown[];

      return applied.map((index) => changes[Number(index) - 1]!);
    },
    async get(keyspace: string, entity: string, id: ReplicaChange["id"]) {
      const stored = await commands.sendCommand(["HGET", values(keyspace, entity), field(id)]);
      return stored === null || stored === undefined ? undefined : decode(String(stored));
    },
    async list(keyspace: string, entity: string) {
      const stored = (await commands.sendCommand(["HVALS", values(keyspace, entity)])) as readonly unknown[];
      return stored.map((text) => decode(String(text)));
    },
    async clear(keyspace: string, fence: string) {
      const key = marker(keyspace);
      let cursor = "0";
      do {
        const [next, found] = (await commands.sendCommand([
          "SCAN",
          cursor,
          "MATCH",
          keysOf(keyspace),
          "COUNT",
          "500",
        ])) as [unknown, readonly unknown[]];
        cursor = String(next);
        // Runs for an empty batch too: a stale fence rejects even when nothing matches.
        const batch = found.map(String).filter((entry) => entry !== key);
        await runScript(commands, keyspace, clearScript, [key, ...batch], [fence]);
      } while (cursor !== "0");
    },
    async drop(keyspace: string) {
      let cursor = "0";
      do {
        const [next, found] = (await commands.sendCommand([
          "SCAN",
          cursor,
          "MATCH",
          keysOf(keyspace),
          "COUNT",
          "500",
        ])) as [unknown, readonly unknown[]];

        cursor = String(next);

        if (found.length > 0) {
          await commands.sendCommand(["UNLINK", ...found.map(String)]);
        }
      } while (cursor !== "0");
    },
    ...(options.connection === undefined ? {} : { connection: options.connection }),
  } as ReplicaStore);
}

export function redisReplicationChannelOf(
  connections: { readonly commands: ReplicaCommands; readonly subscriber: ReplicaSubscriber },
  options: { readonly channel?: string } = {},
): ReplicationChannel {
  const name = options.channel ?? "openknot:replication";
  return Object.freeze({
    async publish(message: ReplicationMessage) {
      await connections.commands.sendCommand(["PUBLISH", name, encodeMessage(message)]);
    },
    async subscribe(handlers: Parameters<ReplicationChannel["subscribe"]>[0]) {
      let lost = false;

      // The channel carries only replication messages; anything else on it is not addressed to this replication.
      const listener = (text: string) => {
        const message = decodeMessage(text);
        if (message !== undefined) {
          handlers.message(message);
        }
      };

      const reconnecting = () => {
        if (lost) {
          return;
        }
        lost = true;
        handlers.lost();
      };

      const ready = () => {
        if (!lost) {
          return;
        }
        lost = false;
        handlers.restored();
      };

      const detach = () => {
        connections.subscriber.off("reconnecting", reconnecting);
        connections.subscriber.off("ready", ready);
      };
      connections.subscriber.on("reconnecting", reconnecting);
      connections.subscriber.on("ready", ready);
      try {
        await connections.subscriber.subscribe(name, listener);
      } catch (error) {
        detach();
        throw error;
      }

      return {
        async close() {
          detach();
          await connections.subscriber.unsubscribe(name, listener);
        },
      };
    },
  });
}
