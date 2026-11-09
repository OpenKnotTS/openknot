import type { LockCommands } from "./index.ts";
import { redisLockOf } from "./index.ts";
import { lock } from "@openknot-ts/lock/wire";
import type { Requirements, RequirementsOptions, ResolvedReferences } from "@openknot-ts/wire";
import { unit } from "@openknot-ts/wire";

export function redisLock<const R extends Requirements = {}>(
  options: RequirementsOptions<R> & {
    readonly commands: (dependencies: ResolvedReferences<R>) => LockCommands;
    readonly prefix?: string | ((dependencies: ResolvedReferences<R>) => string);
  },
) {
  return unit({
    provides: lock,
    requirements: (options.requirements ?? {}) as R,
    factory: (dependencies: ResolvedReferences<R>) => {
      const prefix = typeof options.prefix === "function" ? options.prefix(dependencies) : options.prefix;
      return redisLockOf(options.commands(dependencies), prefix === undefined ? {} : { prefix });
    },
  });
}
