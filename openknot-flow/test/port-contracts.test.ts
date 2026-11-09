import type { UowActive } from "../src/index.ts";
import {
  command,
  expose,
  guard,
  hook,
  InternalFlowError,
  listener,
  PostCommitError,
  publisher,
  unitOfWork,
  writer,
} from "../src/index.ts";
import type {} from "../src/wire.ts";
import { recording } from "./fixtures/unit-of-work.ts";
import { error, failure, reader, success } from "@openknot-ts/behavior";
import type { Definition, ValueOverride } from "@openknot-ts/wire";
import { composeModule, defineApplication, optional, override, plug, runApplication, unit } from "@openknot-ts/wire";
import assert from "node:assert/strict";
import { test } from "node:test";

// One test per execution contract, over every consumer of a port and every way a port can be bound or required.

function start(definitions: readonly Definition[], overrides: readonly ValueOverride[] = []) {
  return runApplication(
    defineApplication({ modules: [composeModule({ providers: definitions.map((source) => ({ source })) })] }),
    { overrides, stopOn: [] },
  );
}

async function failureOf(work: () => Promise<unknown>): Promise<unknown> {
  try {
    const result = await work();
    return typeof result === "object" && result !== null && "error" in result && "isError" in result && result.isError
      ? result.error
      : undefined;
  } catch (thrown) {
    return thrown;
  }
}

const typeOf = (value: unknown) =>
  typeof value === "object" && value !== null && "type" in value ? value.type : String(value);

test("nothing is published before commit, whatever consumes the publisher and however it is bound", async () => {
  const Denied = error("Denied");
  for (const binding of ["plug", "native unit", "override"] as const) {
    for (const requirement of ["required", "optional"] as const) {
      for (const consumer of ["command", "beforeCommit hook"] as const) {
        const label = `${consumer}, ${requirement} publisher bound by ${binding}`;
        const log: string[] = [];
        const events = publisher<string>();
        const required = requirement === "required" ? events : optional(events);
        const send = async (value: string) => {
          log.push(`sent ${value}`);
        };
        const native = { publish: send, publishNow: send };
        let commits = true;
        const announce = hook<UowActive>()({
          requirements: { events: required },
          run: async (_, ctx) => {
            await ctx.events?.publish("hook");
            return commits ? success() : failure(Denied());
          },
        });
        const database = unitOfWork({ hooks: { beforeCommit: consumer === "beforeCommit hook" ? [announce] : [] } });
        const work = command<boolean>()({
          unitOfWork: database,
          requirements: { events: required },
          run: async (commit, ctx) => {
            commits = commit;
            if (consumer === "command") {
              await ctx.events?.publish("command");
              return commit ? success() : failure(Denied());
            }
            return success();
          },
        });
        const definitions: Definition[] = [work, plug({ port: database, bind: () => recording(log) })];
        if (binding === "plug") {
          definitions.push(plug({ port: events, bind: () => send }));
        } else if (binding === "native unit") {
          definitions.push(unit({ provides: events, lifetime: "scoped", factory: () => native }));
        }
        const app = await start(definitions, binding === "override" ? [override(events, native)] : []);
        try {
          await app.withScope((scope) => scope.resolve(work)(false));
          assert.deepEqual(log, ["rollback"], label);
          await app.withScope((scope) => scope.resolve(work)(true));
          assert.deepEqual(log, ["rollback", "commit", `sent ${consumer === "command" ? "command" : "hook"}`], label);
        } finally {
          await app.stop();
        }
      }
    }
  }
});

test("a cancelled execution stops before its next port call, whatever runs it", async () => {
  for (const port of ["reader", "optional reader", "writer"] as const) {
    let calls = 0;
    let cancel = new AbortController();
    const find = reader<() => number>();
    const save = writer<() => number>();
    const requirements = { find: port === "optional reader" ? optional(find) : find, save };
    // The execution cancels itself, then calls the port as its very next step.
    const callPort = (ctx: { readonly find: (() => number) | undefined; readonly save: () => number }) => {
      cancel.abort(new Error("cancelled"));
      return port === "writer" ? ctx.save() : ctx.find?.();
    };
    const run = async (_: unknown, ctx: Parameters<typeof callPort>[0]) => {
      callPort(ctx);
      return success();
    };
    const handler = command({ requirements, run });
    const exposure = expose({ requirements, run });
    const messages = listener({ requirements, run });
    const access = guard({ requirements, run });
    const caller = command({
      requirements: { access },
      run: async (_, ctx) => {
        cancel.abort(new Error("caller cancelled"));
        return ctx.access();
      },
    });
    const audit = hook()({ requirements, run });
    const beforeCommit = hook<UowActive>()({ requirements, run });
    const database = unitOfWork({ hooks: { beforeCommit: [beforeCommit] } });
    const committing = command({ unitOfWork: database, run: () => success() });
    const app = await start([
      handler,
      exposure,
      messages,
      access,
      caller,
      audit,
      committing,
      plug({ port: database, bind: () => ({ transaction: (work) => work() }) }),
      plug({ port: find, bind: () => () => ++calls }),
      plug({ port: save, bind: () => () => ++calls }),
    ]);
    try {
      const entries = {
        command: () => app.withScope((scope) => scope.resolve(handler)(undefined, { signal: cancel.signal })),
        exposure: () => app.resolve(exposure)({ signal: cancel.signal }),
        listener: () => app.resolve(messages)({ signal: cancel.signal }),
        "guard called directly": () =>
          app.withScope((scope) => scope.resolve(access)(undefined, { signal: cancel.signal })),
        "guard called by a cancelled execution": () =>
          app.withScope((scope) => scope.resolve(caller)(undefined, { signal: cancel.signal })),
        "hook called directly": () =>
          app.withScope((scope) => scope.resolve(audit)(undefined, { signal: cancel.signal, actor: undefined })),
        "beforeCommit hook": () =>
          app.withScope((scope) => scope.resolve(committing)(undefined, { signal: cancel.signal })),
      };
      for (const [entry, invoke] of Object.entries(entries)) {
        cancel = new AbortController();
        const failed = await failureOf(invoke);
        assert.equal(typeOf(failed), "InputCancelledError", `${entry} calling a ${port}`);
        assert.equal(calls, 0, `${entry} calling a ${port}`);
      }
    } finally {
      await app.stop();
    }
  }
});

test("another execution's classified failure from a port is this execution's internal failure", async () => {
  // A plug that invokes another execution and passes on its rejection, as an in-process bus or module call may.
  const foreign = PostCommitError("publications", new Error("another command's broker"));
  const shapes = {
    "rejected promise": () => Promise.reject(foreign),
    "rejected thenable": (): PromiseLike<number> => ({
      then: (onFulfilled, onRejected) => Promise.reject<number>(foreign).then(onFulfilled, onRejected),
    }),
    throw: () => {
      throw foreign;
    },
  };
  for (const [shape, implementation] of Object.entries(shapes)) {
    for (const port of ["reader", "optional reader", "writer"] as const) {
      const find = reader<() => PromiseLike<number>>();
      const save = writer<() => PromiseLike<number>>();
      const requirements = { find: port === "optional reader" ? optional(find) : find, save };
      const run = async (
        _: unknown,
        ctx: { readonly find: (() => PromiseLike<number>) | undefined; readonly save: () => PromiseLike<number> },
      ) => {
        await (port === "writer" ? ctx.save() : ctx.find?.());
        return success();
      };
      const handler = command({ requirements, run });
      const exposure = expose({ requirements, run });
      const access = guard({ requirements, run });
      const audit = hook()({ requirements, run });
      const app = await start([
        handler,
        exposure,
        access,
        audit,
        plug({ port: find, bind: () => implementation }),
        plug({ port: save, bind: () => implementation }),
      ]);
      try {
        const entries = {
          command: () => app.withScope((scope) => scope.resolve(handler)()),
          exposure: () => app.resolve(exposure)({}),
          guard: () => app.withScope((scope) => scope.resolve(access)()),
          hook: () =>
            app.withScope((scope) =>
              scope.resolve(audit)(undefined, { signal: new AbortController().signal, actor: undefined }),
            ),
        };
        for (const [entry, invoke] of Object.entries(entries)) {
          const failed = await failureOf(invoke);
          const label = `${entry} calling a ${port} that fails with a ${shape}`;
          assert.ok(InternalFlowError.is(failed), label);
          assert.equal(failed.cause, foreign, label);
        }
      } finally {
        await app.stop();
      }
    }
  }
});
