import { snapshotRequirements } from "../../definitions.ts";
import { guardedReferences } from "../../guard.ts";
import type { RuntimeOutputBinding } from "../../output.ts";
import { bindingReference, isOutputPort, normalizeOutputPorts, resolveOutputBinding } from "../../output.ts";
import { isPublisher, isPublisherBinding, resolvePublisher } from "../../publisher.ts";
import type { SubscriptionDefinition } from "../../subscription.ts";
import { isSubscription, isSubscriptionBinding } from "../../subscription.ts";
import { isUnitOfWork, isUnitOfWorkBinding } from "../../unit-of-work.ts";
import { isWriter, isWriterBinding, isWriterComposition } from "../../writer.ts";
import type { ExecutionEnvironment } from "../execution-runtime.ts";
import { publication, scopedPublication } from "../publication.ts";
import { markRecorded } from "../recorded-write.ts";
import type { SubscriptionImplementation } from "../subscription-execution.ts";
import { createSubscriptionPort } from "../subscription-execution.ts";
import type { UnitOfWorkExecutor } from "../uow-runtime.ts";
import type { AdapterRuntime, FamilyAdapter } from "./shared.ts";
import { lifetime, requireContext } from "./shared.ts";
import { hookRequirements, resolvedUnitOfWork } from "./unit-of-work.ts";
import { isReader, isReaderBinding, isReaderComposition } from "@openknot-ts/behavior";
import { errorReports } from "@openknot-ts/error-reporting/wire";
import type { Definition, DefinitionAdapterContext } from "@openknot-ts/wire";
import { isPlug, unit } from "@openknot-ts/wire";
import { BindPort } from "@openknot-ts/wire/internal/marker";
import { bindPorts } from "@openknot-ts/wire/internal/plug-bindings";

/** Writers, publishers, topics/broadcasts and the output plugs that bind them. */
export function createOutputAdapter(runtime: AdapterRuntime): FamilyAdapter {
  const { carrier, environment } = runtime;
  /** Singleton admission and publication; the native binding is resolved in each short scope. */
  function subscriptionPort(
    port: SubscriptionDefinition,
    context: DefinitionAdapterContext,
    native: SubscriptionImplementation,
  ) {
    return unit({
      requirements: { carrier, report: errorReports },
      factory: ({ carrier, report }) =>
        publication(createSubscriptionPort(port, runtime.host(context, carrier, report), native), carrier, port),
    });
  }
  return (definition, context) => {
    if (isPublisher(definition)) {
      return { reference: definition, provider: unit.contract({ lifetime }) };
    }
    // A subscription port admits and publishes in scopes of its own: its guards are admission dependencies.
    if (isSubscription(definition)) {
      return {
        reference: definition,
        references: [...guardedReferences(definition), environment] as readonly Definition[],
        opensScope: true,
        provider: unit.contract(),
      };
    }
    if (isWriter(definition)) {
      return { reference: definition, provider: unit.contract({ lifetime }) };
    }
    if (
      isPlug(definition) &&
      isOutputPort(definition.port) &&
      !isReader(definition.port) &&
      !isReaderComposition(definition.port)
    ) {
      snapshotRequirements(definition.requirements);
      const port = definition.port;
      const members = normalizeOutputPorts(port);
      if (Object.keys(definition.options).length > 0) {
        throw new TypeError("Unknown plug option");
      }
      return {
        reference: definition,
        // A publication executes the plug in its own scope, with the environment; the port's guards belong to
        // admission, which the provided port declares.
        references: members.flatMap((member) =>
          isSubscription(member) ? [environment] : isUnitOfWork(member) ? Object.values(member.hooks).flat() : [],
        ) as readonly Definition[],
        // A binding is built from its requirements alone: it is scoped only when one of them is.
        pure: true,
        provider: unit({
          lifetime,
          requirements: {
            ...definition.requirements,
            ...(members.some(isWriter) ? { __carrier: carrier } : {}),
          } as Readonly<Record<string, Definition>>,
          factory: ({ __carrier, ...dependencies }) => {
            const bindings = bindPorts(
              definition,
              dependencies,
              (binding): binding is RuntimeOutputBinding =>
                isReaderBinding(binding) ||
                isWriterBinding(binding) ||
                isPublisherBinding(binding) ||
                isSubscriptionBinding(binding) ||
                isUnitOfWorkBinding(binding),
              bindingReference,
              isWriterComposition(port) ? port.members : undefined,
            );
            const recorded = (binding: unknown) => {
              if (!isWriterBinding(binding)) {
                return binding;
              }
              return binding.writer[BindPort](
                markRecorded((...args: never[]) =>
                  (__carrier as UnitOfWorkExecutor).write(() => binding.implementation(...args), args, binding.writer),
                ),
              );
            };
            if (!isWriterComposition(port)) {
              return recorded(bindings);
            }
            return Object.freeze(
              Object.fromEntries(Object.entries(bindings).map(([key, binding]) => [key, recorded(binding)])),
            );
          },
        }),
        provides: (isWriterComposition(port) ? Object.entries(port.members) : ([[undefined, port]] as const)).map(
          ([name, member]) => {
            if (isSubscription(member)) {
              return {
                reference: member,
                // Admission resolves the plug's binding with the port's guards; a publication opens its scope for
                // the plug alone, so it acquires only what delivery needs.
                references: [definition, ...guardedReferences(member), environment] as readonly Definition[],
                opensScope: true,
                provider: subscriptionPort(member, requireContext(context), {
                  root: definition,
                  resolve: (scope) => {
                    const binding = scope.resolve(definition);
                    if (!isSubscriptionBinding(binding)) {
                      throw new Error("Output plug did not provide the required subscription binding");
                    }
                    return binding.implementation;
                  },
                }),
              };
            }
            return {
              reference: member,
              pure: true,
              provider: unit({
                lifetime,
                requirements: {
                  outputAdapter: definition,
                  ...(isUnitOfWork(member) ? hookRequirements(member) : {}),
                  ...(isPublisher(member) ? { __environment: environment } : {}),
                },
                factory: (values) => {
                  const bindings = values.outputAdapter;
                  const binding = (
                    name === undefined ? bindings : (bindings as Readonly<Record<string, unknown>>)[name]
                  ) as RuntimeOutputBinding | undefined;
                  if (binding === undefined || isSubscriptionBinding(binding)) {
                    throw new Error("Output plug did not provide the required binding");
                  }
                  if (isUnitOfWorkBinding(binding)) {
                    return resolvedUnitOfWork(binding.unitOfWork, binding.implementation, values);
                  }
                  if (isPublisherBinding(binding)) {
                    return scopedPublication(
                      resolvePublisher(binding),
                      values.__environment as ExecutionEnvironment,
                      binding.publisher,
                    );
                  }
                  return resolveOutputBinding(binding);
                },
              }),
            };
          },
        ),
      };
    }
    return undefined;
  };
}
