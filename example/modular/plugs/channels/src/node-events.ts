import type { RoleEvent, LogEvent } from "@modular/behavior/events";
import { roleChangedListener } from "@modular/flow/listeners";
import { rolePublisher, logPublisher } from "@modular/flow/ports";
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

// The publisher does not wait for consumers. Flow logs every failure of the listener, including a delivery it does
// not admit, and the in-process bus has no redelivery, so a delivery is not awaited here.
export const roleEvents = plug({
  port: roleChangedListener,
  requirements: { eventBus },
  bind: ({ eventBus, invoke }) => {
    const receive = (input: RoleEvent, propagation?: PropagationCarrier) => {
      void invoke({ input, propagation });
    };

    eventBus.on("roleChanged", receive);

    return {
      release() {
        eventBus.off("roleChanged", receive);
      },
    };
  },
});
