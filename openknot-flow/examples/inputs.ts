import type { Event } from "@openknot-ts/behavior";
import { success } from "@openknot-ts/behavior";
import type { InputInvoker, Schedule, Timestamp } from "@openknot-ts/flow";
import { intervalMilliseconds, listener, scheduler } from "@openknot-ts/flow";
import { provideFlow } from "@openknot-ts/flow/wire";
import { plug, runApplication, defineApplication, composeModule, unit } from "@openknot-ts/wire";

// Example infrastructure. Production drivers can use a cron engine or a broker.
const timerEngine = unit({
  factory: () => ({
    register(options: {
      readonly schedule: Schedule;
      readonly signal: AbortSignal;
      readonly onTick: (scheduledAt: Timestamp) => Promise<unknown>;
    }) {
      if (options.schedule.every === undefined) {
        throw new Error("This example driver supports intervals only");
      }

      const period = intervalMilliseconds(options.schedule.every);
      let next = Date.now() + period;

      const timer = setInterval(() => {
        if (options.signal.aborted) {
          return;
        }

        const scheduledAt = next;
        next += period;
        void options.onTick(scheduledAt).catch(console.error);
      }, period);

      return {
        stop() {
          clearInterval(timer);
        },
      };
    },
  }),
});

// A scheduler and the plug that drives it
let executions = 0;
const finished = Promise.withResolvers<void>();

const refresh = scheduler({
  schedule: { every: { milliseconds: 20 } },
  run: (_input, ctx) => {
    console.log("scheduler", ctx.trigger);
    executions++;

    if (executions === 3) {
      finished.resolve();
    }

    return success(executions);
  },
});

const refreshTimer = plug({
  port: refresh,
  requirements: { timerEngine },
  bind: ({ timerEngine, port, invoke, signal }) => {
    const registration = timerEngine.register({
      schedule: port.schedule,
      signal,
      onTick: (scheduledAt) => invoke({ trigger: { scheduledAt } }),
    });

    return { release: () => registration.stop() };
  },
});

// A listener and the plug that delivers to it
type RoleEvent = Event & { readonly type: "RoleRenamed"; readonly roleId: string };

const onRoleChanged = listener<RoleEvent>()({
  run: (event, ctx) => {
    console.log("listener", event, ctx.trigger);
    return success();
  },
});

let deliver: InputInvoker<typeof onRoleChanged> | undefined;

const roleMessages = plug({
  port: onRoleChanged,
  bind: ({ invoke }) => {
    // An actual consumer forwards decoded payloads and delivery metadata here.
    deliver = invoke;

    return {
      release() {
        deliver = undefined;
      },
    };
  },
});

const app = await runApplication(
  defineApplication({
    modules: [provideFlow([refresh, onRoleChanged]), composeModule({ providers: { refreshTimer, roleMessages } })],
  }),
);

try {
  await deliver?.({ input: { type: "RoleRenamed", roleId: "r1" }, trigger: { messageId: "m1", attempt: 1 } });
  await finished.promise;
} finally {
  await app.stop();
}
