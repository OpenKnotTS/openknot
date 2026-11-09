import { bindTrace, capturePropagation, withTrace } from "../src/index.ts";
import type { Tracing } from "../src/index.ts";
import { trace } from "../src/wire.ts";
import { composeModule, defineApplication, optional, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

const span = { name: "work" };
const passthrough: Tracing = {
  run: (_span, work) => work(),
  capture: () => undefined,
  bind: (work) => work,
};

test("without an implementation the work runs directly", async () => {
  assert.equal(await withTrace(undefined, span, async () => 42), 42);
});

test("an implementation cannot skip, repeat or replace the work's result", async () => {
  let calls = 0;
  const work = async () => ++calls;
  const skips: Tracing = {
    ...passthrough,
    run: async () => {
      throw new Error("tracing unavailable");
    },
  };
  const repeats: Tracing = {
    ...passthrough,
    run: async (_span, work) => {
      await work();
      return work();
    },
  };
  const failsAfter: Tracing = {
    ...passthrough,
    run: async (_span, work) => {
      await work();
      throw new Error("export failed");
    },
  };
  assert.equal(await withTrace(skips, span, work), 1);
  assert.equal(await withTrace(repeats, span, work), 2);
  assert.equal(await withTrace(failsAfter, span, work), 3);
  assert.equal(calls, 3);
});

test("a rejected work keeps its own error", async () => {
  const expected = new Error("business failure");
  const replacing: Tracing = {
    ...passthrough,
    run: async (_span, work) => {
      await work().catch(() => {});
      throw new Error("tracing failure");
    },
  };
  for (const tracing of [passthrough, replacing]) {
    await assert.rejects(
      withTrace(tracing, span, async () => {
        throw expected;
      }),
      (error) => error === expected,
    );
  }
});

test("capture and bind failures fall back to no carrier and the original work", async () => {
  let calls = 0;
  const broken: Tracing = {
    ...passthrough,
    capture: () => {
      throw new Error("capture failed");
    },
    bind: () => {
      throw new Error("bind failed");
    },
  };
  const work = async () => ++calls;
  assert.equal(capturePropagation(broken), undefined);
  assert.equal(capturePropagation(undefined), undefined);
  assert.equal(await bindTrace(broken, work)(), 1);
  assert.equal(bindTrace(undefined, work), work);
});

test("a bound work runs once, also when the binding fails as it is called", async () => {
  let calls = 0;
  const work = async () => ++calls;
  const failsBefore: Tracing = {
    ...passthrough,
    bind: () => () => {
      throw new Error("context unavailable");
    },
  };
  const failsAfter: Tracing = {
    ...passthrough,
    bind: (bound) => async () => {
      await bound();
      throw new Error("context restore failed");
    },
  };
  const repeats: Tracing = {
    ...passthrough,
    bind: (bound) => async () => {
      await bound();
      return bound();
    },
  };
  assert.equal(await bindTrace(failsBefore, work)(), 1);
  assert.equal(await bindTrace(failsAfter, work)(), 2);
  const repeated = bindTrace(repeats, work);
  assert.equal(await repeated(), 3);
  assert.equal(await repeated(), 3);
  assert.equal(calls, 3);
});

test("trace has no implementation of its own and optional consumers see the bound one", async () => {
  const consumer = unit({ requirements: { tracing: optional(trace) }, factory: ({ tracing }) => tracing });
  const implementation = unit({ provides: trace, factory: () => passthrough });
  const absent = await runApplication(defineApplication({ modules: [composeModule({ providers: { consumer } })] }));
  const present = await runApplication(
    defineApplication({ modules: [composeModule({ providers: { consumer, implementation } })] }),
  );
  try {
    assert.equal(absent.resolve(consumer), undefined);
    assert.throws(() => absent.resolve(trace), /unavailable/);
    assert.equal(present.resolve(consumer), passthrough);
  } finally {
    await Promise.all([absent.stop(), present.stop()]);
  }
});
