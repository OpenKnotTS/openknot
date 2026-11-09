import type { InputInvoker, Timestamp } from "../src/index.ts";
import { listener, scheduler } from "../src/index.ts";
import { success } from "@openknot-ts/behavior";
import type { PlugHandle } from "@openknot-ts/wire";
import { plug, resource, unit } from "@openknot-ts/wire";
import "../src/wire.ts";

const dependency = unit({ factory: () => ({ name: "value" }), lifetime: "scoped" });
const database = resource({
  async initialize() {
    return { value: 42, release() {} };
  },
});
const received = listener<{ readonly id: number }>()({
  requirements: { dependency },
  run: (input, ctx) => {
    const name: string = ctx.dependency.name;
    const attempt: number | undefined = ctx.trigger.attempt;
    // @ts-expect-error Only declared requirements exist.
    void ctx.other;
    // @ts-expect-error Listener metadata does not include scheduler timestamps.
    void ctx.trigger.scheduledAt;
    void attempt;
    return success({ id: input.id, name });
  },
});
const tick = scheduler({
  schedule: { every: { seconds: 5 } },
  requirements: {},
  run: (_input, ctx) => {
    const at: Timestamp = ctx.trigger.scheduledAt;
    return success(at);
  },
});
plug({
  port: received,
  requirements: { database },
  bind: async (ctx) => {
    const value: number = ctx.database;
    const result: { id: number; name: string } = await ctx.invoke({ input: { id: value } });
    // @ts-expect-error Input is checked against the listener definition.
    await ctx.invoke({ input: { id: "invalid" } });
    // @ts-expect-error A listener has no schedule.
    void ctx.port.schedule;
    void result;
    return { release() {} };
  },
});
plug({
  port: tick,
  requirements: {},
  bind: ({ port, invoke }) => {
    void port.schedule;
    void invoke({ trigger: { scheduledAt: Date.now() } });
    // @ts-expect-error Scheduler invocations require a scheduled timestamp.
    void invoke({});
    return { release: () => Promise.resolve() };
  },
});
// @ts-expect-error A named release handle is required.
plug({ port: received, requirements: {}, bind: () => () => undefined });
// @ts-expect-error Internal listeners do not accept guards.
listener({ requirements: {}, guards: {}, run: () => success() });
// @ts-expect-error Schedulers do not accept guards.
scheduler({ schedule: { every: { seconds: 5 } }, requirements: {}, guards: {}, run: () => success() });
scheduler({
  // @ts-expect-error Every and cron cannot be combined.
  schedule: { every: { seconds: 5 }, cron: "* * * * *", timeZone: "UTC" },
  requirements: {},
  run: () => success(),
});
// @ts-expect-error A cron schedule requires an explicit timezone.
scheduler({ schedule: { cron: "* * * * *" }, requirements: {}, run: () => success() });
// @ts-expect-error At least one duration unit is required.
scheduler({ schedule: { every: {} }, requirements: {}, run: () => success() });
const handle: PlugHandle = { release() {} };
declare const invoke: InputInvoker<typeof received>;
const result: Promise<{ id: number; name: string }> = invoke({ input: { id: 1 } });
void handle;
void result;
