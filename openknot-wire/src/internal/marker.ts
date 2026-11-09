export const DefinitionIntegrationMarker = Symbol.for("@openknot-ts/wire/definition-integration");

/** How a plug binds a port: a port keeps its implementation in a binding, which only its integration interprets. */
export const BindPort = Symbol.for("@openknot-ts/wire/bind-port");

/**
 * A named group of definitions, such as a port composition: an application that lists it lists its `members`.
 * Layers mark their compositions with it, so Wire expands them without knowing the layer.
 */
export const GroupMarker = Symbol.for("@openknot-ts/wire/group");

/**
 * An input port, such as an exposure or a listener: the only definitions an application lists as its inputs.
 * Layers mark their input ports with it, so Wire checks them without knowing the layer.
 */
export const InputMarker = Symbol.for("@openknot-ts/wire/input");

/** Whether a value carries a definition marker; markers are registered symbols, shared by copies of a package. */
export function hasMarker(value: unknown, marker: symbol): value is object {
  return typeof value === "object" && value !== null && Reflect.get(value, marker) === true;
}
