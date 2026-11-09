# @openknot-ts/outbox

The transactional outbox. A port's publications are stored in the same transaction as the change that published them and delivered through the native publisher after commit, so a committed event survives a crash, a deploy or a broker outage. Delivery is at least once and strictly ordered per outbox name.

## Usage

Command code is unchanged: it keeps calling `ctx.roleEvents.publish(event)`. The application lists `outbox()` in place of the native publisher plug, and a store plug such as [`@openknot-ts/drizzle-outbox`](../../openknot-plugs/drizzle/drizzle-outbox/README.md) supplies `outboxStore`.

```ts
import { drizzleOutbox } from "@openknot-ts/drizzle-outbox/sqlite";
import { outbox } from "@openknot-ts/outbox";

const roleEventsRabbit = rabbitPublisher({ exchange: "roles", routingKey: "role.changed" }, roleEvents);

export const channels = providePlugs([
  outbox({ name: "role-events", plug: roleEventsRabbit, connection: rabbitConnection }),
]);

export const io = providePlugs([roleReaders, roleWriters, drizzleOutbox({ transaction })]);
```

## API

| Entry | Export | Description |
| --- | --- | --- |
| `@openknot-ts/outbox` | `outbox({ name, plug, connection?, batchSize? })` | Stores the plug's publications and dispatches them. `batchSize` (default 100) bounds one claim. |
| | `outboxControl` | `stuck(attempts, name?)` lists stuck records, `discard(id)` drops one, `deliver(name)` delivers a name again now. |
| | `outboxStore`, `OutboxStore`, `StuckRecord` | The store contract for plugs. |
| `@openknot-ts/outbox/health` | `outboxHealth({ name?, outbox?, attempts?, timeoutMs? })` | Down while a record reached `attempts` (default 5) failed sends, across the store or for one `outbox` name. |

## Delivery

```text
publish(event) → staged → end of beforeCommit: outboxStore.save() in the same transaction → commit
→ the Unit of Work completes: claim → native publish(message, { messageId: record.id }) → delete the record
```

| Trigger | Action |
| --- | --- |
| a Unit of Work that published commits | delivers its records, older records of the name first |
| startup | delivers what a previous run left |
| a successful delivery | continues with the name's next records |
| `connection` restored | delivers what an outage left |
| `outboxControl.deliver(name)` | delivers a name now |
| another instance's lease ends | delivers what it claimed, such as a record it was sending when it crashed |
| stop | waits for the send in flight; the rest waits for the next startup |

There is no polling; the only timer follows another owner's lease by the database clock. Each name has one dispatcher, built at startup from the native plug's requirements, so it drains before the native publisher closes.

## Rules

- The request completes with the commit and never waits for the broker.
- Messages are JSON values; the native publisher always receives the stored JSON form.
- `messageId` is the record id, in `PublishOptions` and in a listener's trigger metadata. Non-idempotent listeners check it.
- A publication outside a Unit of Work, or outside the store's transaction, fails and rolls back. `publishNow` stores its record at once.
- Names are stable and unique (a duplicate fails startup), and two services sharing a table must not share a name.
- A failed send records the attempt and error and keeps the record in place, holding its name. Nothing skips a record automatically.
- Several instances share the table through claims: one owner per name until its lease ends. The dispatcher renews the claim before each send and stops if another owner took over.
- Records are ordered by insertion; concurrent transactions on one name become visible in commit order, so order holds for events the application serializes.
- Deliveries run in the dispatcher's own context; each record carries its own trace propagation.
- `connection` accepts any `ConnectionWatch` from `@openknot-ts/wire`, such as `rabbitConnection` or a Redis client's `connection`.
- Event schemas must evolve compatibly: records written before a deploy are delivered after it.

## Store contract

`outboxStore` is a `unit.contract<OutboxStore>()` with `save`, `claim`, `renew`, `heldFor`, `complete`, `attempted`, `release`, `stuck` and `discard`. `save` joins the current Unit of Work's native transaction and rejects outside it; `claim` returns the oldest records of a name and holds it for one owner until the lease ends; `renew` extends the claim and reports whether it is still the owner's; `heldFor` reports how long another owner's lease has left.

## Tests

[test/outbox.test.ts](test/outbox.test.ts) covers commit, rollback, the JSON shape, ordered redelivery, startup recovery, a crashed instance's lease, draining on stop, duplicate names, health and control.
