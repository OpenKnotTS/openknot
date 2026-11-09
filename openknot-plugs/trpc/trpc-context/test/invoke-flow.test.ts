import { invokeFlow } from "../src/index.ts";
import { error, failure, success } from "@openknot-ts/behavior";
import { broadcast, expose, guard, InputCancelledError, InputUnavailableError } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import { composeModule, defineApplication, runApplication, plug } from "@openknot-ts/wire";
import { TRPCError } from "@trpc/server";
import assert from "node:assert/strict";
import { test } from "node:test";

const Denied = error("Denied");

test("invokeFlow forwards only the execution fields, returns the value and throws the error", async () => {
  const received: unknown[] = [];
  const signedIn = guard({
    run: (_input, ctx) => (ctx.actor === undefined ? failure(Denied()) : success()),
  });
  const greet = expose<string>()({
    guards: { signedIn },
    run: (name, ctx) => {
      received.push(ctx.signal.aborted, ctx.actor);
      return success(`hello ${name}`);
    },
  });
  const app = await runApplication(defineApplication({ modules: [provideFlow([greet])] }));
  try {
    const signal = new AbortController().signal;
    // A custom context field is never forwarded, so it cannot become an unknown request field.
    const ctx = { signal, actor: { userId: "u1" }, propagation: {}, tenant: "t1" };
    assert.equal(await invokeFlow(ctx, app.resolve(greet), { input: "ada" }), "hello ada");
    assert.deepEqual(received, [false, { userId: "u1" }]);
    await assert.rejects(invokeFlow({ ...ctx, actor: undefined }, app.resolve(greet), { input: "ada" }), Denied.is);
  } finally {
    await app.stop();
  }
});

test("invokeFlow gives cancelled and unavailable inputs their tRPC codes and admits subscriptions", async () => {
  async function* updates() {
    yield "created";
  }
  const greet = expose<string>()({ run: (name) => success(`hello ${name}`) });
  const changes = broadcast<string>()({});
  const app = await runApplication(
    defineApplication({
      modules: [
        provideFlow([greet]),
        composeModule({
          providers: [{ source: plug({ port: changes, bind: () => ({ publish() {}, subscribe: updates }) }) }],
        }),
      ],
    }),
  );
  const ctx = { signal: new AbortController().signal, actor: undefined, propagation: {} };
  const cancelled = (error: unknown) =>
    error instanceof TRPCError && error.code === "CLIENT_CLOSED_REQUEST" && InputCancelledError.is(error.cause);
  const unavailable = (error: unknown) =>
    error instanceof TRPCError && error.code === "SERVICE_UNAVAILABLE" && InputUnavailableError.is(error.cause);
  const invoke = app.resolve(greet);
  try {
    await assert.rejects(invokeFlow({ ...ctx, signal: AbortSignal.abort() }, invoke, { input: "ada" }), cancelled);
    const stream = await invokeFlow(ctx, app.resolve(changes).subscribe);
    const received: string[] = [];
    for await (const update of stream) {
      received.push(update);
    }
    assert.deepEqual(received, ["created"]);
  } finally {
    await app.stop();
  }
  await assert.rejects(invokeFlow(ctx, invoke, { input: "ada" }), unavailable);
});
