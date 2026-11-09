export const DefinitionIntegrationMarker = Symbol.for("@openknot-ts/wire/definition-integration");

/** How a plug binds a port: a port keeps its implementation in a binding, which only its integration interprets. */
export const BindPort = Symbol.for("@openknot-ts/wire/bind-port");

/** Whether a value carries a definition marker; markers are registered symbols, shared by copies of a package. */
export function hasMarker(value: unknown, marker: symbol): value is object {
  return typeof value === "object" && value !== null && Reflect.get(value, marker) === true;
}
