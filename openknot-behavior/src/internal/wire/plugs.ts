import { isReader, isReaderBinding, isReaderComposition } from "../../reader.ts";
import type { ReaderDefinition } from "../../reader.ts";
import type { AdaptedDefinition, PlugDefinition, Requirements } from "@openknot-ts/wire";
import { unit } from "@openknot-ts/wire";
import { bindPorts } from "@openknot-ts/wire/internal/plug-bindings";

/** Reader-only plugs stay usable with Behavior and Wire, independently of Flow. */
export function adaptReaderPlug(definition: PlugDefinition): AdaptedDefinition | undefined {
  const port = definition.port;

  if (!isReader(port) && !isReaderComposition(port)) {
    return undefined;
  }

  if (Object.keys(definition.options).length > 0) {
    throw new TypeError("Unknown reader plug option");
  }

  const members: readonly (readonly [string | undefined, ReaderDefinition])[] = isReaderComposition(port)
    ? Object.entries(port.members)
    : [[undefined, port]];

  // A binding is built from its requirements alone: it is scoped only when one of them is.
  return {
    reference: definition,
    pure: true,
    provider: unit({
      lifetime: "scoped",
      requirements: definition.requirements,
      factory: (dependencies) =>
        bindPorts(
          definition,
          dependencies,
          isReaderBinding,
          (binding) => binding.reader,
          isReaderComposition(port) ? port.members : undefined,
        ),
    }),
    provides: members.map(([name, member]) => ({
      reference: member,
      pure: true,
      provider: unit({
        lifetime: "scoped",
        requirements: { output: definition } satisfies Requirements,
        factory: ({ output }) => {
          const binding = name === undefined ? output : (output as Readonly<Record<string, unknown>>)[name];
          if (!isReaderBinding(binding)) {
            throw new TypeError("Output plug is missing a reader binding");
          }
          return binding.implementation;
        },
      }),
    })),
  };
}
