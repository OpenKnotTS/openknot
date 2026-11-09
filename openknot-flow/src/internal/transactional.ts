const marked = new WeakSet<object>();

/**
 * Marks a publisher implementation whose staged publications are sent at the end of beforeCommit, inside the
 * transaction, instead of after commit, as an outbox stores them with the change.
 */
export function transactional<T extends (...args: never[]) => unknown>(publish: T): T {
  if (typeof publish !== "function") {
    throw new TypeError("transactional() requires a publisher implementation");
  }
  marked.add(publish);
  return publish;
}

export function markTransactional(value: object): void {
  marked.add(value);
}

export function isTransactional(value: unknown): boolean {
  return typeof value === "object" || typeof value === "function" ? marked.has(value as object) : false;
}
