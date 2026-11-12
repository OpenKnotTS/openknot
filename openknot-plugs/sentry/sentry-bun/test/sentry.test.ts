import { provideSentry } from "../src/index.ts";
import { error, failure } from "@openknot-ts/behavior";
import { listener } from "@openknot-ts/flow";
import type { InputInvoker } from "@openknot-ts/flow";
import type {} from "@openknot-ts/flow/wire";
import { composeModule, config, defineApplication, plug, runApplication } from "@openknot-ts/wire";
import * as Sentry from "@sentry/bun";
import type { ErrorEvent } from "@sentry/bun";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { z } from "zod";

const PaymentDeclined = error("PaymentDeclined");
const OutOfStock = error("OutOfStock");
const settings = config({ SENTRY_DSN: z.string(), SENTRY_REPORT_DECLINED: z.enum(["true", "false"]) });
const dsn = "https://public@o0.ingest.sentry.io/0";

const checkout = listener<"crash" | "declined" | "out-of-stock">()({
  requirements: {},
  run: async (input) => {
    if (input === "crash") {
      throw new Error("disk full");
    }
    return failure(input === "declined" ? PaymentDeclined() : OutOfStock());
  },
});

// The real SDK keeps each event in beforeSend instead of sending it.
function recording() {
  const events: ErrorEvent[] = [];
  return {
    events,
    beforeSend(event: ErrorEvent) {
      events.push(event);
      return null;
    },
  };
}

async function start(sentry: ReturnType<typeof provideSentry>, env?: Readonly<Record<string, string>>) {
  let invoke: InputInvoker<typeof checkout> | undefined;
  const source = plug({
    port: checkout,
    requirements: {},
    bind: (ctx) => {
      invoke = ctx.invoke;
      return { release() {} };
    },
  });
  const app = await runApplication(
    defineApplication({
      modules: [composeModule({ providers: env === undefined ? { source } : { source, settings } }), sentry],
    }),
    env === undefined ? {} : { env },
  );
  assert.ok(invoke);
  return { app, invoke };
}

test("the module initializes Sentry from its requirements, reports through it and closes it at shutdown", async () => {
  const { events, beforeSend } = recording();
  const { app, invoke } = await start(
    provideSentry({
      requirements: { settings },
      options: ({ settings }) => ({ dsn: settings.SENTRY_DSN, defaultIntegrations: false, beforeSend }),
      errors: ({ settings }) => (settings.SENTRY_REPORT_DECLINED === "true" ? [PaymentDeclined] : []),
    }),
    { SENTRY_DSN: dsn, SENTRY_REPORT_DECLINED: "true" },
  );
  try {
    assert.equal(Sentry.isEnabled(), true);
    for (const input of ["crash", "declined", "out-of-stock"] as const) {
      await assert.rejects(invoke({ input, trigger: { messageId: `message-${input}` } }));
    }
  } finally {
    await app.stop();
  }
  assert.equal(Sentry.isInitialized(), false);
  assert.deepEqual(
    events.map((event) => [
      event.exception?.values?.[0]?.type,
      event.tags?.["openknot.source"],
      event.exception?.values?.[0]?.mechanism?.handled,
      event.contexts?.["openknot"]?.["messaging.message.id"],
      Object.keys(event.tags ?? {}),
    ]),
    [
      ["InternalFlowError", "openknot.listener", false, "message-crash", ["openknot.source"]],
      ["PaymentDeclined", "openknot.listener", true, "message-declined", ["openknot.source"]],
    ],
  );
});

test("one application owns the process's Sentry client: a second owner fails startup and the first keeps reporting", async () => {
  const { events, beforeSend } = recording();
  const owner = provideSentry({ options: () => ({ dsn, defaultIntegrations: false, beforeSend }) });
  const first = await start(owner);
  try {
    await assert.rejects(start(owner), /Sentry is already initialized/);
    await assert.rejects(first.invoke({ input: "crash" }));
  } finally {
    await first.app.stop();
  }
  assert.deepEqual(
    events.map((event) => event.exception?.values?.[0]?.type),
    ["InternalFlowError"],
  );
  // Its shutdown released the process's client, so a later application can own Sentry again.
  const next = await start(owner);
  await next.app.stop();
});

test("a client that replaced the module's own stays open when the module closes at shutdown", async () => {
  const { app } = await start(provideSentry({ options: () => ({ dsn, defaultIntegrations: false }) }));
  Sentry.init({ dsn, defaultIntegrations: false });
  const replacement = Sentry.getClient();
  try {
    await app.stop();
    assert.equal(Sentry.getClient(), replacement);
    assert.equal(Sentry.isEnabled(), true);
  } finally {
    await Sentry.close();
  }
});
