import { GroupMarker } from "@openknot-ts/wire/internal/marker";

/** Shared grouping metadata; members keep their own contracts and identities. */
export type Composition<
  Marker extends symbol,
  Kind extends string,
  Members extends Readonly<Record<string, unknown>>,
> = Readonly<Record<Marker, true>> & {
  readonly [GroupMarker]: true;
  readonly kind: Kind;
  readonly members: Readonly<Members>;
};

/**
 * Add homogeneous composition to a primitive's factory without wrapping its
 * call signature. In particular, generic factories keep their type inference.
 * This module loads only Wire's marker helpers and is shared across framework layers.
 */
export function composable<
  Member,
  Factory extends (...args: never[]) => unknown,
  const Marker extends symbol,
  const Kind extends string,
>(
  factory: Factory,
  options: {
    readonly name: string;
    readonly memberName: string;
    readonly marker: Marker;
    readonly kind: Kind;
    readonly isMember: (value: unknown) => value is Member;
    readonly metadata?: (members: readonly Member[]) => object;
  },
): NoInfer<
  Factory & {
    readonly compose: <const Members extends Readonly<Record<string, Member>>>(
      members: Members,
    ) => Composition<Marker, Kind, Members>;
  }
> {
  const { name, memberName, marker, kind, isMember, metadata } = options;
  const invalidMembers = `${name}.compose() requires a non-empty named object of ${memberName}s.`;

  function compose<const Members extends Readonly<Record<string, Member>>>(
    members: Members,
  ): Composition<Marker, Kind, Members> {
    if (typeof members !== "object" || members === null || Array.isArray(members)) {
      throw new TypeError(invalidMembers);
    }

    const snapshot = { ...members };
    const values = Object.values(snapshot);

    if (values.length === 0 || Object.getOwnPropertySymbols(snapshot).length > 0 || !values.every(isMember)) {
      throw new TypeError(invalidMembers);
    }

    if (new Set(values).size !== values.length) {
      throw new TypeError(`Duplicate ${memberName} in ${name}.compose().`);
    }

    // TypeScript cannot track the generic computed symbol marker.
    const frozen = Object.freeze(snapshot);

    return Object.freeze({
      ...metadata?.(values),
      // An application that lists the composition lists its members.
      [GroupMarker]: true as const,
      [marker]: true as const,
      kind,
      members: frozen,
    }) as Composition<Marker, Kind, Members>;
  }

  return Object.assign(factory, { compose });
}
