# @openknot-ts/redis-replication

Implements the `replicaStore` and `replicationChannel` contracts of [`@openknot-ts/replication`](../../../openknot-capabilities/replication/README.md) over node-redis clients the application already manages.

## Usage

```ts
import { redisReplicaStore, redisReplicationChannel } from "@openknot-ts/redis-replication/wire";

export const replicaStorage = redisReplicaStore({
  requirements: { redis },
  commands: ({ redis }) => redis.commands,
  connection: ({ redis }) => redis.connection,
});

export const replicaChannel = redisReplicationChannel({ requirements: { redis }, connections: ({ redis }) => redis });
```

## API

| Entry | Export | Description |
| --- | --- | --- |
| `/wire` | `redisReplicaStore({ requirements?, commands, connection?, options? })` | The store. `options(dependencies)` returns `ReplicaStoreOptions`: `{ prefix, tombstoneTtl, encode, decode }`. |
| `/wire` | `redisReplicationChannel({ requirements?, connections, channel? })` | The channel; `channel` is a string or `(dependencies) => string`. |
| root | `redisReplicaStoreOf(commands, options?)` | The store over a client directly. |

Pass `connection` (such as `redis.connection` from [`@openknot-ts/redis-client`](../redis-client/README.md)) so the replication learns of an outage at once; without it, commits, shared reads and `stop()` can wait for a held command. See the [replication README](../../../openknot-capabilities/replication/README.md#store-connection).

## Store

- One Lua script applies a batch atomically: a state is stored when newer than the stored state and tombstone, a delete when at least as new.
- Deletes leave tombstones that expire after `tombstoneTtl` (one hour by default).
- Orders are non-negative integers below 10^20, or strings, which sort after integers.
- A keyspace shares one hash tag, so it stays in one cluster slot. The marker is a hash; `runId` is the server's `run_id`.
- States are JSON unless `encode`/`decode` are given.
- Fenced `apply`, `mark` and every `clear` compare the marker's `holder` inside their script and reject with `ReplicaFenced`. An unfenced `mark` is one `HSET`, keeping the stored holder.
- Scripts run through `EVALSHA` and fall back to `EVAL` on `NOSCRIPT`.
- `clear` and `drop` walk the keyspace with `SCAN` and `UNLINK`; `clear` keeps the marker, `drop` removes it.

## Channel

- JSON messages on `openknot:replication`, or `channel`. Bigint keys and orders keep their type.
- Invalid payloads are dropped. The subscriber's `reconnecting` and `ready` report the subscription lost and restored.

## Example and tests

`pnpm --filter @openknot-ts/redis-replication example` runs two instances sharing roles; `pnpm --filter @openknot-ts/redis-replication test:redis` runs the integration tests against `REDIS_URL`. Both use the clients from `examples/native.ts`.
