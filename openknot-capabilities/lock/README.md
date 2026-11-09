# Lock

`@openknot-ts/lock` defines `lock.tryRun(name, { leaseMs }, work)`: exclusive, non-blocking execution across instances. A second caller gets `{ acquired: false }` instead of waiting. The lease uses the store's native expiry, without renewal or application timers, so a crashed holder cannot block others forever; the work receives a fencing token for stores that reject writes from an older holder. Implementations: `@openknot-ts/redis-lock` and `@openknot-ts/knot-lock` (in process).

`@openknot-ts/replication` uses the lock only to serialize hydration. Each successful hydration generates its own holder with `randomUUID()` and uses that holder to fence store writes, clear and complete markers, and to gate a delayed completion against its originating hydration. The lock lease token remains available for consumer work and the lock owns lease exclusion, expiry, and release. Because the lease is not renewed, a replication's `leaseMs` must exceed its longest load.
