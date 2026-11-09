# @openknot-ts/core

> **Preview.** OpenKnot is in preview: APIs may change between 0.x versions until 1.0.

The OpenKnot core in one package: [Wire](../openknot-wire/README.md), [Behavior](../openknot-behavior/README.md) and [Flow](../openknot-flow/README.md), at the same version. Plugs and capabilities stay separate packages you add as you select them.

```sh
pnpm add @openknot-ts/core
pnpm add @openknot-ts/knot-http-node @openknot-ts/trpc-router @openknot-ts/trpc-knot-server-handler
```

| Entry | Same as |
| --- | --- |
| `@openknot-ts/core` | `@openknot-ts/wire` |
| `@openknot-ts/core/behavior` | `@openknot-ts/behavior` |
| `@openknot-ts/core/behavior/wire` | `@openknot-ts/behavior/wire` |
| `@openknot-ts/core/flow` | `@openknot-ts/flow` |
| `@openknot-ts/core/flow/wire` | `@openknot-ts/flow/wire` |

```ts
import { model, operation, success } from "@openknot-ts/core/behavior";
import { command, expose } from "@openknot-ts/core/flow";
import { provideFlow } from "@openknot-ts/core/flow/wire";
import { defineApplication, runApplication } from "@openknot-ts/core";
```

Each entry re-exports the original package, so definitions are the same objects whichever path imports them, and plugs that depend on `@openknot-ts/wire` work with it. Type the actor through the bundled entry:

```ts
declare module "@openknot-ts/core/flow" {
  interface ExecutionTypes {
    readonly actor: AppActor;
  }
}
```

## License

[MIT](../LICENSE)
