import type { ResourceHandle } from "@openknot-ts/wire";
import { hook, resource, unit } from "@openknot-ts/wire";

export const lifecycle: string[] = [];

interface Role {
  readonly id: string;
  readonly name: string;
}

interface RoleDatabase {
  readonly roles: Map<string, Role>;
}

interface RoleRepository {
  save(role: Role): Promise<Role>;
  find(id: string): Promise<Role | undefined>;
}

interface CreateRole {
  run(input: { readonly name: string }): Promise<Role>;
}

interface RoleService {
  create(name: string): Promise<Role>;
  find(id: string): Promise<Role | undefined>;
}

// A resource: acquired at startup and released at stop.
export const roleDatabase = resource({
  async initialize(): Promise<ResourceHandle<RoleDatabase>> {
    lifecycle.push("database:open");
    await Promise.resolve();

    return {
      value: { roles: new Map<string, Role>() },
      release(): void {
        lifecycle.push("database:close");
      },
    };
  },
});

// Units: built from their requirements.
function createRoleRepository({ roleDatabase }: { roleDatabase: RoleDatabase }): RoleRepository {
  return {
    async save(role): Promise<Role> {
      roleDatabase.roles.set(role.id, role);
      return await Promise.resolve(role);
    },
    async find(id): Promise<Role | undefined> {
      return await Promise.resolve(roleDatabase.roles.get(id));
    },
  };
}

export const roleRepository = unit({ requirements: { roleDatabase }, factory: createRoleRepository });

// An application-specific executor; the DI core does not invent database semantics.
export const createRoleCommand = unit({
  requirements: { roleRepository },
  factory: ({ roleRepository }): CreateRole => ({
    run(input): Promise<Role> {
      return roleRepository.save({ id: crypto.randomUUID(), name: input.name });
    },
  }),
});

export const roleService = unit({
  requirements: { createRoleCommand, roleRepository },
  factory: ({ createRoleCommand, roleRepository }): RoleService => ({
    create(name): Promise<Role> {
      return createRoleCommand.run({ name });
    },
    find(id): Promise<Role | undefined> {
      return roleRepository.find(id);
    },
  }),
});

// Lifecycle hooks, selected by the application as startup and shutdown tasks.
export const warmup = hook({
  run(): void {
    lifecycle.push("warmup");
  },
});

export const startApi = hook({
  requirements: { roleService },
  run({ roleService }): void {
    void roleService;
    lifecycle.push("api:start");
  },
});

export const stopApi = hook({
  run(): void {
    lifecycle.push("api:stop");
  },
});

// Never a root and never required, so it is never built.
export const unusedService = unit({
  factory: (): object => {
    throw new Error("This provider must remain dormant.");
  },
});
