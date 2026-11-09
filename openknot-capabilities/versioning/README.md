# Versioning

`@openknot-ts/versioning` owns optimistic concurrency semantics. `versioningOf(implementation)` turns native operations into `save(target, row)` and `remove(target, row)`: a row with `version` 0 is inserted, any other row is updated or deleted only where the stored version matches, and a row that changed nothing throws `VersionConflict`. Flow keeps `VersionConflict` as a classified failure and rolls the Unit of Work back.

Implementation plugs supply `VersioningImplementation` (`insert`, `update`, `remove`) over a consumer-owned client and augment `VersioningTargets` from `@openknot-ts/versioning/wire` with their target types. Row ↔ domain mapping stays in application code.
