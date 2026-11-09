# @openknot-ts/replication

Keeps a per-instance layer and a shared store coherent with managed writes across application instances. A replication takes the source reader plug and wraps its readers through `decorate()`; listing it in a module brings the source plug with it.

## Usage

```ts
export const rolesLocal = replication.instance({
  requirements: { localRoles },
  port: reader.compose({ byId: findRole }),
  persist:
    ({ localRoles }) =>
    (changes) =>
      applyTo(localRoles, changes),
  bind: ({ localRoles }) => ({ byId: (id) => localRoles.get(id) }),
});

export const rolesShared = replication.distributed({
  entity: "role",
  port: reader.compose({ byId: findRole }),
  namespace: "quickstart:role",
  load: listRoles,
});

export const roleReplication = replication({ roleReaders, rolesLocal, rolesShared });
```

The application also selects plugs for `replicaStore` and `replicationChannel` (this package) and `lock` (`@openknot-ts/lock`), such as [`@openknot-ts/redis-replication`](../../openknot-plugs/redis/redis-replication/README.md) and [`@openknot-ts/redis-lock`](../../openknot-plugs/redis/redis-lock/README.md); a missing one fails at startup.

## API

| Export | Description |
| --- | --- |
| `replication.instance({ requirements?, port, persist, bind, include? })` | The per-instance layer over application-owned storage. |
| `replication.distributed({ entity, port, namespace, load, revision?, order?, include?, startup?, leaseMs?, bind? })` | The shared layer. `load` is a source reader returning every state. |
| `replication({ roleReaders, rolesLocal, rolesShared })` | Combines the source reader plug with its layers, named freely. Members: `health` (a check reporting failures as `down`) and `rebuild` (a function that rebuilds the keyspace). |
| `replicaStore`, `replicationChannel` | Contracts the plugs implement. `ReplicaFenced` is the store's fence rejection. |

## Layers

- **Shared.** Commits of the entity apply set-if-newer by `order`, with tombstones, then publish their keys. Reads go to `byId` or `bind({ store })`, and to the source until the keyspace `namespace:v{revision}` is complete for the store's current run.
- **Instance.** Fed by the channel: each changed key is disabled, read from the shared layer, persisted and enabled again; the latest refresh of a key wins. A local commit disables its key before effects run. A refresh that completes during a reload stays disabled until the reload's last pass.
- **Instance lists** go to the next layer when `include` is set, when the Unit of Work wrote the entity, or while any key is refreshing.
- **`include`** makes the shared layer partial: hydration skips failing states, a commit of one stores a tombstone, absence and lists go to the source.
- Messages carry keys only: `changes`, `clear` and `ready`. A writer whose delete cascades returns a `deleted(state)` receipt for every cascaded row; writers that bypass managed writers publish through `replicationChannel` themselves.

## Consistency

- A shared reply is discarded when the replication's generation changes during the read.
- Absence and lists cost one extra marker read after the store reply: it must still be complete and clean for the same run and holder. A mismatch sends the read to the source and removes readiness.
- Found values cost no extra store call. Instance-store replies are discarded across a refresh, reload or clear.
- Hydration and adoption read the source in scopes of their own, closed with each result.
- Start the application outside any transaction: background work (hydration, adoption, readiness checks, reloads, refreshes, retries) keeps the startup context, including tracing. Reads and commits keep the caller's.

## Hydration and recovery

- Each instance subscribes before reading the marker. When the marker is missing, loading, dirty or from another store run, the lock winner marks the keyspace `loading`, publishes `clear`, clears it, loads it through `load`, marks it complete and publishes `ready`. Others read the source until `ready`.
- An instance becomes ready only from a marker read that started after the latest `clear`.
- `startup: "blocking"` waits for this instance's attempt.
- A failed hydration is retried by the next event: an instance starting, a commit, a shared read, a restored connection or `rebuild`. A hydration that ends dirty rebuilds instead of announcing `ready`.
- A failed instance reload or refresh turns health `down`; the next read or commit reloads after a marker check.
- A failed shared write marks the keyspace dirty and rebuilds on the next event.
- A lost channel sends reads to the source, clears the instance layer and turns health `down` until its restoration.
- `stop()` does not wait for an in-flight `load()`: the attempt ends, releases its lock and writes nothing more.

## Fencing

- A hydration runs under `lock.tryRun` with a lease of `leaseMs` (one minute, not renewed). `leaseMs` must exceed the longest load.
- Each attempt generates a fresh UUID `holder` and fences its `clear`, page `apply` calls and completing `mark` with it. A holder whose lease was taken over gets `ReplicaFenced` and ends without `ready`.
- Commits and dirty marks are not fenced; set-if-newer keeps commits ordered.

## Commits

A commit waits for its shared write and, on an instance that is not ready, for the marker check. It never waits for a hydration, its publish or an instance refresh, and it stops waiting once the store is reported lost.

## Rebuild

`roleReplication.rebuild` resolves when the attempt ends; failures report through `health` and a span. It runs after a hydration in progress; if a peer holds the lock it stays pending until that peer's `ready` or the next read or commit. During a store outage it runs after `restored`. A suspended instance reviews the newer revision instead; a superseded, disabled or stopped one does nothing.

## Store connection

A `ReplicaStore`'s optional `connection` is a `ConnectionWatch` from `@openknot-ts/wire`.

- On `lost`: health `down`, reads to the source, instance layer cleared, commits do no store work (their keys wait in the backlog and the keyspace rebuilds after `restored`), `stop()` stops waiting on store work.
- On `restored`: the backlog flushes and the marker is checked; health returns `up` when ready.
- Without a `connection`, an outage is seen only when a store call fails.

## Publish backlog

Every commit's keys go through an in-memory backlog holding the newest change per entity and id. A failed publish keeps them and turns health `down` without a rebuild. The backlog flushes on the next publish, shared read, readiness check or restored connection. `stop()` does not flush it: keys committed during an outage and not flushed before stop are lost, and other instances stay stale for them until a newer commit or rebuild.

## Order

Newer changes win by `order`: the state's numeric `version` by default, or a projection returning a number, bigint or string. TypeScript requires `order` unless every state has a numeric `version`. A state without an order at runtime disables that replication for the run: reads go to the source, health is `down`, and it does no more store work or publishing.

## Revisions

Bump `revision` by exactly one when the stored shape changes. A new revision hydrates its own keyspace and, when complete, drops the previous one. Skipping a number leaves a gap that older instances cannot see.

An older instance suspends on any message from a newer revision, or when it finds the next revision's marker. Suspended, it reads the source, clears its instance layer and keeps applying and publishing its commits. It then reviews the newer revision:

- `complete`: superseded for good; commits keep publishing keys, reads stay on the source, its old keyspace is dropped.
- missing: resumes with a rebuild.
- `loading` with the lock held: stays suspended. `loading` with a free lock: treated as abandoned; drops it and resumes.

Newer instances adopt keys that older ones publish, reading each from the source's `byId` (a shared layer without `byId` rebuilds instead).

## Store contract

A fence is the holder a write expects: the write proceeds only while the stored marker's `holder` equals it, otherwise it rejects with `ReplicaFenced(keyspace)`. Each fence check is atomic with its write.

- `runId()` identifies the store's run and changes when the store restarts empty.
- `marker(keyspace)` returns `{ state, dirty, runId, holder? }` or `undefined`.
- `mark(keyspace, marker, fence?)` writes it; an unfenced `mark` without `holder` keeps the stored holder.
- `apply(keyspace, changes, fence?)` stores changes newer than the stored state or tombstone, and deletes of the stored order, and returns those stored.
- `clear(keyspace, fence)` removes states and tombstones, keeps the marker, and rejects a stale fence even when nothing matches.
- `get(keyspace, entity, id)` and `list(keyspace, entity)` read states.
- `drop(keyspace)` removes the keyspace with its marker and tombstones.
