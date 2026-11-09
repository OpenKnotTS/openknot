import type { Attempt, Delivery } from "./outbox-application.ts";
import { outboxApplication, placeOrder, recorder } from "./outbox-application.ts";
import { httpServer } from "@openknot-ts/knot-http-node";

// The process the crash scenario kills: started with E2E_RUN, a schema and an order id, it places that order, reports
// once the outbox is sending its event, holds the send and waits to be killed.
const [schema, id] = process.argv.slice(2);
const attempts = recorder<Attempt>();
const app = await outboxApplication({
  schema: schema!,
  attempts,
  deliveries: recorder<Delivery>(),
  hold: true,
  leaseMs: 1_500,
});
await placeOrder(app.resolve(httpServer).url, id!);
await attempts.until((items) => items.some((attempt) => attempt.outcome === "held"), AbortSignal.timeout(20_000));
process.stdout.write("held\n");
await app.stopped;
