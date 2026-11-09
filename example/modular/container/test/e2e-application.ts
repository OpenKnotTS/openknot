import type { LogEvent, RoleEvent } from "@modular/behavior/events";
import type { RoleState } from "@modular/behavior/models/role";
import { listRoles, listLogs } from "@modular/behavior/readers";
import { createRoleExposure, getStateExposure } from "@modular/flow";
import { roleChangedListener } from "@modular/flow/listeners";
import { logPublisher, rolePublisher, saveLogWriter, saveRoleWriter, userHasAccessToRole } from "@modular/flow/ports";
import { accessConfig, identity } from "@modular/io";
import { transport } from "@modular/transport";
import type { AppRouter } from "@modular/transport";
import { reader, success } from "@openknot-ts/behavior";
import type { CacheChange } from "@openknot-ts/cache";
import { cache } from "@openknot-ts/cache";
import { drizzleUnitOfWork } from "@openknot-ts/drizzle-uow";
import { defaultUnitOfWork, listener, upserted, writer } from "@openknot-ts/flow";
import { healthCheck } from "@openknot-ts/health";
import { healthHttp } from "@openknot-ts/knot-health";
import { http } from "@openknot-ts/knot-http-node";
import { rabbitTopology } from "@openknot-ts/rabbitmq";
import { redisClient, redisHealthCheck } from "@openknot-ts/redis-client";
import { trpcHttp } from "@openknot-ts/trpc-knot-server-handler";
import { config, defineApplication, plug, providePlugs, resource, runApplication, unit } from "@openknot-ts/wire";
import { TRPCClientError, createTRPCClient, httpLink } from "@trpc/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { boolean, pgTable, text } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createClient } from "redis";

// The modular application's own behavior, flow and transport, over real Postgres, RabbitMQ and Redis, shared by
// the opt-in suites that run against those services.
export const { DATABASE_URL, RABBITMQ_URL, REDIS_URL } = process.env;
export const skip =
  DATABASE_URL === undefined || RABBITMQ_URL === undefined || REDIS_URL === undefined
    ? "set DATABASE_URL, RABBITMQ_URL and REDIS_URL to run against real services"
    : false;

// Every run owns its exchange, queues and keys, so runs never share state; a process that continues the work of
// another, as after a crash, names that run in E2E_RUN.
export const run = process.env.E2E_RUN ?? randomUUID().slice(0, 8);

const required = (name: string) => (value: string | undefined) => {
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
};
// Each application owns its schema, unless E2E_SCHEMA names one that it shares with an earlier process.
const services = config({
  DATABASE_URL: required("DATABASE_URL"),
  REDIS_URL: required("REDIS_URL"),
  E2E_SCHEMA: (value: string | undefined) => value,
});

// IO: Postgres through the Drizzle Unit of Work. Role names must exist in role_names, a foreign key checked at
// commit, so an unlisted name passes the insert and fails the native commit. The log of an Auditor role violates
// a check, so the listener that writes it fails.
const roles = pgTable("roles", { id: text().primaryKey(), name: text().notNull(), active: boolean().notNull() });
const logs = pgTable("logs", { id: text().primaryKey(), action: text().notNull() });

export const database = resource({
  requirements: { services },
  async initialize({ services }) {
    const schema = services.E2E_SCHEMA ?? `openknot_e2e_${randomUUID().slice(0, 8)}`;
    const setup = new pg.Client({ connectionString: services.DATABASE_URL });
    await setup.connect();
    try {
      await setup.query(`
        CREATE SCHEMA IF NOT EXISTS ${schema};
        CREATE TABLE IF NOT EXISTS ${schema}.role_names (name TEXT PRIMARY KEY);
        INSERT INTO ${schema}.role_names VALUES ('Dispatcher'), ('Manager'), ('Auditor') ON CONFLICT DO NOTHING;
        CREATE TABLE IF NOT EXISTS ${schema}.roles (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL REFERENCES ${schema}.role_names (name) DEFERRABLE INITIALLY DEFERRED,
          active BOOLEAN NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ${schema}.logs (
          id TEXT PRIMARY KEY,
          action TEXT NOT NULL CHECK (action <> 'Created role "Auditor"')
        );
      `);
    } finally {
      await setup.end();
    }
    // Native driver timeouts bound every query, the health check's included, when Postgres stops answering.
    const pool = new pg.Pool({
      connectionString: services.DATABASE_URL,
      options: `-c search_path=${schema}`,
      connectionTimeoutMillis: 2_000,
      query_timeout: 5_000,
    });
    return {
      value: drizzle({ client: pool }),
      async release() {
        try {
          await pool.query(`DROP SCHEMA ${schema} CASCADE`);
        } finally {
          // end() settles once no client is checked out; each connection reports its own close with "remove".
          let open = pool.totalCount;
          const closed = new Promise<void>((resolve) => {
            if (open === 0) {
              resolve();
            }
            pool.on("remove", () => {
              if (--open === 0) {
                resolve();
              }
            });
          });
          await pool.end();
          await closed;
        }
      },
    };
  },
});

const transaction = unit({ requirements: { database }, factory: ({ database }) => drizzleUnitOfWork({ database }) });

const databaseHealth = healthCheck({
  name: "database",
  requirements: { database },
  check: async ({ database }) => {
    await database.$client.query("SELECT 1");
    return "up";
  },
});

type ManagedRole = RoleState & { readonly entity: "role" };
/** Called with the written row once a command has written a role inside its transaction, by id. */
export const roleWritten = new Map<string, (row: object) => void>();
export const findRole = reader<(id: string) => Promise<ManagedRole | undefined>>();
export let sourceReads = 0;

const storage = {
  unitOfWork: plug({ port: defaultUnitOfWork, requirements: { transaction }, bind: ({ transaction }) => transaction }),
  readers: plug({
    port: reader.compose({ listRoles, listLogs, userHasAccessToRole, findRole }),
    requirements: { transaction, accessConfig },
    bind: ({ transaction, accessConfig }) => ({
      listRoles: async () => (await transaction.current()).select().from(roles).orderBy(roles.id),
      listLogs: async () => (await transaction.current()).select().from(logs).orderBy(logs.id),
      userHasAccessToRole: async (userId) => userId !== undefined && userId === accessConfig.ACCESS_ACTOR,
      findRole: async (id) => {
        sourceReads++;
        const [row] = await (await transaction.current()).select().from(roles).where(eq(roles.id, id));
        return row === undefined ? undefined : { ...row, entity: "role" as const };
      },
    }),
  }),
  writers: plug({
    port: writer.compose({ saveRoleWriter, saveLogWriter }),
    requirements: { transaction },
    bind: ({ transaction }) => ({
      // The receipt names its entity, so the Unit of Work tracks the role and the cache follows its commits.
      saveRoleWriter: async (role) => {
        const session = await transaction.current();
        const [saved] = await session
          .insert(roles)
          .values(role)
          .onConflictDoUpdate({ target: roles.id, set: { name: role.name, active: role.active } })
          .returning();
        const row = { ...saved!, entity: "role" as const };
        roleWritten.get(role.id)?.(row);
        return upserted(row);
      },
      saveLogWriter: async (log) => {
        const session = await transaction.current();
        const [saved] = await session
          .insert(logs)
          .values(log)
          .onConflictDoUpdate({ target: logs.id, set: { action: log.action } })
          .returning();
        return upserted(saved!);
      },
    }),
  }),
};

// Redis: a read-through cache of single roles. A commit of a role evicts it, because a role has no version.
export const redis = redisClient({
  requirements: { services },
  // As Postgres's query timeout does, the native socket timeout bounds a command a server that stops answering holds;
  // pings keep an idle connection from reaching it.
  create: ({ services }) => ({
    commands: createClient({ url: services.REDIS_URL, pingInterval: 1_000, socket: { socketTimeout: 5_000 } }).on(
      "error",
      console.error,
    ),
    subscriber: createClient({ url: services.REDIS_URL, pingInterval: 1_000, socket: { socketTimeout: 5_000 } }).on(
      "error",
      console.error,
    ),
  }),
});
const redisHealth = redisHealthCheck({ redis });
export const cacheKey = (id: unknown) => `openknot-e2e:${run}:role:${String(id)}`;
const applied: { readonly match: (change: CacheChange) => boolean; readonly resolve: () => void }[] = [];
/** Settles with the work, or rejects once the test times out, so a failing test still stops its application. */
export function until<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const aborted = Promise.withResolvers<never>();
  const abort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  return Promise.race([work, aborted.promise]).finally(() => signal.removeEventListener("abort", abort));
}

/**
 * Resolves once the native store applied a matching change, of any key when `key` is undefined; subscribe before the
 * action that causes it.
 */
export function nextApplied(type: CacheChange["type"], key: string | undefined, signal: AbortSignal): Promise<void> {
  return until(
    new Promise((resolve) =>
      applied.push({
        match: (change) => change.type === type && (key === undefined || ("key" in change && change.key === key)),
        resolve,
      }),
    ),
    signal,
  );
}

const roleCache = cache({
  entity: "role",
  requirements: { redis },
  port: findRole,
  connection: ({ redis }) => redis.connection,
  persist: ({ redis }) => {
    // Calls take effect in the order they were made.
    let queue = Promise.resolve();
    return (changes) =>
      (queue = queue.then(async () => {
        for (const change of changes) {
          if (change.type === "set") {
            await redis.commands.sendCommand(["SET", cacheKey(change.key), JSON.stringify(change.value)]);
          } else if (change.type === "delete") {
            await redis.commands.sendCommand(["DEL", cacheKey(change.key)]);
          } else {
            const keys = (await redis.commands.sendCommand(["KEYS", cacheKey("*")])) as readonly string[];
            if (keys.length > 0) {
              await redis.commands.sendCommand(["DEL", ...keys]);
            }
          }
          for (const waiter of applied.filter((entry) => entry.match(change))) {
            applied.splice(applied.indexOf(waiter), 1);
            waiter.resolve();
          }
        }
      }));
  },
  bind: ({ redis }) => ({
    value: async (id) => {
      const stored = await redis.commands.sendCommand(["GET", cacheKey(id)]);
      return stored === null || stored === undefined ? undefined : (JSON.parse(String(stored)) as ManagedRole);
    },
  }),
});

// Channels: RabbitMQ carries RoleChanged to the log listener and LogCreated to an observer of this test. A
// RoleChanged the listener rejects is dead-lettered to a second observer.
const exchange = `openknot-e2e-${run}`;
const queues = { roles: `${exchange}.roles`, logs: `${exchange}.logs`, rejected: `${exchange}.rejected` };
// Unused queues expire natively, so entities of an interrupted run do not outlive it; the exchange goes with them.
const expires = { "x-expires": 60_000 };
export const { rabbitConnection, rabbitHealthCheck, rabbitListener, rabbitPublisher } = rabbitTopology({
  exchanges: [{ exchange, type: "topic", autoDelete: true }],
  queues: [
    {
      queue: queues.roles,
      arguments: { ...expires, "x-dead-letter-exchange": exchange, "x-dead-letter-routing-key": "role.rejected" },
    },
    { queue: queues.logs, arguments: expires },
    { queue: queues.rejected, arguments: expires },
  ],
  routes: [
    { exchange, routingKey: "role.changed" },
    { exchange, routingKey: "log.created" },
  ],
  queueBindings: [
    { exchange, queue: queues.roles, routingKey: "role.changed" },
    { exchange, queue: queues.logs, routingKey: "log.created" },
    { exchange, queue: queues.rejected, routingKey: "role.rejected" },
  ],
});

/** A listener that keeps what RabbitMQ delivers, and the next delivery in order. */
function observer<Message>() {
  const delivered: Message[] = [];
  const waiting: ((message: Message) => void)[] = [];
  return {
    port: listener<Message>()({
      run: (message) => {
        const resolve = waiting.shift();
        if (resolve === undefined) {
          delivered.push(message);
        } else {
          resolve(message);
        }
        return success();
      },
    }),
    next: (signal: AbortSignal) =>
      until(
        new Promise<Message>((resolve) => {
          const message = delivered.shift();
          if (message === undefined) {
            waiting.push(resolve);
          } else {
            resolve(message);
          }
        }),
        signal,
      ),
  };
}
export const logCreated = observer<LogEvent>();
export const roleRejected = observer<RoleEvent>();

/** Starts the application; `env` adds settings such as E2E_SCHEMA or native client timeouts. */
export function application(env: Readonly<Record<string, string>> = {}) {
  return runApplication(
    defineApplication({
      inputs: [createRoleExposure, getStateExposure, roleChangedListener, logCreated.port, roleRejected.port],
      modules: [
        transport,
        http,
        trpcHttp,
        healthHttp,
        providePlugs([database, transaction, databaseHealth, identity, storage, roleCache, redisHealth]),
        providePlugs([rabbitConnection, rabbitHealthCheck()]),
        providePlugs([
          rabbitPublisher({ exchange, routingKey: "role.changed" }, rolePublisher),
          rabbitPublisher({ exchange, routingKey: "log.created" }, logPublisher),
          rabbitListener({ queue: queues.roles }, roleChangedListener),
          rabbitListener({ queue: queues.logs }, logCreated.port),
          rabbitListener({ queue: queues.rejected }, roleRejected.port),
        ]),
      ],
    }),
    { env: { PORT: "0", DATABASE_URL, RABBITMQ_URL, REDIS_URL, ...env }, stopOn: [] },
  );
}

export function client(url: string, token = "example-token") {
  return createTRPCClient<AppRouter>({
    links: [httpLink({ url: `${url}/trpc`, headers: { authorization: `Bearer ${token}` } })],
  });
}

export const code = (expected: string) => (error: unknown) =>
  error instanceof TRPCClientError && error.data?.code === expected;

export const role = (id: string, name: string) => ({ id, name, active: true });
