import type { RoleEvent, LogEvent } from "../../app/behavior/events.ts";
import { roleChangedListener } from "../../app/flow/listeners.ts";
import { rolePublisher, logPublisher } from "../../app/flow/ports.ts";
import type { PropagationCarrier } from "@openknot-ts/tracing";
import { plug, unit } from "@openknot-ts/wire";
import { EventEmitter } from "node:events";

// An in-process bus: each message carries its event and serialized trace context, like a broker message.
type Events = {
  roleChanged: [RoleEvent, propagation?: PropagationCarrier | undefined];
  logCreated: [LogEvent, propagation?: PropagationCarrier | undefined];
};

export const eventBus = unit({ factory: () => new EventEmitter<Events>() });

export const rolePublishing = plug({
  port: rolePublisher,
  requirements: { eventBus },
  bind:
    ({ eventBus }) =>
    (event, { propagation }) => {
      eventBus.emit("roleChanged", event, propagation);
    },
});

export const logPublishing = plug({
  port: logPublisher,
  requirements: { eventBus },
  bind:
    ({ eventBus }) =>
    (event, { propagation }) => {
      eventBus.emit("logCreated", event, propagation);
    },
});

// The publisher does not wait for consumers; the listener reports its own failures.
export const roleEvents = plug({
  port: roleChangedListener,
  requirements: { eventBus },
  bind: ({ eventBus, invoke }) => {
    const receive = async (input: RoleEvent, propagation?: PropagationCarrier) => {
      try {
        await invoke({ input, propagation });
      } catch (error) {
        console.error("RoleChanged listener failed", error);
      }
    };

    eventBus.on("roleChanged", receive);

    return {
      release() {
        eventBus.off("roleChanged", receive);
      },
    };
  },
});
