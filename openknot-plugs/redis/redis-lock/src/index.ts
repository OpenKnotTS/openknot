import type { Lease, Lock, LockResult } from "@openknot-ts/lock";
import { requireLease } from "@openknot-ts/lock";
import { randomUUID } from "node:crypto";
import type { RedisClientType } from "redis";

export type LockCommands = {
  sendCommand(...args: Parameters<RedisClientType["sendCommand"]>): ReturnType<RedisClientType["sendCommand"]>;
};

const release = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0";

export function redisLockOf(commands: LockCommands, options: { readonly prefix?: string } = {}): Lock {
  const key = (name: string) => `${options.prefix ?? "openknot:lock"}:${name}`;

  return Object.freeze({
    async tryRun<T>(
      name: string,
      { leaseMs }: { readonly leaseMs: number },
      work: (lease: Lease) => Promise<T>,
    ): Promise<LockResult<T>> {
      requireLease(leaseMs);

      const token = randomUUID();

      // The native PX expiry bounds a crashed holder; no application timer renews or polls the lease.
      const acquired = await commands.sendCommand(["SET", key(name), token, "NX", "PX", String(leaseMs)]);

      if (acquired !== "OK") {
        return { acquired: false };
      }

      let workResult: { readonly value: T } | { readonly error: unknown };

      try {
        workResult = { value: await work({ token }) };
      } catch (error) {
        workResult = { error };
      }

      try {
        await commands.sendCommand(["EVAL", release, "1", key(name), token]);
      } catch (releaseError) {
        if ("error" in workResult) {
          throw new AggregateError([workResult.error, releaseError], "Lock work and its release failed");
        }

        throw releaseError;
      }

      if ("error" in workResult) {
        throw workResult.error;
      }

      return { acquired: true, value: workResult.value };
    },
  });
}
