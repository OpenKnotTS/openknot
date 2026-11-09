import type { CacheChange, CacheLayer } from "../src/index.ts";
import { cache, unsupported } from "../src/index.ts";
import type { Deleted } from "@openknot-ts/behavior";
import { deleted, reader, success } from "@openknot-ts/behavior";
import type { Upserted } from "@openknot-ts/flow";
import { command, upserted, writer } from "@openknot-ts/flow";
import type {} from "@openknot-ts/flow/wire";
import { composeModule, defineApplication, plug, resource, runApplication } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

interface Role {
  readonly entity: "role";
  readonly id: string;
  readonly name: string;
  readonly version: number;
}
const role = (id: string, name: string, version = 1): Role => ({ entity: "role", id, name, version });

const findRole = reader<(id: string) => Promise<Role | undefined>>();
const listRoles = reader<() => Promise<readonly Role[]>>();
const roles = reader.compose({ byId: findRole, list: listRoles });
const saveRole = writer<(value: Role) => Promise<Upserted<Role>>>();
const removeRole = writer<(value: Role) => Promise<Deleted<Role>>>();

function store(initial: readonly Role[] = []) {
  const values = new Map(initial.map((value) => [value.id, value]));
  const changes: CacheChange[] = [];
  return {
    values,
    changes,
    persist: () => (batch: readonly CacheChange[]) => {
      for (const change of batch) {
        changes.push(change);
        if (change.type === "set") {
          values.set(String(change.key), change.value as Role);
        } else if (change.type === "delete") {
          values.delete(String(change.key));
        } else {
          values.clear();
        }
      }
    },
    bind: () => ({
      byId: (id: string) => values.get(id),
      list: () => [...values.values()],
    }),
  };
}

/** The layers of a reader as modules list them, given from the outermost one: the first listed is the closest to the source. */
const listed = (...outermostFirst: readonly CacheLayer[]) => [
  // Commits reach the layers in the order their states start, which these tests cover from the outermost one.
  ...outermostFirst.map((layer) => layer.state),
  ...outermostFirst.toReversed().flatMap((layer) => Object.values(layer)),
];

function source(initial: readonly Role[], layers: readonly CacheLayer[], gate?: Promise<void>) {
  const database = new Map(initial.map((value) => [value.id, value]));
  const reads: string[] = [];
  const readers = plug({
    port: roles,
    bind: () => ({
      byId: async (id: string) => {
        reads.push(id);
        await gate;
        return database.get(id);
      },
      list: async () => {
        reads.push("*");
        return [...database.values()];
      },
    }),
  });
  const saves = plug({
    port: saveRole,
    bind: () => async (value: Role) => {
      const stored = { ...value, version: value.version + 1 };
      database.set(value.id, stored);
      return upserted(stored);
    },
  });
  const removes = plug({
    port: removeRole,
    bind: () => async (value: Role) => {
      database.delete(value.id);
      return deleted(value);
    },
  });
  return { database, reads, definitions: [readers, ...listed(...layers), saves, removes] as readonly object[] };
}

const save = command<Role>()({
  requirements: { saveRole },
  run: async (value, ctx) => success(await ctx.saveRole(value)),
});
const remove = command<Role>()({
  requirements: { removeRole },
  run: async (value, ctx) => success(await ctx.removeRole(value)),
});

function start(definitions: readonly object[]) {
  const providers: readonly object[] = [...definitions, save, remove];
  return runApplication(
    defineApplication({ modules: [composeModule({ providers: providers.map((provider) => ({ source: provider })) })] }),
  );
}

test("an unsupported answer reads the source and is not filled", async () => {
  const memory = store();
  const layer = cache({
    entity: "role",
    port: findRole,
    persist: memory.persist,
    bind: () => ({ value: () => unsupported() }),
  });
  const db = source([role("r1", "admin")], [layer]);
  const app = await start(db.definitions);
  try {
    await app.withScope((scope) => scope.resolve(findRole)("r1"));
    await app.withScope((scope) => scope.resolve(findRole)("r1"));
    assert.deepEqual(db.reads, ["r1", "r1"]);
    assert.equal(memory.values.size, 0);
  } finally {
    await app.stop();
  }
});

test("concurrent misses share one source read", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const memory = store();
  const layer = cache({
    entity: "role",
    port: findRole,
    persist: memory.persist,
    bind: () => ({ value: memory.bind().byId }),
  });
  const db = source([role("r1", "admin")], [layer], gate);
  const app = await start(db.definitions);
  try {
    const both = await app.withScope((scope) => {
      const read = scope.resolve(findRole);
      const pending = Promise.all([read("r1"), read("r1")]);
      release();
      return pending;
    });
    assert.deepEqual(
      both.map((value) => value?.name),
      ["admin", "admin"],
    );
    assert.deepEqual(db.reads, ["r1"]);
  } finally {
    await app.stop();
  }
});

test("a hit in a lower layer fills the layer above it", async () => {
  const upper = store();
  const lower = store([role("r1", "admin")]);
  const layers = [upper, lower].map((memory) =>
    cache({ entity: "role", port: findRole, persist: memory.persist, bind: () => ({ value: memory.bind().byId }) }),
  );
  const db = source([], layers);
  const app = await start(db.definitions);
  try {
    assert.equal((await app.withScope((scope) => scope.resolve(findRole)("r1")))?.name, "admin");
    assert.deepEqual(db.reads, []);
    assert.equal(upper.values.get("r1")?.name, "admin");
  } finally {
    await app.stop();
  }
});

test("committed changes follow each strategy", async () => {
  const readThrough = store();
  const writeThrough = store([role("r1", "admin")]);
  const snapshot = store();
  const db = source(
    [],
    [
      cache({ entity: "role", port: roles, persist: readThrough.persist, bind: readThrough.bind }),
      cache({
        entity: "role",
        strategy: "write-through",
        port: roles,
        persist: writeThrough.persist,
        bind: writeThrough.bind,
      }),
      cache({ entity: "role", strategy: "snapshot", port: roles, persist: snapshot.persist, bind: snapshot.bind }),
    ],
  );
  const app = await start(db.definitions);
  try {
    await app.withScope((scope) => scope.resolve(save)(role("r1", "root", 1)));
    assert.equal(readThrough.values.get("r1")?.version, 2);
    assert.equal(writeThrough.values.has("r1"), false);
    assert.equal(snapshot.values.get("r1")?.version, 2);
    await app.withScope((scope) => scope.resolve(remove)(role("r1", "root", 2)));
    assert.equal(readThrough.values.has("r1"), false);
    assert.equal(snapshot.values.has("r1"), false);
  } finally {
    await app.stop();
  }
});

test("a complete snapshot answers misses and lists; a partial one sends them to the source", async () => {
  const complete = store();
  const partial = store();
  const completeDb = source(
    [role("r1", "admin")],
    [
      cache({
        entity: "role",
        strategy: "snapshot",
        startup: "blocking",
        port: roles,
        load: listRoles,
        persist: complete.persist,
        bind: complete.bind,
      }),
    ],
  );
  const partialDb = source(
    [role("r1", "admin")],
    [
      cache({
        entity: "role",
        strategy: "snapshot",
        startup: "blocking",
        port: roles,
        load: async () => [role("r1", "admin")],
        persist: partial.persist,
        bind: partial.bind,
      }),
    ],
  );
  for (const [db, memory, reads] of [
    [completeDb, complete, ["*"]],
    [partialDb, partial, ["r2", "*"]],
  ] as const) {
    const app = await start(db.definitions);
    try {
      assert.equal(memory.values.get("r1")?.name, "admin");
      assert.equal(await app.withScope((scope) => scope.resolve(findRole)("r2")), undefined);
      assert.deepEqual(
        (await app.withScope((scope) => scope.resolve(listRoles)())).map((value) => value.id),
        ["r1"],
      );
      assert.deepEqual(db.reads, reads);
    } finally {
      await app.stop();
    }
  }
});

test("a background snapshot reads through until its load completes", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const memory = store();
  const layer = cache({
    entity: "role",
    strategy: "snapshot",
    port: roles,
    load: async () => {
      await gate;
      return [role("r1", "admin")];
    },
    persist: memory.persist,
    bind: memory.bind,
  });
  const db = source([role("r1", "admin")], [layer]);
  const app = await start(db.definitions);
  try {
    await app.withScope((scope) => scope.resolve(findRole)("r1"));
    assert.deepEqual(db.reads, ["r1"]);
    const { recovering } = app.resolve(layer.state) as { readonly recovering: Promise<void> | undefined };
    assert.ok(recovering !== undefined);
    release();
    await recovering;
    await app.withScope((scope) => scope.resolve(findRole)("r1"));
    assert.deepEqual(db.reads, ["r1"]);
  } finally {
    await app.stop();
  }
});

test("a blocking snapshot starts the application after its load", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let loading: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    loading = resolve;
  });
  const memory = store();
  const layer = cache({
    entity: "role",
    strategy: "snapshot",
    startup: "blocking",
    port: roles,
    load: async () => {
      loading();
      await gate;
      return [role("r1", "admin")];
    },
    persist: memory.persist,
    bind: memory.bind,
  });
  const db = source([], [layer]);
  const running = start(db.definitions).then((app) => ({ app, loaded: memory.values.has("r1") }));
  await started;
  release();
  const { app, loaded } = await running;
  try {
    assert.equal(loaded, true);
  } finally {
    await app.stop();
  }
});

test("an order projection lets entities without a version be written through", async () => {
  interface Note {
    readonly entity: "note";
    readonly id: string;
    readonly revision: number;
  }
  const findNote = reader<(id: string) => Promise<Note | undefined>>();
  const saveNote = writer<(value: Note) => Promise<Upserted<Note>>>();
  const unordered = new Map<string, unknown>();
  const ordered = new Map<string, unknown>();
  const persist = (written: Map<string, unknown>) => () => (changes: readonly CacheChange[]) => {
    for (const change of changes) {
      if (change.type === "set") {
        written.set(String(change.key), change.value);
      } else if (change.type === "delete") {
        written.set(String(change.key), "deleted");
      }
    }
  };
  const layers = [
    cache({
      entity: "note",
      strategy: "write-through",
      port: findNote,
      writers: saveNote,
      persist: persist(unordered),
      bind: () => ({}),
    }),
    cache({
      entity: "note",
      strategy: "write-through",
      port: findNote,
      writers: saveNote,
      order: (state) => (state as Note).revision,
      persist: persist(ordered),
      bind: () => ({}),
    }),
  ];
  const notes = plug({ port: findNote, bind: () => async () => undefined });
  const saves = plug({
    port: saveNote,
    bind: () => async (value: Note) => upserted({ ...value, revision: value.revision + 1 }),
  });
  const write = command<Note>()({
    requirements: { saveNote },
    run: async (value, ctx) => success(await ctx.saveNote(value)),
  });
  const app = await runApplication(
    defineApplication({
      modules: [
        composeModule({
          providers: [notes, ...listed(...layers), saves, write].map((provider) => ({ source: provider })),
        }),
      ],
    }),
  );
  try {
    await app.withScope((scope) => scope.resolve(write)({ entity: "note", id: "n1", revision: 1 }));
    assert.equal(unordered.get("n1"), "deleted");
    assert.deepEqual(ordered.get("n1"), { entity: "note", id: "n1", revision: 2 });
  } finally {
    await app.stop();
  }
});

test("a list from a managed layer inside a Unit of Work that wrote the entity is read from the source", async () => {
  const memory = store([role("r1", "admin")]);
  const layer = cache({
    entity: "role",
    strategy: "write-through",
    port: roles,
    persist: memory.persist,
    bind: memory.bind,
    writers: saveRole,
  });
  const db = source([role("r1", "admin")], [layer]);
  const saveAndList = command<Role>()({
    requirements: { saveRole, listRoles },
    run: async (value, ctx) => {
      await ctx.saveRole(value);
      return success(await ctx.listRoles());
    },
  });
  const app = await start([...db.definitions, saveAndList]);
  try {
    const result = await app.withScope((scope) => scope.resolve(saveAndList)(role("r2", "new", 1)));
    assert.equal(result.isError, false);
    assert.deepEqual(
      (result as { value: readonly Role[] }).value.map((value) => value.id),
      ["r1", "r2"],
    );
  } finally {
    await app.stop();
  }
});

test("a snapshot with include is partial", async () => {
  const memory = store();
  const hidden = role("r1", "hidden");
  const layer = cache({
    entity: "role",
    strategy: "snapshot",
    startup: "blocking",
    port: roles,
    load: listRoles,
    persist: memory.persist,
    bind: memory.bind,
    include: () => (state: unknown) => (state as Role).name !== "hidden",
  });
  const db = source([hidden], [layer]);
  const app = await start(db.definitions);
  try {
    const result = await app.withScope((scope) => scope.resolve(findRole)("r1"));
    assert.equal(result?.name, "hidden");
    assert.ok(db.reads.includes("r1"));
  } finally {
    await app.stop();
  }
});

test("a cache over managed states names their entity", () => {
  const memory = store();
  assert.throws(
    // @ts-expect-error a managed port names its entity
    () => cache({ strategy: "write-through", port: findRole, persist: memory.persist, bind: () => ({}) }),
    TypeError,
  );
  // @ts-expect-error the entity is the literal of the port's states
  cache({ entity: "user", port: findRole, persist: memory.persist, bind: () => ({}) });
});

test("a snapshot reads in a scope of its own, through a reader with scoped requirements", async () => {
  let closed = 0;
  const memory = new Map<string, Role>();
  const session = resource({
    lifetime: "scoped",
    initialize: async () => ({
      value: [role("r1", "admin")],
      release() {
        closed++;
      },
    }),
  });
  const readers = plug({
    port: roles,
    requirements: { session },
    bind: ({ session }) => ({
      byId: async (id: string) => session.find((value) => value.id === id),
      list: async () => session,
    }),
  });
  const layer = cache({
    entity: "role",
    strategy: "snapshot",
    startup: "blocking",
    port: findRole,
    load: listRoles,
    persist: () => (changes: readonly CacheChange[]) => {
      for (const change of changes) {
        if (change.type === "set") {
          memory.set(String(change.key), change.value as Role);
        }
      }
    },
    bind: () => ({ value: (id: string) => memory.get(id) }),
  });
  const app = await runApplication(
    defineApplication({ modules: [composeModule({ providers: [{ readers }, layer] })] }),
  );
  try {
    assert.equal(memory.get("r1")?.name, "admin");
    assert.equal(closed, 1);
  } finally {
    await app.stop();
  }
});
