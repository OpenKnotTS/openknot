export interface Lease {
  /** Identifies this holder; stores that support fencing reject writes from an older token. */
  readonly token: string;
}

export type LockResult<T> = { readonly acquired: true; readonly value: T } | { readonly acquired: false };

export interface Lock {
  /** Runs `work` only when no other holder has the lock; never waits. The lease bounds a crashed holder. */
  tryRun<T>(
    name: string,
    options: { readonly leaseMs: number },
    work: (lease: Lease) => Promise<T>,
  ): Promise<LockResult<T>>;
}

export function requireLease(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new TypeError("A lock lease must be a positive integer");
  }
}
