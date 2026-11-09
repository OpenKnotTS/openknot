export type NoRequirements = Readonly<Record<never, never>>;

/** Shared declaration shape; nonempty explicitly selected maps must be supplied. */
export type RequirementsOptions<R extends object = NoRequirements> = {
  readonly requirements?: R;
} & (keyof R extends never ? unknown : { readonly requirements: R });

export type RequirementReferences = Readonly<Record<string, object>>;

interface RequirementPolicy {
  readonly accepts?: (reference: object) => boolean;
  readonly reserved?: ReadonlySet<string>;
  readonly invalidMessage?: (name: string) => string;
}

/** Snapshot once so execution and integration discovery follow identical references. */
export function snapshotRequirements<const R extends RequirementReferences = NoRequirements>(
  requirements: R | undefined,
  policy: RequirementPolicy = {},
): R {
  if (
    requirements !== undefined &&
    (typeof requirements !== "object" || requirements === null || Array.isArray(requirements))
  ) {
    throw new TypeError("Requirements must be a named object of dependency references.");
  }

  const snapshot = Object.freeze({ ...requirements }) as R;

  for (const [name, reference] of Object.entries(snapshot)) {
    // Requirement names become properties of the object a factory or an execution receives.
    if (name === "__proto__" || policy.reserved?.has(name)) {
      throw new TypeError(`Reserved requirement name: ${name}`);
    }

    if (
      ((typeof reference !== "object" || reference === null) && typeof reference !== "function") ||
      (policy.accepts !== undefined && !policy.accepts(reference))
    ) {
      throw new TypeError(policy.invalidMessage?.(name) ?? `Invalid dependency reference: ${name}`);
    }
  }

  return snapshot;
}
