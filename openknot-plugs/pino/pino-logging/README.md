# @openknot-ts/pino-logging

Implements OpenKnot's [logging contract](../../../openknot-capabilities/logging/README.md) over the application's [pino](https://getpino.io) instance, which keeps its own options, transports and lifecycle. Consumers keep requiring `logger`; this module replaces the console default.

The peers are `@openknot-ts/logging` and `pino >=10 <11`. The root entry runs without Wire; `/wire` composes it as a module.

## Usage

```ts
import { logger } from "@openknot-ts/logging/wire";
import { providePinoLogging } from "@openknot-ts/pino-logging/wire";
import { pino } from "pino";

const nativeLogger = unit({ factory: () => pino({ level: "trace" }) });

const logs = providePinoLogging({
  requirements: { nativeLogger },
  factory: ({ nativeLogger }) => nativeLogger,
});

const renameRole = command<RenameRole>()({
  requirements: { saveRole, logger },
  run: async (input, ctx) => {
    ctx.logger.info("renaming role", { roleId: input.id });
    return success(await ctx.saveRole(input));
  },
});

// defineApplication({ inputs: [renameRoleEndpoint], modules: [applicationModule, nativeLogger, logs] })
```

The handler's code stays the same as with the console default; pino writes the record as one JSON line, and with tracing bound it also carries `traceId` and `spanId`:

```json
{"level":30,"time":1794430107231,"pid":4242,"hostname":"api-1","roleId":"r1","msg":"renaming role"}
```

- `LOG_LEVEL` selects records before they reach pino; keep the instance's own level at `trace` so it does not drop them again. Each level maps to pino's method of the same name.
- Attributes become pino's merging object and the message becomes `msg`. An `error` attribute is serialized with pino's standard error serializer.
- The module provides `logging` only when its requirements are registered; otherwise the console default stays.
- Flushing an asynchronous destination on shutdown belongs to the instance's owner, for example a `resource` whose `release()` flushes it.

## API

| Entry | Export | Description |
| --- | --- | --- |
| root | `pinoLogging(instance)` | The `Logging` implementation, without Wire. |
| `/wire` | `providePinoLogging({ requirements?, factory })`, `PinoLoggingOptions` | Provides the implementation as a module. |
