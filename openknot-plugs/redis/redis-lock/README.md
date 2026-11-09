# @openknot-ts/redis-lock

Implements the [lock contract](../../../openknot-capabilities/lock/README.md) over a node-redis client the application already manages.

```ts
import { redisLock } from "@openknot-ts/redis-lock/wire";

export const lock = redisLock({ requirements: { redis }, commands: ({ redis }) => redis.commands, prefix: "app:lock" });
```

- Acquisition is `SET key token NX PX lease`; release deletes the key only for the same token. The native expiry bounds a crashed holder; nothing renews or polls.
- `prefix` is a string or `(dependencies) => string`, so separate locks can use their own validated config.

`pnpm --filter @openknot-ts/redis-lock test:redis` runs the integration tests against `REDIS_URL`.
