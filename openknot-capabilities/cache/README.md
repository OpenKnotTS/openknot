# @openknot-ts/cache

Cache layers for readers. A module lists `cache({ ... })` beside the reader plug; it wraps the readers through `decorate()`, and with several layers the first listed is closest to the source. The application keeps its own store, with its storage, TTL and capacity.

## Usage

```ts
export const roleCache = cache({
  entity: "role",
  strategy: "write-through",
  requirements: { localRoles },
  port: reader.compose({ byId: findRole }),
  writers: saveRole,
  persist:
    ({ localRoles }) =>
    (changes) =>
      applyTo(localRoles, changes),
  bind: ({ localRoles }) => ({ byId: (id) => localRoles.get(id) }),
});

export const roleReaders = plug({ port: roleReaderPorts, requirements: { database }, bind });

export const io = providePlugs([roleReaders, roleCache]);
```

## API

`cache({ entity, strategy?, name?, requirements?, port, persist, bind, connection?, writers?, include?, load?, startup?, order? })`

| Option | Description |
| --- | --- |
| `entity` | The `entity` literal of the port's states, checked by TypeScript. |
| `persist` | Applies `set`/`delete`/`clear` changes; calls must take effect in order. |
| `bind` | Reads the store per member: a value, `undefined` for a miss, or `completed`/`empty`/`unsupported`. |
| `strategy` | See below; `read-through` by default. |
| `writers` | Writers whose receipts `write-through` inserts. |
| `include` | Which states the layer keeps; a failing state is removed. |
| `load`, `startup` | Snapshot loading. |
| `order` | Projection for newer-wins; the state's `version` by default. |
| `connection` | A `ConnectionWatch` reporting the store's state. |

The package also exports `completed`, `empty`, `unsupported` and `cacheKey`. The layer's `health` check reports failures as `down` when listed in a module.

## Strategies

| Strategy | Fills | Commits | Lists |
| --- | --- | --- | --- |
| `read-through` | On a miss, once a lower layer answers; inside a Unit of Work after commit, skipped if it wrote the entity | upserts `set`, deletes `delete` | next layer |
| `write-through` | From the committed receipts of `writers` | other upserts and deletes evict | next layer |
| `snapshot` | At startup through `load`: a reader loads a complete set, a function a partial one | upserts `set`, deletes `delete` | from the store when complete |

A snapshot with `include` is partial. `startup: "blocking"` waits for the load; with `"background"` reads go to the source until it completes. Large loads may return pages as an async iterable.

## Commits and reads

- Committed changes reach every layer after commit hooks and before effects and publications. The command waits for each available layer's `persist` until its store is reported lost. An `afterCommit` hook of `unitOfWork({ hooks })` still reads the old state; an effect from `ctx.uow.afterCommit` reads the new one.
- `undefined` is the only miss; `null` is a hit, so map nil answers to `undefined`: `byId: async (id) => (await client.get(id)) ?? undefined`. `completed(undefined)` answers known absence. Empty source answers fill nothing.
- Newer changes win by `order`. While writes or fills are in flight the layer keeps the newest order, so a late write cannot overwrite a newer state or revive a deleted one. Entities without an order are evicted on commit.
- Inside a Unit of Work, a cached result containing an entity it wrote is read from the source; a complete snapshot sends lists and absence to the source once it wrote that entity.

## Single-flight

- Concurrent misses of the same member and arguments share one source read. Reads inside a Unit of Work share only within it, and stop sharing once it writes the entity.
- A committed change retires outside flights of every layer of that entity, so a read after the command returns starts fresh.
- A follower whose leader fails, or whose shared result contains an entity its Unit of Work wrote, reads the source itself.

## Result keys

Ports that return other results cache them by `cacheKey(...args)`, without `entity` and without following commits. `cacheKey` encodes `undefined`, `null`, booleans, numbers, bigints, strings, valid dates, arrays and plain objects (property order ignored, `-0` distinct from `0`), and returns `undefined` for anything else, which bypasses caching.

## Availability

- A failing store makes the layer unavailable: reads continue below and commands do not fail. Failures become spans with tracing.
- After `lost`, the layer makes no store calls and ends every wait on the store; commands and stop finish behind a lost store.
- `restored` starts a recovery, which clears the store through `persist` and reloads a snapshot. Until it ends, reads go to the source and health is `down`.
- Without a `connection`, a failed call makes the layer unavailable and the next read or commit recovers.
- Background work (recovery and its reads) keeps the startup context; start the application outside any transaction.

## Snapshot placement

A complete snapshot needs a per-instance store: a recovery on another instance sharing it would clear it. [`@openknot-ts/replication`](../replication/README.md) is the shared form. Entities without an order belong on `read-through`; on a snapshot a commit evicts the row until the next reload.

## Example

`pnpm --filter @openknot-ts/cache example` runs [examples/memory.ts](examples/memory.ts), a write-through cache over a `Map`.
