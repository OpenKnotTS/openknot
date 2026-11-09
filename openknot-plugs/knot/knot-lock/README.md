# Knot lock

`@openknot-ts/knot-lock` implements the [lock contract](../../../openknot-capabilities/lock/README.md) inside one process. `inProcessLock` from `@openknot-ts/knot-lock/wire` provides it to an application. Lease expiry is checked when the lock is requested; no timer runs. Use it for single instances and tests; clusters need a shared implementation such as `@openknot-ts/redis-lock`.
