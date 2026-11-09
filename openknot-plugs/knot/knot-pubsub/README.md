# @openknot-ts/knot-pubsub

Local delivery for Flow's `topic()` and `broadcast()` contracts over an `EventEmitter` the application provides. Each subscription is a native bounded `ReadableStream`. Flow owns admission and recipients; this package owns subscription resources and delivery.

## Usage

```ts
import { inMemoryBroadcast, inMemoryTopic } from "@openknot-ts/knot-pubsub";
import { plug, resource, unit } from "@openknot-ts/wire";
import { EventEmitter } from "node:events";

const events = unit({ factory: () => new EventEmitter() });

const roleDelivery = resource({
  requirements: { events },
  initialize: ({ events }) =>
    inMemoryTopic<RoleAudience, RoleEvent>({
      events,
      event: (key) => `roles:${JSON.stringify([key.userId, key.roleId])}`,
      capacity: 64,
    }),
});

const logDelivery = resource({
  requirements: { events },
  initialize: ({ events }) => inMemoryBroadcast<LogEvent>({ events, event: "logs" }),
});

const roleBinding = plug({ port: roleTopic, requirements: { roleDelivery }, bind: ({ roleDelivery }) => roleDelivery });
const logBinding = plug({ port: logBroadcast, requirements: { logDelivery }, bind: ({ logDelivery }) => logDelivery });
```

List them through `providePlugs()`; Wire acquires the deliveries as resources. [examples/topics.ts](examples/topics.ts) shows the full composition with guarded subscriptions.

## API

| Export | Description |
| --- | --- |
| `inMemoryTopic<Key, Message>({ events, event, capacity? })` | A topic. `event(key)` encodes a key to a native event name (`NodeEventName`): equal names share a route. Exposes `keys()` and `subscriberCount(key)`. |
| `inMemoryBroadcast<Message>({ events, event, capacity? })` | A broadcast. Exposes `subscriberCount()`. |
| `SlowSubscriberError` | Ends a subscription whose queue is full. |
| `InMemoryTopic`, `InMemoryTopicOptions`, `InMemoryBroadcast`, `InMemoryBroadcastOptions`, `InMemoryPubSubOptions` | Types. |

`keys()` is a current view of active routes. To let Flow choose recipients, expose it through an ordinary reader plug:

```ts
plug({ port: roleRecipients, bind: () => (roleId) => roleDelivery.keys().filter((key) => key.roleId === roleId) });
```

## With tRPC

Subscription procedures return the native iterable; `access` is the port's named guard input.

```ts
roles: trpc.procedure.input(roleAudienceSchema).subscription(({ input, ctx, signal }) =>
  roleTopic.subscribe({ input, access: ctx.token, signal: AbortSignal.any([ctx.signal, signal ?? ctx.signal]) }),
),
```

Flow runs the guards in a short scope before opening delivery, and releases admission resources before the stream is consumed.

## Delivery

- A subscription registers immediately: publications after `subscribe()` returns are queued before the first `next()`.
- Each queue holds `capacity` messages (default 64). A full queue ends that subscriber with `SlowSubscriberError`; others continue.
- Iterator return, `break`, the lifetime signal and resource release remove native listeners and discard queued messages.
- Publication emits synchronously to current listeners and does not wait for receipt.
- Transient and in-process: no history, replay, acknowledgment or cross-process delivery. The emitter and its listener limit stay application-owned.

## Example and tests

```sh
pnpm build
pnpm --filter @openknot-ts/knot-pubsub example
pnpm --filter @openknot-ts/knot-pubsub test
```

The tests cover routing, recipient inspection, overflow, cancellation, Flow admission, commit staging and real tRPC WebSockets ([test/trpc.test.ts](test/trpc.test.ts)).
