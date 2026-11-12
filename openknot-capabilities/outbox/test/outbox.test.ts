import { outboxHealth } from "../src/health.ts";
import type { OutboxRecord, OutboxStore, StuckRecord } from "../src/index.ts";
import { outbox, outboxControl, outboxStore } from "../src/index.ts";
import { error, failure, success } from "@openknot-ts/behavior";
import type { ErrorReport } from "@openknot-ts/error-reporting";
import { errorReporter } from "@openknot-ts/error-reporting/wire";
import type { PublishOptions, UnitOfWorkImplementation } from "@openknot-ts/flow";
import { command, defaultUnitOfWork, publisher } from "@openknot-ts/flow";
import type {} from "@openknot-ts/flow/wire";
import { health, healthProbes } from "@openknot-ts/health";
import type { Definition } from "@openknot-ts/wire";
import { composeModule, defineApplication, plug, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { test } from "node:test";

interface Row extends OutboxRecord {
  readonly sequence: number;
  attempts: number;
  error: string | undefined;
  owner: string | undefined;
  until?: number;
}

/** An in-memory store whose saves join the fake transaction, with a change event for exact waiting. */
function memory() {
  const rows: Row[] = [];
  const changed = new EventTarget();
  let staged: Row[] | undefined;
  let sequence = 0;
  const notify = () => changed.dispatchEvent(new Event("change"));
  const uow: UnitOfWorkImplementation = {
    async transaction(work) {
      staged = [];
      try {
        const result = await work();
        rows.push(...staged);
        return result;
      } finally {
        staged = undefined;
        notify();
      }
    },
  };
  const remove = (ids: readonly string[]) => {
    for (const id of ids) {
      const index = rows.findIndex((row) => row.id === id);
      if (index >= 0) {
        rows.splice(index, 1);
      }
    }
    notify();
  };
  const store: OutboxStore = {
    async save(records) {
      if (staged === undefined) {
        throw new Error("No transaction");
      }
      staged.push(
        ...records.map((record) => ({
          ...record,
          sequence: ++sequence,
          attempts: 0,
          error: undefined,
          owner: undefined,
        })),
      );
    },
    async claim(name, owner, limit) {
      const held = (row: Row) =>
        row.owner !== undefined && row.owner !== owner && (row.until ?? Infinity) >= Date.now();
      if (rows.some((row) => row.name === name && held(row))) {
        return [];
      }
      const claimed = rows
        .filter((row) => row.name === name)
        .sort((a, b) => a.sequence - b.sequence)
        .slice(0, limit);
      for (const row of claimed) {
        row.owner = owner;
        delete row.until;
      }
      return claimed.map(({ id, name, message, propagation }) => ({ id, name, message, propagation }));
    },
    async renew(ids, owner) {
      const owned = rows.filter((row) => ids.includes(row.id) && row.owner === owner);
      return owned.length === ids.length;
    },
    async heldFor(name, owner) {
      const ends = rows
        .filter((row) => row.name === name && row.owner !== undefined && row.owner !== owner && row.until !== undefined)
        .map((row) => row.until! - Date.now())
        .filter((left) => left >= 0);
      return ends.length === 0 ? undefined : Math.max(...ends);
    },
    async complete(ids) {
      remove(ids);
    },
    async attempted(id, owner, message) {
      const row = rows.find((each) => each.id === id && each.owner === owner);
      if (row === undefined) {
        return;
      }
      row.attempts++;
      row.error = message;
      row.owner = undefined;
      notify();
    },
    async release(ids, owner) {
      for (const row of rows) {
        if (ids.includes(row.id) && row.owner === owner) {
          row.owner = undefined;
        }
      }
    },
    async stuck(attempts, name): Promise<readonly StuckRecord[]> {
      return rows
        .filter((row) => row.attempts >= attempts && (name === undefined || row.name === name))
        .map(({ id, name, attempts, error }) => ({ id, name, attempts, error }));
    },
    async discard(id) {
      remove([id]);
    },
  };
  /** Resolves once the condition holds, checked now and after every store change. */
  const until = (condition: () => boolean) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (condition()) {
          changed.removeEventListener("change", check);
          resolve();
        }
      };
      changed.addEventListener("change", check);
      check();
    });
  const seed = (
    name: string,
    message: unknown,
    claim?: { readonly owner: string; readonly until: number },
    propagation?: OutboxRecord["propagation"],
  ) =>
    rows.push({
      id: `seed-${++sequence}`,
      name,
      message,
      ...(propagation === undefined ? {} : { propagation }),
      sequence,
      attempts: 0,
      error: undefined,
      owner: claim?.owner,
      ...(claim === undefined ? {} : { until: claim.until }),
    });
  return { rows, uow, store, until, seed };
}

interface Event {
  readonly name: string;
  readonly at?: Date | string;
  readonly count?: number;
  readonly reject?: boolean;
}

const Rejected = error("Rejected");

function scenario(
  options: {
    readonly send?: (message: Event, options: PublishOptions) => void | Promise<void>;
    readonly connection?: Definition;
    readonly batchSize?: number;
  } = {},
) {
  const state = memory();
  const sent: {
    readonly message: Event;
    readonly id: string | undefined;
    readonly propagation?: PublishOptions["propagation"];
  }[] = [];
  const events = publisher<Event>();
  const native = plug({
    port: events,
    bind: () => async (message: Event, publishOptions: PublishOptions) => {
      await options.send?.(message, publishOptions);
      const { messageId: id, propagation } = publishOptions;
      sent.push({ message, id, ...(propagation === undefined ? {} : { propagation }) });
    },
  });
  const change = command<Event>()({
    requirements: { events },
    run: async (input, ctx) => {
      await ctx.events.publish(input);
      return input.reject === true ? failure(Rejected()) : success();
    },
  });
  const definitions: Definition[] = [
    change,
    events,
    outbox({
      name: "events",
      plug: native,
      ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
      ...(options.connection === undefined ? {} : { connection: options.connection as never }),
    }),
    unit({ provides: outboxStore, factory: () => state.store }),
    plug({ port: defaultUnitOfWork, bind: () => state.uow }),
    outboxControl,
  ];
  const start = (extra: readonly Definition[] = [], probes = false) =>
    runApplication(
      defineApplication({
        modules: [
          composeModule({ providers: [...definitions, ...extra].map((source) => ({ source })) }),
          ...(probes ? [health] : []),
        ],
      }),
      { stopOn: [] },
    );
  return { ...state, sent, change, events, start };
}

test("a committed publication is stored with its change and delivered after commit as its JSON form", async () => {
  const { start, change, sent, rows, until } = scenario();
  const app = await start();
  try {
    const at = new Date("2026-11-08T10:00:00.000Z");
    assert.ok(!(await app.withScope((scope) => scope.resolve(change)({ name: "created", at }))).isError);
    await until(() => sent.length === 1 && rows.length === 0);
    assert.deepEqual(sent[0]!.message, { name: "created", at: "2026-11-08T10:00:00.000Z" });
    assert.match(sent[0]!.id ?? "", /^[0-9a-f-]{36}$/);
  } finally {
    await app.stop();
  }
});

test("a rolled-back publication is neither stored nor sent", async () => {
  const { start, change, sent, rows } = scenario();
  const app = await start();
  try {
    const result = await app.withScope((scope) => scope.resolve(change)({ name: "refused", reject: true }));
    assert.ok(result.isError && Rejected.is(result.error));
    assert.deepEqual([rows.length, sent.length], [0, 0]);
  } finally {
    await app.stop();
  }
});

test("a publication that is not a JSON value rolls its change back instead of sending another message", async () => {
  const { start, change, sent, rows } = scenario();
  const app = await start();
  try {
    for (const count of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await app.withScope((scope) => scope.resolve(change)({ name: "counted", count }));
      assert.ok(result.isError);
    }
    assert.deepEqual([rows.length, sent.length], [0, 0]);
  } finally {
    await app.stop();
  }
});

test("a failed send keeps its record, and the next send delivers it first", async () => {
  let down = true;
  const { start, change, sent, rows, until } = scenario({
    send: () => {
      if (down) {
        throw new Error("broker unavailable");
      }
    },
  });
  const app = await start();
  try {
    await app.withScope((scope) => scope.resolve(change)({ name: "first" }));
    await until(() => rows[0]?.attempts === 1);
    assert.equal(rows[0]!.error, "Error: broker unavailable");
    assert.equal(sent.length, 0);
    down = false;
    await app.withScope((scope) => scope.resolve(change)({ name: "second" }));
    await until(() => rows.length === 0);
    assert.deepEqual(
      sent.map((each) => each.message.name),
      ["first", "second"],
    );
  } finally {
    await app.stop();
  }
});

test("a delivery requested while a send is failing gets another round", { timeout: 5_000 }, async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const { start, change, sent, until } = scenario({
    send: async () => {
      if (++calls === 1) {
        entered.resolve();
        await release.promise;
        throw new Error("broker unavailable");
      }
    },
  });
  const app = await start();
  try {
    await app.withScope((scope) => scope.resolve(change)({ name: "retried" }));
    await entered.promise;
    app.resolve(outboxControl).deliver("events");
    release.resolve();
    await until(() => sent.length === 1);
    assert.equal(calls, 2);
  } finally {
    await app.stop();
  }
});

test("records a previous run left undelivered leave at startup, without new traffic", async () => {
  const { start, sent, rows, seed, until } = scenario();
  seed("events", { name: "left" });
  seed("other", { name: "foreign" });
  const app = await start();
  try {
    await until(() => sent.length === 1);
    assert.deepEqual(sent[0], { message: { name: "left" }, id: "seed-1" });
    assert.deepEqual(
      rows.map((row) => row.name),
      ["other"],
    );
  } finally {
    await app.stop();
  }
});

test("a delivery claims at most batchSize records at a time and sends each with its trace propagation", async () => {
  const { start, sent, store, seed, until } = scenario({ batchSize: 2 });
  const limits: number[] = [];
  const claim = store.claim;
  store.claim = (name, owner, limit) => {
    limits.push(limit);
    return claim(name, owner, limit);
  };
  const propagation = { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" };
  seed("events", { name: "first" }, undefined, propagation);
  seed("events", { name: "second" });
  seed("events", { name: "third" });
  const app = await start();
  try {
    await until(() => sent.length === 3);
    assert.ok(limits.length > 1 && limits.every((limit) => limit === 2));
    assert.deepEqual(
      sent.map((each) => each.message.name),
      ["first", "second", "third"],
    );
    assert.deepEqual(sent[0]!.propagation, propagation);
    assert.equal(sent[1]!.propagation, undefined);
  } finally {
    await app.stop();
  }
});

test("a record a crashed instance still holds leaves once that instance's lease ends, without new traffic", async () => {
  const { start, sent, seed, until } = scenario();
  seed("events", { name: "orphaned" }, { owner: "crashed", until: Date.now() + 100 });
  const app = await start();
  try {
    await until(() => sent.length === 1);
    assert.deepEqual(sent[0]!.message, { name: "orphaned" });
  } finally {
    await app.stop();
  }
});

test("a restored connection delivers what a failed send left, and stopping stops watching", async () => {
  let down = true;
  const watchers = new Set<{ readonly restored: () => void }>();
  const connection = unit({
    factory: () => ({
      watch(handlers: { readonly lost: () => void; readonly restored: () => void }) {
        watchers.add(handlers);
        return () => void watchers.delete(handlers);
      },
    }),
  });
  const { start, change, sent, rows, until } = scenario({
    connection,
    send: () => {
      if (down) {
        throw new Error("broker unavailable");
      }
    },
  });
  const app = await start();
  try {
    await app.withScope((scope) => scope.resolve(change)({ name: "waiting" }));
    await until(() => rows[0]?.attempts === 1);
    assert.equal(watchers.size, 1);
    down = false;
    for (const watcher of watchers) {
      watcher.restored();
    }
    await until(() => sent.length === 1 && rows.length === 0);
  } finally {
    await app.stop();
  }
  assert.equal(watchers.size, 0);
});

test("a claim another owner takes over during a send stops the batch before its next record", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { start, sent, rows, seed, until } = scenario({
    send: async (message) => {
      if (message.name === "one") {
        entered.resolve();
        await release.promise;
      }
    },
  });
  seed("events", { name: "one" });
  seed("events", { name: "two" });
  const app = await start();
  try {
    await entered.promise;
    // The lease ended during the send and another instance took the name over.
    for (const row of rows) {
      row.owner = "other";
    }
    release.resolve();
    await until(() => sent.length === 1 && rows.length === 1);
  } finally {
    await app.stop();
  }
  assert.deepEqual(
    sent.map((each) => each.message.name),
    ["one"],
  );
  assert.deepEqual(
    rows.map((row) => [row.message, row.owner]),
    [[{ name: "two" }, "other"]],
  );
});

test("a send that fails after another owner took its record over leaves that owner's claim untouched", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { start, rows, seed } = scenario({
    send: async () => {
      entered.resolve();
      await release.promise;
      throw new Error("broker unavailable");
    },
  });
  seed("events", { name: "taken" });
  const app = await start();
  try {
    await entered.promise;
    rows[0]!.owner = "other";
    release.resolve();
  } finally {
    // Stopping waits for the failing send and what it records afterwards.
    await app.stop();
  }
  assert.deepEqual([rows[0]!.owner, rows[0]!.attempts], ["other", 0]);
});

test("deliveries do not run in the async context of the request that committed", async () => {
  const request = new AsyncLocalStorage<string>();
  const seen: (string | undefined)[] = [];
  const { start, change, sent, until } = scenario({ send: () => void seen.push(request.getStore()) });
  const app = await start();
  try {
    await request.run("request-1", () => app.withScope((scope) => scope.resolve(change)({ name: "isolated" })));
    await until(() => sent.length === 1);
    assert.deepEqual(seen, [undefined]);
  } finally {
    await app.stop();
  }
});

test("stopping waits for a send in flight and leaves the rest pending", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { start, sent, rows, seed } = scenario({
    send: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  seed("events", { name: "one" });
  seed("events", { name: "two" });
  const app = await start();
  await entered.promise;
  const stopped = app.stop();
  release.resolve();
  await stopped;
  assert.deepEqual(
    sent.map((each) => each.message.name),
    ["one"],
  );
  assert.deepEqual(
    rows.map((row) => [row.message, row.owner]),
    [[{ name: "two" }, undefined]],
  );
});

test("a name is declared once, and a publication needs a Unit of Work", async () => {
  const { start, events } = scenario();
  const duplicate = outbox({ name: "events", plug: plug({ port: publisher<Event>(), bind: () => () => undefined }) });
  await assert.rejects(start([duplicate]), /'events' is declared more than once/);

  const app = await start();
  try {
    await assert.rejects(
      app.withScope((scope) => scope.resolve(events).publish({ name: "outside" })),
      /require a Unit of Work/,
    );
  } finally {
    await app.stop();
  }
});

test("health reports down while a record is stuck", async () => {
  let down = true;
  const { start, change, rows, until } = scenario({
    send: () => {
      if (down) {
        throw new Error("broker unavailable");
      }
    },
  });
  // A check scoped to another outbox name in the same store is not held down by this one's record.
  const app = await start(
    [outboxHealth({ attempts: 1 }), outboxHealth({ name: "other", outbox: "other", attempts: 1 })],
    true,
  );
  try {
    const probes = app.resolve(healthProbes);
    const signal = new AbortController().signal;
    assert.deepEqual((await probes.health({ signal })).checks, { outbox: "up", other: "up" });
    await app.withScope((scope) => scope.resolve(change)({ name: "held" }));
    await until(() => rows[0]?.attempts === 1);
    assert.deepEqual((await probes.health({ signal })).checks, { outbox: "down", other: "up" });
    down = false;
    app.resolve(outboxControl).deliver("events");
    await until(() => rows.length === 0);
    assert.deepEqual((await probes.health({ signal })).checks, { outbox: "up", other: "up" });
  } finally {
    await app.stop();
  }
});

test("stuck records are reported, discarded or delivered again on request", async () => {
  let down = true;
  const { start, change, sent, rows, until } = scenario({
    send: () => {
      if (down) {
        throw new Error("broker unavailable");
      }
    },
  });
  const app = await start();
  try {
    const control = app.resolve(outboxControl);
    await app.withScope((scope) => scope.resolve(change)({ name: "poison" }));
    await until(() => rows[0]?.attempts === 1);
    const [stuck] = await control.stuck(1);
    assert.deepEqual([stuck!.name, stuck!.attempts], ["events", 1]);
    await control.discard(stuck!.id);
    assert.equal(rows.length, 0);

    await app.withScope((scope) => scope.resolve(change)({ name: "later" }));
    await until(() => rows[0]?.attempts === 1);
    down = false;
    control.deliver("events");
    await until(() => rows.length === 0);
    assert.deepEqual(
      sent.map((each) => each.message.name),
      ["later"],
    );
  } finally {
    await app.stop();
  }
});

test("a delivery round that fails is reported once, with the outbox's name", { timeout: 5_000 }, async () => {
  const { start, store, seed } = scenario();
  const failure = new Error("store unavailable");
  store.claim = async () => {
    throw failure;
  };
  seed("events", { name: "left" });
  const reported = Promise.withResolvers<ErrorReport>();
  const reporter = unit({ provides: errorReporter, factory: () => (report: ErrorReport) => reported.resolve(report) });
  const app = await start([reporter]);
  try {
    const report = await reported.promise;
    assert.deepEqual(
      [report.error, report.source, report.expected, report.attributes],
      [failure, "openknot.outbox", false, { "openknot.outbox.name": "events" }],
    );
  } finally {
    await app.stop();
  }
});
