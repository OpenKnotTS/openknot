import type { PlugDefinition } from "../plug.ts";
import { BindPort } from "./marker.ts";
import { discardedThenable } from "./synchronous.ts";

/** Binds one port through its own `BindPort`, and checks the binding belongs to that port. */
function bindPort<Binding>(
  port: object,
  implementation: unknown,
  isBinding: (value: unknown) => value is Binding,
  reference: (binding: Binding) => object,
): Binding {
  const bind: unknown = Reflect.get(port, BindPort);

  if (typeof bind !== "function") {
    throw new TypeError("An output plug's port must be a bindable contract.");
  }

  const binding: unknown = Reflect.apply(bind, port, [implementation]);

  if (!isBinding(binding) || reference(binding) !== port) {
    throw new TypeError("An output port returned an unrelated binding.");
  }

  return binding;
}

/**
 * Common binding construction and coverage checks: bind() returns the implementation of its port, or a named
 * object with one implementation per composition member, and each is bound through its port's own `BindPort`.
 * Integrations interpret their own bindings.
 */
export function bindPorts<Binding>(
  definition: Pick<PlugDefinition, "port" | "bind">,
  dependencies: object,
  isBinding: (value: unknown) => value is Binding,
  reference: (binding: Binding) => object,
  members?: Readonly<Record<string, object>>,
): Binding | Readonly<Record<string, Binding>> {
  const result = definition.bind(Object.freeze({ ...dependencies }) as never);

  if (discardedThenable(result)) {
    throw new TypeError("Output plug bind() must be synchronous; use resources for asynchronous initialization.");
  }

  if (members === undefined) {
    return bindPort(definition.port, result, isBinding, reference);
  }

  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new TypeError("A composed output plug must return a named object with one implementation per member.");
  }

  const implementations = result as Readonly<Record<string, unknown>>;
  const names = Object.keys(implementations);

  if (Object.getOwnPropertySymbols(implementations).length > 0 || names.some((name) => !Object.hasOwn(members, name))) {
    throw new TypeError("Composed output plug returned an implementation for an undeclared member.");
  }

  if (names.length !== Object.keys(members).length) {
    throw new TypeError("Composed output plug is missing an implementation for a declared member.");
  }

  return Object.freeze(
    Object.fromEntries(
      Object.entries(members).map(([name, port]) => [
        name,
        bindPort(port, implementations[name], isBinding, reference),
      ]),
    ),
  );
}
