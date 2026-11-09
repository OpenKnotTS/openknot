import {
  broadcast,
  command,
  expose,
  topic,
  guard,
  InputCancelledError,
  InputUnavailableError,
  InternalFlowError,
} from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
import { success, failure } from "@openknot-ts/behavior";
import {
  plug,
  composeModule,
  defineApplication,
  hook as lifecycleHook,
  override,
  resource,
  runApplication,
  unit,
} from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { EventEmitter, on } from "node:events";
import { test } from "node:test";

async function* empty(): AsyncIterable<never> {}

test("structured and numeric topic keys reach native bindings unchanged after shared guard admission", async () => {
  type Recipient = { readonly userId: string; readonly resourceId: number; readonly scope: "read" };
  const access = guard<string>()({ run: (token) => (token === "ok" ? success() : failure(new Error("Denied"))) });
  const targeted = topic<Recipient, string>()({ guards: { access } });
  const numbered = topic<number, string>()({});
  const stream = empty();
  const subscribed: unknown[] = [],
    published: unknown[] = [];
  const binding = {
    targeted: plug({
      port: targeted,
      bind: () => ({
        subscribe: (key) => {
          subscribed.push(key);
          return stream;
        },
        publish: (key) => {
          published.push(key);
        },
      }),
    }),
    numbered: plug({
      port: numbered,
      bind: () => ({
        subscribe: (key) => {
          subscribed.push(key);
          return stream;
        },
        publish: (key) => {
          published.push(key);
        },
      }),
    }),
  };
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { ...binding } })] }));
  const key: Recipient = Object.freeze({ userId: "alice", resourceId: 42, scope: "read" });
  try {
    await assert.rejects(app.resolve(targeted).subscribe({ input: key, access: "denied" }), /Denied/);
    assert.deepEqual(subscribed, []);
    assert.equal(await app.resolve(targeted).subscribe({ input: key, access: "ok" }), stream);
    await app.resolve(targeted).publish(key, "changed");
    assert.equal(subscribed[0], key);
    assert.equal(published[0], key);
    assert.equal(await app.resolve(numbered).subscribe({ input: 42 }), stream);
    await app.resolve(numbered).publish(42, "changed");
    assert.equal(subscribed[1], 42);
    assert.equal(published[1], 42);
  } finally {
    await app.stop();
  }
});

test("standalone contracts delegate to native operations and return the exact native stream", async () => {
  const changes = topic<"roles", { readonly id: number }>()({});
  const logs = broadcast<string>()({});
  const stream = empty(),
    published: unknown[][] = [],
    subscribed: unknown[][] = [];
  const output = {
    changes: plug({
      port: changes,
      bind: () => ({
        publish: (...args) => {
          published.push(args);
        },
        subscribe: (...args) => {
          subscribed.push(args);
          return stream;
        },
      }),
    }),
    logs: plug({
      port: logs,
      bind: () => ({
        publish: (...args) => {
          published.push(args);
        },
        subscribe: (...args) => {
          subscribed.push(args);
          return stream;
        },
      }),
    }),
  };
  const app = await runApplication(
    defineApplication({ modules: [provideFlow([changes, logs]), composeModule({ providers: { ...output } })] }),
  );
  const controller = new AbortController(),
    options = { signal: controller.signal, actor: "alice" };
  try {
    assert.equal(await app.resolve(changes).subscribe({ input: "roles", ...options }), stream);
    assert.equal(await app.resolve(logs).subscribe({ input: undefined, ...options }), stream);
    await app.resolve(changes).publish("roles", { id: 1 }, options);
    await app.resolve(logs).publish("created", options);
    assert.deepEqual(published, [
      ["roles", { id: 1 }, options],
      ["created", options],
    ]);
    const received = [subscribed[0]![1], subscribed[1]![0]] as (typeof options)[];
    assert.equal(subscribed[0]![0], "roles");
    assert.deepEqual(
      received.map(({ actor, signal }) => [actor, signal.aborted]),
      [
        ["alice", false],
        ["alice", false],
      ],
      "Admission scope release must not abort a native subscription.",
    );
    controller.abort();
    assert.deepEqual(
      received.map(({ signal }) => signal.aborted),
      [true, true],
      "A native subscription follows its caller's signal.",
    );
  } finally {
    controller.abort();
    await app.stop();
  }
});

test("native implementation methods keep their object as this after binding", async () => {
  const native = () => ({
    calls: [] as string[],
    publish(): void {
      this.calls.push("publish");
    },
    subscribe(): AsyncIterable<never> {
      this.calls.push("subscribe");
      return empty();
    },
  });
  const changes = topic<"roles", number>()({}),
    logs = broadcast<string>()({});
  const roles = native(),
    messages = native();
  const app = await runApplication(
    defineApplication({
      modules: [
        composeModule({
          providers: {
            roles: plug({ port: changes, bind: () => roles }),
            messages: plug({ port: logs, bind: () => messages }),
          },
        }),
      ],
    }),
  );
  try {
    await app.resolve(changes).subscribe({ input: "roles" });
    await app.resolve(changes).publish("roles", 1);
    await app.resolve(logs).subscribe({ input: undefined });
    await app.resolve(logs).publish("created");
    assert.deepEqual(
      [roles.calls, messages.calls],
      [
        ["subscribe", "publish"],
        ["subscribe", "publish"],
      ],
    );
  } finally {
    await app.stop();
  }
});

test("guard and binding dependencies share a short scope which closes before stream consumption", async () => {
  let acquired = 0,
    released = 0,
    guardSession: object | undefined,
    bindingSession: object | undefined;
  const session = resource({
    lifetime: "scoped",
    initialize: async () => {
      acquired++;
      return {
        value: {},
        release() {
          released++;
        },
      };
    },
  });
  const access = guard<string>()({
    requirements: { session },
    run: (_token, ctx) => {
      guardSession = ctx.session;
      return success();
    },
  });
  const changes = topic<string, number>()({ guards: { access } });
  const native = empty();
  const output = plug({
    port: changes,
    requirements: { session },
    bind: ({ session }) => {
      bindingSession = session;
      return { publish() {}, subscribe: () => native };
    },
  });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { output } })] }));
  try {
    assert.equal(acquired, 0);
    assert.equal(await app.resolve(changes).subscribe({ input: "roles", access: "token" }), native);
    assert.equal(guardSession, bindingSession);
    assert.equal(acquired, 1);
    assert.equal(released, 1);
  } finally {
    await app.stop();
  }
});

test("an output plug resolves its binding per message, and acquires only what delivery needs", async () => {
  let acquired = 0;
  const session = resource({
    lifetime: "scoped",
    initialize: async () => {
      acquired++;
      return { value: {}, release() {} };
    },
  });
  const direct = topic<string, number>()({});
  const plugged = broadcast<number>()({});
  const delivered: string[] = [];
  const bindings = composeModule({
    providers: {
      direct: plug({
        port: direct,
        bind: () => ({ publish: (key, message) => void delivered.push(`${key}:${message}`), subscribe: empty }),
      }),
      plugged: plug({
        port: plugged,
        requirements: { session },
        bind: () => ({ publish: (message) => void delivered.push(`all:${message}`), subscribe: empty }),
      }),
    },
  });
  const app = await runApplication(defineApplication({ modules: [bindings] }));
  const resolved = app.resolve(direct);
  try {
    await resolved.publish("roles", 1);
    await resolved.publish("roles", 2);
    // A plug without dependencies acquires no scope resource; another one acquires what it needs for each message.
    assert.equal(acquired, 0);
    await app.resolve(plugged).publish(3);
    assert.equal(acquired, 1);
    assert.deepEqual(delivered, ["roles:1", "roles:2", "all:3"]);
    const cancelled = new AbortController();
    cancelled.abort(new Error("caller cancelled"));
    await assert.rejects(resolved.publish("roles", 4, { signal: cancelled.signal }), /caller cancelled/);
  } finally {
    await app.stop();
  }
  await assert.rejects(resolved.publish("roles", 5), /Cannot open a scope while application is 'stopped'/);
  assert.deepEqual(delivered, ["roles:1", "roles:2", "all:3"]);
});

test("a publication acquires what delivery needs, never the admission guards' resources", async () => {
  const opened: string[] = [];
  let guardRuns = 0;
  const delivered: number[] = [];
  const admissionDb = resource({
    lifetime: "scoped",
    async initialize(): Promise<{ value: string; release(): void }> {
      opened.push("admission");
      throw new Error("admission DB unavailable");
    },
  });
  const deliveryChannel = resource({
    lifetime: "scoped",
    async initialize() {
      opened.push("delivery");
      return { value: (message: number) => void delivered.push(message), release() {} };
    },
  });
  const access = guard<string>()({
    requirements: { admissionDb },
    run: (_token) => {
      guardRuns++;
      return success();
    },
  });
  const changes = topic<string, number>()({ guards: { access } });
  const binding = plug({
    port: changes,
    requirements: { deliveryChannel },
    bind: ({ deliveryChannel }) => ({ publish: (_key, message) => deliveryChannel(message), subscribe: empty }),
  });
  const notify = command<number>()({
    requirements: { changes },
    run: async (message, ctx) => {
      await ctx.changes.publish("roles", message);
      return success();
    },
  });
  const api = expose({ handler: notify });
  const app = await runApplication(
    defineApplication({ modules: [provideFlow([api]), composeModule({ providers: { binding } })] }),
  );
  try {
    await app.resolve(changes).publish("roles", 1);
    assert.deepEqual(await app.resolve(api)({ input: 2 }), undefined);
    assert.deepEqual(delivered, [1, 2]);
    assert.deepEqual(opened, ["delivery", "delivery"]);
    assert.equal(guardRuns, 0);
    // Admission needs its guards: its scope acquires their resources, and their failure is the subscription's.
    await assert.rejects(
      app.resolve(changes).subscribe({ input: "roles", access: "token" }),
      (error: unknown) =>
        InternalFlowError.is(error) &&
        error.cause instanceof Error &&
        error.cause.message === "admission DB unavailable",
    );
    assert.equal(guardRuns, 0);
    assert.ok(opened.includes("admission"));
  } finally {
    await app.stop();
  }
});

test("the guards of a port a listed plug provides are validated at startup, though nothing requires the port", async () => {
  const missing = unit.contract<string>();
  const access = guard<string>()({ requirements: { missing }, run: (_token) => success() });
  const changes = topic<string, number>()({ guards: { access } });
  const binding = plug({ port: changes, bind: () => ({ publish() {}, subscribe: empty }) });
  await assert.rejects(
    runApplication(defineApplication({ modules: [composeModule({ providers: { binding } })] })),
    /unit 'missing' has no implementation/,
  );
});

test("admission rejection never resolves the backend and guard overrides apply to both port kinds", async () => {
  const denied = new Error("denied");
  let resolved = 0;
  const access = guard<string>()({ run: (_token) => failure(denied) });
  const changes = topic<string, number>()({ guards: { access } }),
    logs = broadcast<string>()({ guards: { access } });
  const backend = unit({ lifetime: "scoped", factory: () => ++resolved });
  const output = {
    changes: plug({
      port: changes,
      requirements: { backend },
      bind: () => ({ publish() {}, subscribe: () => empty() }),
    }),
    logs: plug({
      port: logs,
      requirements: { backend },
      bind: () => ({ publish() {}, subscribe: () => empty() }),
    }),
  };
  const application = defineApplication({ modules: [composeModule({ providers: { ...output } })] });
  const app = await runApplication(application);
  try {
    await assert.rejects(
      app.resolve(changes).subscribe({ input: "roles", access: "token" }),
      (error) => error === denied,
    );
    await assert.rejects(
      app.resolve(logs).subscribe({ input: undefined, access: "token" }),
      (error) => error === denied,
    );
    assert.equal(resolved, 0);
  } finally {
    await app.stop();
  }
  const allowed = await runApplication(application, { overrides: [override(access, async () => success())] });
  try {
    await allowed.resolve(changes).subscribe({ input: "roles", access: "token" });
    await allowed.resolve(logs).subscribe({ input: undefined, access: "token" });
    assert.equal(resolved, 2);
  } finally {
    await allowed.stop();
  }
});

test("cancellation during admission does not open a native source", async () => {
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  let subscriptions = 0;
  const access = guard<string>()({
    run: async (_token) => {
      entered.resolve();
      await finish.promise;
      return success();
    },
  });
  const changes = broadcast<number>()({ guards: { access } });
  const binding = plug({
    port: changes,
    bind: () => ({
      publish() {},
      subscribe: () => {
        subscriptions++;
        return empty();
      },
    }),
  });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { binding } })] }));
  const controller = new AbortController();
  try {
    const pending = app.resolve(changes).subscribe({ input: undefined, access: "token", signal: controller.signal });
    await entered.promise;
    controller.abort();
    finish.resolve();
    await assert.rejects(pending, InputCancelledError.is);
    assert.equal(subscriptions, 0);
  } finally {
    finish.resolve();
    await app.stop();
  }
});

test("admission reports an unavailable application and releases a stream it could not hand over", async () => {
  const released = new Error("connection release failed");
  const session = resource({
    lifetime: "scoped",
    initialize: async () => ({
      value: {},
      release() {
        throw released;
      },
    }),
  });
  const access = guard<string>()({ requirements: { session }, run: (_token) => success() });
  const changes = broadcast<number>()({ guards: { access } });
  const closed = Promise.withResolvers<void>();
  const source: AsyncIterableIterator<number> = {
    [Symbol.asyncIterator]: () => source,
    next: async () => ({ done: true, value: undefined }),
    return: async () => {
      closed.resolve();
      return { done: true, value: undefined };
    },
  };
  const binding = plug({ port: changes, bind: () => ({ publish() {}, subscribe: () => source }) });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { binding } })] }));
  const port = app.resolve(changes);
  try {
    await assert.rejects(
      port.subscribe({ input: undefined, access: "token" }),
      (error) =>
        InternalFlowError.is(error) &&
        error.cause instanceof AggregateError &&
        error.cause.errors.length === 1 &&
        error.cause.errors[0] === released,
    );
    await closed.promise;
  } finally {
    await app.stop();
  }
  await assert.rejects(port.subscribe({ input: undefined, access: "token" }), InputUnavailableError.is);
});

test("native source cleanup, pending reads and independent consumers stay with the backend", async () => {
  const changes = topic<string, number>()({});
  const bus = unit({ factory: () => new EventEmitter<{ [key: string]: [number] }>() });
  const output = plug({
    port: changes,
    requirements: { bus },
    bind: ({ bus }) => ({
      publish: (key, value) => {
        bus.emit(key, value);
      },
      subscribe: (key, { signal }) => {
        const native = on(bus, key, { signal });
        return {
          async *[Symbol.asyncIterator]() {
            for await (const [value] of native) {
              yield value as number;
            }
          },
        };
      },
    }),
  });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { output } })] }));
  const controller = new AbortController();
  try {
    const first = (await app.resolve(changes).subscribe({ input: "one" }))[Symbol.asyncIterator]();
    const second = (await app.resolve(changes).subscribe({ input: "one", signal: controller.signal }))[
      Symbol.asyncIterator
    ]();
    const a = first.next(),
      b = second.next();
    await app.resolve(changes).publish("one", 1);
    assert.deepEqual(await a, { done: false, value: 1 });
    assert.deepEqual(await b, { done: false, value: 1 });
    await first.return?.();
    assert.equal(app.resolve(bus).listenerCount("one"), 1);
    const pending = second.next();
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(app.resolve(bus).listenerCount("one"), 0);
  } finally {
    controller.abort();
    await app.stop();
  }
});

test("native iterator failures pass through without a framework delivery wrapper", async () => {
  const defect = new Error("native stream failed"),
    stopped: unknown[] = [];
  const source = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next(): Promise<IteratorResult<string>> {
      return Promise.reject(defect);
    },
    async return() {
      stopped.push("native cleanup");
      return { done: true as const, value: undefined };
    },
  };
  const messages = broadcast<string>()({});
  const binding = plug({
    port: messages,
    bind: () => ({
      publish() {
        throw defect;
      },
      subscribe: () => source,
    }),
  });
  const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { binding } })] }));
  try {
    const stream = await app.resolve(messages).subscribe({ input: undefined });
    assert.equal(stream, source);
    await assert.rejects(source.next(), (error) => error === defect);
    await source.return();
    assert.deepEqual(stopped, ["native cleanup"]);
    await assert.rejects(app.resolve(messages).publish("one"), (error) => error === defect);
  } finally {
    await app.stop();
  }
});

test("contracts require explicit implementations and output plugs validate their implementations", async () => {
  const messages = broadcast<number>()({});
  const implementation = { publish() {}, subscribe: () => empty() };
  const app = await runApplication(defineApplication({ modules: [provideFlow([messages])] }));
  try {
    assert.throws(() => app.resolve(messages), /The broadcast has no implementation/);
  } finally {
    await app.stop();
  }
  for (const [bindings, expected] of [
    [[], /requires subscribe and publish/],
    [() => {}, /requires subscribe and publish/],
    [42, /requires subscribe and publish/],
  ] as const) {
    const output = Reflect.apply(plug, undefined, [{ port: messages, bind: () => bindings }]);
    const app = await runApplication(defineApplication({ modules: [composeModule({ providers: { output } })] }));
    try {
      await assert.rejects(
        app.resolve(messages).subscribe({ input: undefined }),
        (error: unknown) => InternalFlowError.is(error) && expected.test(String(error.cause)),
      );
    } finally {
      await app.stop();
    }
  }
  const first = plug({ port: messages, bind: () => implementation }),
    second = plug({ port: messages, bind: () => implementation });
  await assert.rejects(
    runApplication(defineApplication({ modules: [composeModule({ providers: { first, second } })] })),
    /multiple implementations supplied for/,
  );
});

test("open subscriptions end once the application begins stopping, before its shutdown tasks", async () => {
  const changes = topic<"roles", number>()({});
  const ended = Promise.withResolvers<void>();
  let endedBeforeShutdown = false;
  const output = plug({
    port: changes,
    bind: () => ({
      publish: () => undefined,
      // A native stream that lives until its signal aborts, as a socket subscription does.
      subscribe: async function* (_key, { signal }) {
        try {
          yield 1;
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        } finally {
          ended.resolve();
        }
      },
    }),
  });
  const shutdown = lifecycleHook({
    run: async () => {
      await ended.promise;
      endedBeforeShutdown = true;
    },
  });
  const app = await runApplication(
    defineApplication({
      modules: [provideFlow([changes]), composeModule({ providers: { output } })],
      shutdownTasks: [shutdown],
    }),
    { stopOn: [] },
  );
  const stream = (await app.resolve(changes).subscribe({ input: "roles" }))[Symbol.asyncIterator]();
  assert.deepEqual(await stream.next(), { done: false, value: 1 });
  const reading = stream.next();
  await app.stop();
  assert.equal(endedBeforeShutdown, true);
  assert.deepEqual(await reading, { done: true, value: undefined });
});
