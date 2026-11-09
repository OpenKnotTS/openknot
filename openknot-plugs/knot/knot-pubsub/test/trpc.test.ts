import { inMemoryBroadcast, inMemoryTopic } from "../src/index.ts";
import { failure, success } from "@openknot-ts/behavior";
import { broadcast, guard, topic } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import { defineApplication, plug, providePlugs, resource, runApplication, unit } from "@openknot-ts/wire";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import { initTRPC } from "@trpc/server";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import type { CreateWSSContextFnOptions } from "@trpc/server/adapters/ws";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { z } from "zod";

const audience = z.object({ userId: z.string(), roleId: z.number(), scope: z.enum(["summary", "detail"]) });
type Audience = z.infer<typeof audience>;
type RpcContext = { readonly token: string; readonly signal: AbortSignal };

test(
  "tRPC WebSocket subscriptions share a physical socket and own independent native routing and cleanup",
  {
    timeout: 10_000,
  },
  async () => {
    const events = new EventEmitter();
    const access = guard<string>()({
      run: (token) => (token === "allowed" ? success() : failure(new Error("Denied"))),
    });
    const roles = topic<Audience, string>()({ guards: { access } });
    const logs = broadcast<string>()({ guards: { access } });
    const roleDelivery = resource({
      initialize: () =>
        inMemoryTopic<Audience, string>({
          events,
          event: (key) => `roles:${JSON.stringify([key.userId, key.roleId, key.scope])}`,
        }),
    });
    const logDelivery = resource({ initialize: () => inMemoryBroadcast<string>({ events, event: "logs" }) });
    const bindings = {
      roles: plug({
        port: roles,
        requirements: { roleDelivery },
        bind: ({ roleDelivery }) => roleDelivery,
      }),
      logs: plug({
        port: logs,
        requirements: { logDelivery },
        bind: ({ logDelivery }) => logDelivery,
      }),
    };
    const trpc = unit({ factory: () => initTRPC.context<RpcContext>().create() });
    const createContext = unit({
      factory:
        () =>
        ({ info }: CreateWSSContextFnOptions): RpcContext => ({
          token: info.connectionParams?.token ?? "",
          signal: info.signal,
        }),
    });
    const router = unit({
      requirements: { trpc, roles, logs },
      factory: ({ trpc, roles, logs }) =>
        trpc.router({
          roles: trpc.procedure.input(audience).subscription(({ input, ctx, signal }) =>
            roles.subscribe({
              input,
              access: ctx.token,
              signal: AbortSignal.any([ctx.signal, signal ?? ctx.signal]),
            }),
          ),
          logs: trpc.procedure.subscription(({ ctx, signal }) =>
            logs.subscribe({
              input: undefined,
              access: ctx.token,
              signal: AbortSignal.any([ctx.signal, signal ?? ctx.signal]),
            }),
          ),
        }),
    });
    const server = resource({
      requirements: { router, createContext },
      async initialize({ router, createContext }) {
        const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
        applyWSSHandler({ wss, router, createContext });
        await once(wss, "listening");
        return {
          value: wss,
          release: () =>
            new Promise<void>((resolve, reject) => {
              for (const client of wss.clients) {
                client.terminate();
              }
              wss.close((error) => (error === undefined ? resolve() : reject(error)));
            }),
        };
      },
    });
    const app = await runApplication(
      defineApplication({
        modules: [
          provideFlow([roles, logs]),
          providePlugs([roleDelivery, logDelivery, bindings, trpc, createContext, router, server]),
        ],
      }),
    );
    type Router = ReturnType<typeof app.resolve<typeof router>>;
    const wss = app.resolve(server);
    const address = wss.address();
    assert.ok(address !== null && typeof address !== "string");
    const url = `ws://127.0.0.1:${address.port}`;
    const socket = createWSClient({ url, connectionParams: { token: "allowed" }, lazy: { enabled: true, closeMs: 0 } });
    const client = createTRPCClient<Router>({ links: [wsLink({ client: socket })] });
    const deniedSocket = createWSClient({ url, connectionParams: { token: "denied" } });
    const deniedClient = createTRPCClient<Router>({ links: [wsLink({ client: deniedSocket })] });
    const key: Audience = { userId: "alice", roleId: 1, scope: "detail" };
    const errors: unknown[] = [];
    const a: string[] = [],
      duplicate: string[] = [],
      other: string[] = [],
      broadcastValues: string[] = [];
    try {
      const rejected = Promise.withResolvers<void>();
      deniedClient.roles.subscribe(key, {
        onError(error) {
          assert.match(error.message, /Denied/);
          rejected.resolve();
        },
      });
      await rejected.promise;
      assert.equal(app.resolve(roleDelivery).subscriberCount(key), 0, "Denied admission never opens native delivery.");
      assert.equal(wss.clients.size, 1);
      const deniedClosed = once([...wss.clients][0]!, "close");
      await deniedSocket.close();
      await deniedClosed;

      const readyA = Promise.withResolvers<void>(),
        readyDuplicate = Promise.withResolvers<void>();
      const readyOther = Promise.withResolvers<void>(),
        readyLog = Promise.withResolvers<void>();
      const receivedA = Promise.withResolvers<void>(),
        receivedDuplicate = Promise.withResolvers<void>(),
        receivedLog = Promise.withResolvers<void>();
      const first = client.roles.subscribe(key, {
        onStarted() {
          readyA.resolve();
        },
        onData(value) {
          a.push(value);
          receivedA.resolve();
        },
        onError(error) {
          errors.push(error);
        },
      });
      const same = client.roles.subscribe(
        { ...key },
        {
          onStarted() {
            readyDuplicate.resolve();
          },
          onData(value) {
            duplicate.push(value);
            receivedDuplicate.resolve();
          },
          onError(error) {
            errors.push(error);
          },
        },
      );
      const different = client.roles.subscribe(
        { ...key, scope: "summary" },
        {
          onStarted() {
            readyOther.resolve();
          },
          onData(value) {
            other.push(value);
          },
          onError(error) {
            errors.push(error);
          },
        },
      );
      const log = client.logs.subscribe(undefined, {
        onStarted() {
          readyLog.resolve();
        },
        onData(value) {
          broadcastValues.push(value);
          receivedLog.resolve();
        },
        onError(error) {
          errors.push(error);
        },
      });
      await Promise.all([readyA.promise, readyDuplicate.promise, readyOther.promise, readyLog.promise]);
      assert.equal(wss.clients.size, 1, "Topic and broadcast subscriptions share one native tRPC socket.");
      assert.equal(app.resolve(roleDelivery).subscriberCount(key), 2);
      assert.equal(app.resolve(logDelivery).subscriberCount(), 1);
      await app.resolve(roles).publish({ ...key }, "changed");
      await app.resolve(logs).publish("created");
      await Promise.all([receivedA.promise, receivedDuplicate.promise, receivedLog.promise]);
      assert.deepEqual(a, ["changed"]);
      assert.deepEqual(duplicate, ["changed"]);
      assert.deepEqual(other, []);
      assert.deepEqual(broadcastValues, ["created"]);

      const removed = once(events, "removeListener");
      first.unsubscribe();
      await removed;
      assert.equal(app.resolve(roleDelivery).subscriberCount(key), 1);
      assert.equal(app.resolve(logDelivery).subscriberCount(), 1);
      const readyAgain = Promise.withResolvers<void>(),
        receivedAgain = Promise.withResolvers<void>();
      const again: string[] = [];
      client.roles.subscribe(key, {
        onStarted() {
          readyAgain.resolve();
        },
        onData(value) {
          again.push(value);
          receivedAgain.resolve();
        },
        onError(error) {
          errors.push(error);
        },
      });
      await readyAgain.promise;
      assert.equal(app.resolve(roleDelivery).subscriberCount(key), 2);
      await app.resolve(roles).publish(key, "renamed");
      await receivedAgain.promise;
      assert.deepEqual(again, ["renamed"], "Resubscribe creates a fresh subscription without replay.");
      assert.deepEqual(a, ["changed"], "Unsubscribing one stream does not disconnect its socket.");
      const cleaned = Promise.withResolvers<void>();
      function onRemove() {
        if (app.resolve(roleDelivery).keys().length === 0 && app.resolve(logDelivery).subscriberCount() === 0) {
          events.off("removeListener", onRemove);
          cleaned.resolve();
        }
      }
      events.on("removeListener", onRemove);
      same.unsubscribe();
      different.unsubscribe();
      log.unsubscribe();
      await socket.close();
      await cleaned.promise;
      assert.deepEqual(
        events.eventNames(),
        [],
        "Socket cancellation releases the remaining live subscription before resource release.",
      );
      await app.stop();
      assert.deepEqual(events.eventNames(), []);
      assert.deepEqual(errors, []);
    } finally {
      await socket.close();
      await deniedSocket.close();
      await app.stop();
    }
  },
);
