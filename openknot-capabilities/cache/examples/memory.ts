import { cache } from "../src/index.ts";
import { reader, success } from "@openknot-ts/behavior";
import type {} from "@openknot-ts/behavior/wire";
import type { Upserted } from "@openknot-ts/flow";
import { command, upserted, writer } from "@openknot-ts/flow";
import type {} from "@openknot-ts/flow/wire";
import { composeModule, defineApplication, plug, runApplication } from "@openknot-ts/wire";

interface Role {
  readonly entity: "role";
  readonly id: string;
  readonly name: string;
  readonly version: number;
}

const findRole = reader<(id: string) => Promise<Role | undefined>>();
const saveRole = writer<(role: Role) => Promise<Upserted<Role>>>();

// The source of truth and an in-memory cache in front of it.
const database = new Map<string, Role>();
const memory = new Map<string, Role>();
let sourceReads = 0;

const roleCache = cache({
  entity: "role",
  strategy: "write-through",
  port: findRole,
  writers: saveRole,
  persist: () => (changes) => {
    for (const change of changes) {
      if (change.type === "set") {
        memory.set(String(change.key), change.value as Role);
      } else if (change.type === "delete") {
        memory.delete(String(change.key));
      } else {
        memory.clear();
      }
    }
  },
  bind: () => ({ value: (id: string) => memory.get(id) }),
});

const roleReaders = plug({
  port: findRole,
  bind: () => async (id: string) => {
    sourceReads++;
    return database.get(id);
  },
});

const roleWriters = plug({
  port: saveRole,
  bind: () => async (role: Role) => {
    const saved = { ...role, version: role.version + 1 };
    database.set(saved.id, saved);
    return upserted(saved);
  },
});

const saveRoleCommand = command<Role>()({
  requirements: { saveRole },
  run: async (role, ctx) => {
    const saved = await ctx.saveRole(role);
    return success(saved.next);
  },
});

const app = await runApplication(
  defineApplication({
    modules: [
      composeModule({
        providers: [...[roleReaders, roleWriters, saveRoleCommand].map((source) => ({ source })), roleCache],
      }),
    ],
  }),
);

// The write fills the cache, so the read that follows does not reach the source.
await app.withScope((scope) => scope.resolve(saveRoleCommand)({ entity: "role", id: "r1", name: "admin", version: 0 }));

const found = await app.withScope((scope) => scope.resolve(findRole)("r1"));
console.log(`Read ${found?.name} at version ${found?.version} with ${sourceReads} source reads.`);

await app.stop();
