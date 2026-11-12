import { command, defaultUnitOfWork, expose, listener, publisher, scheduler, unitOfWork } from "../src/index.ts";
import type { InputInvoker, PublishOptions } from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
import { error, failure, success } from "@openknot-ts/behavior";
import type { TraceSpan, Tracing } from "@openknot-ts/tracing";
import { trace } from "@openknot-ts/tracing/wire";
import {
  composeModule,
  defineApplication,
  optional,
  override,
  plug,
  providePlugs,
  runApplication,
  unit,
} from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

test("direct scoped handlers propagate carriers without a telemetry dependency and staging snapshots explicit carriers", async () => {
  const output = publisher<number>();
  const received: PublishOptions[] = [];
  const explicit = { traceparent: "original-explicit-carrier" };
  const work = command({
    requirements: { output },
    run: async (_, ctx) => {
      await ctx.output.publish(1);
      await ctx.output.publish(2, { propagation: explicit });
      explicit.traceparent = "mutated-after-staging";
      return success();
    },
  });
  const endpoint = expose({ handler: work });
  const binding = plug({
    port: output,
    bind: () => (_input, options) => {
      received.push(options);
    },
  });
  const app = await runApplication(
    defineApplication({ modules: [provideFlow([endpoint]), composeModule({ providers: { binding } })] }),
  );
  try {
    assert.equal(app.resolve(optional(trace)), undefined);
    assert.throws(() => app.resolve(trace), /unavailable/);
    assert.ok(
      !(
        await app.withScope((scope) =>
          scope.resolve(work)(undefined, {
            propagation: { traceparent: "root-carrier" },
            actor: "alice",
          }),
        )
      ).isError,
    );
    assert.equal(received[0]?.propagation?.traceparent, "root-carrier");
    assert.equal(received[1]?.propagation?.traceparent, "original-explicit-carrier");
    assert.equal(Object.hasOwn(received[0]!, "actor"), false);
    assert.equal(received[0]?.tracing, undefined);
    assert.ok(Object.isFrozen(received[1]?.propagation));
  } finally {
    await app.stop();
  }
});

test("native bindings inherit only their own container's optional tracing without declaring a tracing dependency", async () => {
  const firstTracing: Tracing = {
    run: async (_operation, work) => work(),
    capture: () => undefined,
    bind: (work) => work,
  };
  const secondTracing: Tracing = { ...firstTracing };
  const output = publisher<number>();
  const received: { input: number; tracing: Tracing | undefined }[] = [];
  const work = command<number>()({
    requirements: { output },
    run: async (input, ctx) => {
      await ctx.output.publish(input);
      return success(input);
    },
  });
  const endpoint = expose({ handler: work });
  const incoming = listener({ handler: work });
  const scheduled = scheduler({ schedule: { every: { seconds: 1 } }, run: () => success() });
  const sources: InputInvoker<typeof incoming>[] = [];
  const timers: InputInvoker<typeof scheduled>[] = [];
  const inputBinding = plug({
    port: incoming,
    bind: ({ invoke }) => {
      sources.push(invoke);
      return { release() {} };
    },
  });
  const timerBinding = plug({
    port: scheduled,
    bind: ({ invoke }) => {
      timers.push(invoke);
      return { release() {} };
    },
  });
  const outputBinding = plug({
    port: output,
    bind: () => (input, options) => {
      received.push({ input, tracing: options.tracing });
    },
  });
  const definition = defineApplication({
    modules: [provideFlow([endpoint]), providePlugs([inputBinding, timerBinding, outputBinding])],
  });
  const first = await runApplication(definition, { overrides: [override(trace, firstTracing)] });
  const untraced = await runApplication(definition);
  const second = await runApplication(definition, { overrides: [override(trace, secondTracing)] });
  try {
    const applications = [first, untraced, second];
    const configured = [firstTracing, undefined, secondTracing];
    for (const [index, app] of applications.entries()) {
      assert.equal(app.resolve(endpoint).tracing, configured[index]);
      assert.equal(sources[index]?.tracing, configured[index]);
      assert.equal(timers[index]?.tracing, configured[index]);
    }
    await Promise.all(
      applications.flatMap((app, index) => [
        app.resolve(endpoint)({ input: index }),
        sources[index]!({ input: index + 10 }),
        timers[index]!({ trigger: { scheduledAt: Date.now() } }),
      ]),
    );
    for (const [index, tracing] of configured.entries()) {
      assert.equal(received.find((item) => item.input === index)?.tracing, tracing);
      assert.equal(received.find((item) => item.input === index + 10)?.tracing, tracing);
    }
    assert.equal(received.length, 6);
  } finally {
    await Promise.all([first.stop(), untraced.stop(), second.stop()]);
  }
});

test("conditional native integrations match implemented Flow ports and leave unbound ports inactive", async () => {
  const output = publisher<number>();
  let enabled = 0;
  const integration = unit({ whenAvailable: [output], factory: () => ++enabled });
  const ports = provideFlow([output]);
  const additions = providePlugs([integration]);
  const absent = await runApplication(defineApplication({ modules: [ports, additions] }));
  try {
    assert.throws(() => absent.resolve(integration), /unavailable/);
    assert.equal(enabled, 0);
  } finally {
    await absent.stop();
  }
  const binding = plug({ port: output, bind: () => () => {} });
  const present = await runApplication(defineApplication({ modules: [additions, providePlugs([binding]), ports] }));
  try {
    assert.equal(present.resolve(integration), 1);
  } finally {
    await present.stop();
  }
});

test("optional native requirements stay weak in Flow input scopes and preserve scoped values when present", async () => {
  let created = 0;
  const service = unit({ lifetime: "scoped", factory: () => ++created });
  const incoming = listener({
    requirements: { service: optional(service) },
    run: (_, ctx) => success(ctx.service),
  });
  const api = expose({ requirements: { service: optional(service) }, run: (_, ctx) => success(ctx.service) });
  const flow = provideFlow([incoming, api]);
  const absent = await runApplication(defineApplication({ modules: [flow] }));
  try {
    assert.deepEqual(await absent.resolve(incoming)({ input: undefined }), undefined);
    assert.deepEqual(await absent.resolve(api)({ input: undefined }), undefined);
    assert.equal(created, 0);
  } finally {
    await absent.stop();
  }
  const present = await runApplication(defineApplication({ modules: [flow, providePlugs([service])] }));
  try {
    assert.deepEqual(await present.resolve(incoming)({ input: undefined }), 1);
    assert.deepEqual(await present.resolve(api)({ input: undefined }), 2);
  } finally {
    await present.stop();
  }
});

test("Flow describes its executions as neutral spans, and returned failures reach the implementation", async () => {
  const Rejected = error("Rejected");
  const recorded: { readonly span: TraceSpan; readonly failure: unknown }[] = [];
  const recording: Tracing = {
    run: async (span, work) => {
      const result = await work();
      recorded.push({ span, failure: span.failure?.(result) });
      return result;
    },
    capture: () => undefined,
    bind: (work) => work,
  };
  const rejecting = command({ tag: "orders.reject", run: async () => failure(Rejected()) });
  const endpoint = expose({ handler: rejecting });
  const incoming = listener({ run: () => success() });
  const scheduled = scheduler({ schedule: { every: { seconds: 1 } }, run: () => success() });
  const sources: InputInvoker<typeof incoming>[] = [];
  const timers: InputInvoker<typeof scheduled>[] = [];
  const bindings = providePlugs([
    plug({ port: incoming, bind: ({ invoke }) => (sources.push(invoke), { release() {} }) }),
    plug({ port: scheduled, bind: ({ invoke }) => (timers.push(invoke), { release() {} }) }),
  ]);
  const app = await runApplication(defineApplication({ modules: [provideFlow([endpoint]), bindings] }), {
    overrides: [override(trace, recording)],
  });
  try {
    const carrier = { traceparent: "remote" };
    await assert.rejects(app.resolve(endpoint)({ input: undefined, propagation: carrier }), Rejected.is);
    await sources[0]!({ input: undefined, propagation: carrier });
    await timers[0]!({ trigger: { scheduledAt: Date.now() } });
    const described = (name: string) => {
      const entry = recorded.find(({ span }) => span.name === name);
      return entry && { kind: entry.span.kind, root: entry.span.root, carrier: entry.span.propagation?.traceparent };
    };
    assert.deepEqual(described("openknot.expose"), { kind: undefined, root: undefined, carrier: "remote" });
    assert.deepEqual(described("openknot.listener"), { kind: "consumer", root: true, carrier: "remote" });
    assert.deepEqual(described("openknot.scheduler"), { kind: undefined, root: true, carrier: undefined });
    const rejected = recorded.find(({ span }) => span.name === "openknot.command");
    assert.equal(Rejected.is(rejected?.failure), true);
    assert.equal(rejected?.span.attributes?.["openknot.execution.kind"], "command");
    assert.equal(rejected?.span.attributes?.["openknot.execution.tag"], "orders.reject");
    const untagged = recorded.find(({ span }) => span.name === "openknot.expose");
    assert.equal(untagged?.span.attributes?.["openknot.execution.tag"], undefined);
    assert.ok(recorded.every(({ span }) => !("execution" in span) && !("actor" in span)));
  } finally {
    await app.stop();
  }
});

test("a tracing binding that fails when called still delivers committed effects and publications", async () => {
  const unavailable: Tracing = {
    run: async (_span, work) => work(),
    capture: () => undefined,
    bind: () => () => {
      throw new Error("context unavailable");
    },
  };
  const restoreFails: Tracing = {
    ...unavailable,
    bind: (work) => async () => {
      await work();
      throw new Error("context restore failed");
    },
  };
  for (const tracing of [unavailable, restoreFails]) {
    let commits = 0;
    const delivered: string[] = [];
    const output = publisher<number>();
    const database = unitOfWork();
    const work = command({
      requirements: { output },
      run: async (_, ctx) => {
        ctx.uow.afterCommit(async () => {
          delivered.push("effect");
        });
        await ctx.output.publish(1);
        return success();
      },
    });
    const providers = {
      work,
      binding: plug({
        port: output,
        bind: () => () => {
          delivered.push("publication");
        },
      }),
      driver: plug({
        port: database,
        bind: () => ({
          async transaction(execute) {
            const result = await execute();
            commits++;
            return result;
          },
        }),
      }),
    };
    const app = await runApplication(
      defineApplication({
        modules: [
          composeModule({
            providers: {
              ...providers,
              selection: unit({
                provides: defaultUnitOfWork,
                lifetime: "scoped",
                requirements: { database },
                factory: ({ database }) => database,
              }),
            },
          }),
        ],
      }),
      { overrides: [override(trace, tracing)] },
    );
    try {
      const result = await app.withScope((scope) => scope.resolve(work)());
      assert.equal(result.isError, false);
      assert.equal(commits, 1);
      assert.deepEqual(delivered, ["effect", "publication"]);
    } finally {
      await app.stop();
    }
  }
});
