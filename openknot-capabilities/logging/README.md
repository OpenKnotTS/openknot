# OpenKnot logging

`@openknot-ts/logging` is OpenKnot's own logging contract. Operations, handlers and plugs declare `logger` in their requirements like any other dependency; an implementation writes the records. The console writes them until a plug provides another implementation.

```text
operation, handler, plug   → requirements: { logger } → Logger { trace, debug, info, warn, error, fatal, child }
@openknot-ts/logging       → LOG_LEVEL filter → Logging { write(record) }
implementation             → console (default) or a plug, such as pino
```

## Log

```ts
import { logger } from "@openknot-ts/logging/wire";

const renameRole = operation<RenameRole, RoleState>()({
  requirements: { findRole, logger },
  run: async (input, { findRole, logger }) => {
    logger.debug("renaming role", { roleId: input.id });
    // ...
  },
});

const createRole = command<CreateRole>()({
  requirements: { saveRole, logger },
  run: async (input, ctx) => {
    ctx.logger.info("role created", { roleId: input.id });
    // ...
  },
});
```

- Each method takes a message and optional attributes. Pass a failure as the `error` attribute: `logger.error("delivery failed", { error })`.
- `child(attributes)` returns a logger that adds those attributes to every record.
- `LOG_LEVEL` (`trace`, `debug`, `info`, `warn`, `error` or `fatal`, the levels pino and OpenTelemetry share; `info` by default) is read at `runApplication()`; any other value stops startup. The console writes `trace` with `console.debug` and `fatal` with `console.error`.
- With a [tracing](../tracing/README.md) implementation bound, such as [`provideOpenTelemetry()`](../../openknot-plugs/opentelemetry/opentelemetry-tracing/README.md), every written record carries the active span's `traceId` and `spanId`, as Spring Sleuth adds them to the MDC. Records outside a span carry neither, records filtered by their level never ask, and nothing changes without tracing.
- Logging never fails the work that logs: a record the implementation cannot write is reported on the console with the implementation's error.
- Flow also logs its own executions per kind, such as `LOG_LEVEL_COMMAND=debug` with `LOG_DURATION=true`: see [execution logs](../../openknot-flow/README.md#actors-tracing-and-logging).
- Behavior operations may require `logger` beside readers and operations. `standalone()` uses the console logger unless `override(logger, value)` supplies one.

## Implement and bind

`logging` is a unit whose own declaration writes on the console; one binding replaces it:

```ts
import type { Logging } from "@openknot-ts/logging";
import { logging } from "@openknot-ts/logging/wire";

const jsonLines = unit({
  provides: logging,
  factory: (): Logging => ({
    write: (record) => process.stdout.write(`${JSON.stringify(record)}\n`),
  }),
});
```

A record carries `level`, `message` and frozen `attributes`; time, format and destination belong to the implementation. [`@openknot-ts/pino-logging`](../../openknot-plugs/pino/pino-logging/README.md) writes through the application's pino instance.

## API

| Entry | Export | Description |
| --- | --- | --- |
| root | `Logger`, `Logging`, `LogRecord`, `LogLevel`, `LogAttributes` | The contract types. |
| root | `createLogger(logging, { level?, attributes?, correlation? })` | A logger over an implementation, without Wire; `correlation()` adds attributes to each written record. |
| root | `consoleLogging`, `parseLogLevel(value)`, `isLogLevel(value)` | The console implementation and level parsing. |
| root | `isLoggerReference(value)`, `LoggerMarker` | Recognizes the `/wire` logger without loading Wire, as Behavior does. |
| `/wire` | `logger`, `logging`, `loggingConfig` | What consumers require, what implementations provide, and `LOG_LEVEL`. |
