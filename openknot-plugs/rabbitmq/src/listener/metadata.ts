import type { RabbitDelivery } from "./native.ts";
import type { ListenerTrigger } from "@openknot-ts/flow";
import type { PropagationCarrier } from "@openknot-ts/tracing";

/** The configured propagator owns interpretation; AMQP carries ordinary string fields. */
export function deliveryPropagation(
  message: RabbitDelivery,
  fields: readonly string[],
): PropagationCarrier | undefined {
  const headers = message.headers ?? {};
  const entries = fields.flatMap((field) => {
    const key = Object.keys(headers).find((key) => key.toLowerCase() === field.toLowerCase());
    const value = key === undefined ? undefined : headers[key];
    return typeof value === "string" ? [[field, value]] : [];
  });
  return entries.length === 0 ? undefined : Object.freeze(Object.fromEntries(entries));
}

export function deliveryTrigger(message: RabbitDelivery): ListenerTrigger {
  // RabbitMQ 4.3+ separates acquisitions from failed deliveries; both start at zero.
  const count = message.headers?.["x-acquired-count"] ?? message.headers?.["x-delivery-count"];
  return {
    ...(typeof message.messageId === "string" ? { messageId: message.messageId } : {}),
    ...(typeof count === "number" && Number.isSafeInteger(count) && count >= 0 && count < Number.MAX_SAFE_INTEGER
      ? { attempt: count + 1 }
      : {}),
  };
}
