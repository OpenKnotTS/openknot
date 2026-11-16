# @openknot-ts/redis-pubsub

Delivery for Flow's `topic()` and `broadcast()` contracts across application instances, over Redis sharded Pub/Sub and node-redis clients the application already manages. A message published on any instance reaches the subscribers of its key on every instance. Local fan-out, bounded queues and cancellation come from [`@openknot-ts/knot-pubsub`](../../knot/knot-pubsub/README.md).

## Usage

```ts
import { redisBroadcast, redisTopic } from "@openknot-ts/redis-pubsub";
import { plug, resource } from "@openknot-ts/wire";

const roleDelivery = resource({
  requirements: { redis },
  initialize: ({ redis }) =>
    redisTopic<RoleAudience, RoleEvent>({
      commands: redis.commands,
      subscriber: redis.subscriber,
      connection: redis.connection.subscriber,
      channel: (key) => `roles:${key.roleId}`,
    }),
});

const logDelivery = resource({
  requirements: { redis },
  initialize: ({ redis }) =>
    redisBroadcast<LogEvent>({
      commands: redis.commands,
      subscriber: redis.subscriber,
      connection: redis.connection.subscriber,
      channel: "logs",
    }),
});

const roleBinding = plug({ port: roleTopic, requirements: { roleDelivery }, bind: ({ roleDelivery }) => roleDelivery });
const logBinding = plug({ port: logBroadcast, requirements: { logDelivery }, bind: ({ logDelivery }) => logDelivery });
```

`redis` is a [`@openknot-ts/redis-client`](../redis-client/README.md) resource. Add its `redisHealthCheck({ redis })`, which turns down while the subscriber client is not ready.

## API

| Export | Description |
| --- | --- |
| `redisTopic<Key, Message>({ commands, subscriber, connection, channel, capacity?, encode?, decode? })` | A topic. `channel(key)` names the key's Redis channel: equal channels share a route. |
| `redisBroadcast<Message>({ commands, subscriber, connection, channel, capacity?, encode?, decode? })` | A broadcast on one channel. |
| `SubscriptionLostError` | Ends the subscriptions of an instance whose subscriber connection is lost, and refuses its new ones until the connection is back. |
| `RedisTopic`, `RedisTopicOptions`, `RedisBroadcast`, `RedisBroadcastOptions`, `RedisPubSubOptions`, `RedisPublisher`, `RedisShardedSubscriber` | Types. |

`commands` publishes, `subscriber` subscribes, and `connection` watches the subscriber client. `capacity` bounds each subscription's queue (64 by default). Messages are JSON unless `encode`/`decode` are given; a payload that does not decode is dropped.

## Delivery

- `publish` sends `SPUBLISH` on the key's channel. It does not know which instances listen; Redis delivers to the instances subscribed to that channel.
- An instance sends `SSUBSCRIBE` with its first local subscriber of a channel and `SUNSUBSCRIBE` after its last. A channel's calls run one after another, and `subscribe()` resolves once its channel is subscribed: publications after it returns are delivered.
- Nothing is stored in Redis. An instance's subscriptions end with its connection, so a stopped or crashed instance leaves nothing behind.
- Sharded Pub/Sub needs Redis 7 or later. The clients are standalone node-redis clients; in a Redis Cluster each channel would pick its own shard, but cluster clients are not supported yet.
- Delivery is at most once, with no history or replay: a client that subscribes again reads current state first.
- The bounded queues, `SlowSubscriberError`, cancellation and release are those of `@openknot-ts/knot-pubsub`.

## Outages

The subscriber connection's outage is the delivery's:

- On `lost`, every active subscription ends with `SubscriptionLostError`, since messages published meanwhile are missed, and new subscriptions are refused with it.
- On `restored`, subscriptions open again.
- The resource's health check reports down while the subscriber client is not ready, so a load balancer that probes it moves new connections to other instances.

Publishing follows the commands client: during its outage, node-redis queues or rejects the command as configured.

## Tests

`pnpm --filter @openknot-ts/redis-pubsub test` runs without a server. With `REDIS_URL` set, `pnpm --filter @openknot-ts/redis-pubsub test:redis` runs two instances against Redis, including a dropped subscriber connection ([test/instances.integration.ts](test/instances.integration.ts)).
