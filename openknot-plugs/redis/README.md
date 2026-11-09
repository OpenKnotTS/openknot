# Redis plugs

Independent adapters that include node-redis and use its native types, with application-owned native instances where needed:

| Package                                                    | Responsibility                                  |
| ---------------------------------------------------------- | ----------------------------------------------- |
| [@openknot-ts/redis-client](redis-client/README.md)           | Managed native command/subscription connections |
| [@openknot-ts/redis-lock](redis-lock/README.md)               | Lock over a consumer-owned Redis client         |
| [@openknot-ts/redis-replication](redis-replication/README.md) | Replica store and replication channel           |

The resource owns connections; the replication plug owns its subscription, scripts and message framing. Native client types and lifecycle methods come from the `redis` package. The focused example and integration tests use the real SDK rather than a custom RESP implementation.
