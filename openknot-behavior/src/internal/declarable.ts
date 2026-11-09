/**
 * The one runtime behind a primitive's two forms: `x(options)` with nothing to declare, and `x<Types>()(options)`.
 * The empty call only carries the declared types, because TypeScript infers nothing else once a call lists any.
 */
export function declarable<Constructor extends (...args: never[]) => unknown>(
  create: (options: never) => unknown,
): Constructor {
  return ((...args: [] | [never]) => (args.length === 0 ? create : create(args[0]))) as Constructor;
}
