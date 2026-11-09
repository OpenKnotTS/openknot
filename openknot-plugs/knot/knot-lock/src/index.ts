import type { Lease, Lock, LockResult } from "@openknot-ts/lock";
import { requireLease } from "@openknot-ts/lock";
import { randomUUID } from "node:crypto";

/** Expiry is checked when the lock is requested, so no timer runs. */
export function knotLock(options: { readonly now?: () => number } = {}): Lock {
  const now = options.now ?? Date.now;
  const holders = new Map<string, { readonly token: string; readonly expires: number }>();
  return Object.freeze({
    async tryRun<T>(
      name: string,
      { leaseMs }: { readonly leaseMs: number },
      work: (lease: Lease) => Promise<T>,
    ): Promise<LockResult<T>> {
      requireLease(leaseMs);
      const current = holders.get(name);
      if (current !== undefined && current.expires > now()) {
        return { acquired: false };
      }
      const token = randomUUID();
      holders.set(name, { token, expires: now() + leaseMs });
      try {
        return { acquired: true, value: await work({ token }) };
      } finally {
        if (holders.get(name)?.token === token) {
          holders.delete(name);
        }
      }
    },
  });
}
