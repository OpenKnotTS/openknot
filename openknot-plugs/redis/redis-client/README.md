# @openknot-ts/redis-client

Manages application-created node-redis command and subscription clients as a Wire resource, with a connection watch and a health check. Types derive from the SDK.

## Usage

```ts
const redis = redisClient({
  requirements: { settings },
  create: ({ settings }) => ({
    commands: createClient({ url: settings.REDIS_URL }).on("error", report),
    subscriber: createClient({ url: settings.REDIS_URL }).on("error", report),
  }),
});
```

## API

| Export | Description |
| --- | --- |
| `redisClient({ requirements?, create })` | The clients as a resource. Resolves to them plus `connection`. |
| `redisHealthCheck({ redis, name?, timeoutMs? })` | `PING` must answer `PONG` within the check's deadline (one second by default). |
| `redisConnectionOf(client)` | A `ConnectionWatch` for a client this resource does not manage. |
| `RedisConnections`, `RedisCommands`, `RedisSubscriber` | Types. |

## Lifecycle

- Both clients connect at acquisition. A client's first error before it is ready fails startup; once ready, its native reconnection applies.
- A failed or cancelled startup destroys both. Release closes each once: a ready client first receives the replies to the commands it already sent, a client that is not ready is destroyed at once, and a connection that fails while closing ends the release with its error.
- node-redis's command `timeout` only covers sending. Set `socket.socketTimeout` with `pingInterval` so a server that stops answering cannot hold a command, or the application's stop.
- Consumers share the resource through `requirements`; cache adapters never close it.

## Connection

`connection` is a `ConnectionWatch` from `@openknot-ts/wire`, which `@openknot-ts/cache`, `@openknot-ts/replication` and the outbox accept:

```ts
export const replicaStorage = redisReplicaStore({
  requirements: { redis },
  commands: ({ redis }) => redis.commands,
  connection: ({ redis }) => redis.connection,
});
```

`connection.watch({ lost, restored })` returns an unsubscribe. It follows the commands client: `reconnecting` or `end` reports `lost` once, the next `ready` reports `restored`. The subscriber client is not covered.

## Tests

[test/resource.test.ts](test/resource.test.ts) runs without a server. With `REDIS_URL` set, `pnpm --filter @openknot-ts/redis-client test:redis` runs [test/redis.integration.ts](test/redis.integration.ts).
