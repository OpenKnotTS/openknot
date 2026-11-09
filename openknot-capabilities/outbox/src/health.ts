import { outboxStore } from "./index.ts";
import { healthCheck } from "@openknot-ts/health";

export interface OutboxHealthOptions {
  /** The check's name. Defaults to `outbox`. */
  readonly name?: string;
  /** The outbox name whose records count, as given to `outbox({ name })`; every outbox in the store by default. */
  readonly outbox?: string;
  /** Failed sends after which a record counts as stuck. Defaults to 5. */
  readonly attempts?: number;
  readonly timeoutMs?: number;
}

/** Reports down while a record is stuck: its sends keep failing and it holds back the later records of its name. */
export function outboxHealth(options: OutboxHealthOptions = {}) {
  const { name = "outbox", outbox, attempts = 5, timeoutMs } = options;
  return healthCheck({
    name,
    requirements: { store: outboxStore },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    check: async ({ store }) => ((await store.stuck(attempts, outbox)).length === 0 ? "up" : "down"),
  });
}
