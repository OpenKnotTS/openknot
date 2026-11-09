import type { InputPortDefinition } from "./definitions.ts";
import { isInputPort } from "./definitions.ts";
import type { ExposureComposition } from "./exposure.ts";
import { isExposureComposition } from "./exposure.ts";
import type { PublisherDefinition } from "./publisher.ts";
import { isPublisher } from "./publisher.ts";
import type { SubscriptionDefinition } from "./subscription.ts";
import { isSubscription } from "./subscription.ts";
import type { WriterDefinition, WriterComposition } from "./writer.ts";
import { isWriter, isWriterComposition } from "./writer.ts";
import type { ReaderDefinition, ReaderComposition } from "@openknot-ts/behavior";
import { isReader, isReaderComposition } from "@openknot-ts/behavior";
import type {
  CheckedSources,
  CompositionSource,
  DeferredModule,
  Definition,
  Provider,
  SourceModule,
} from "@openknot-ts/wire";
import { composeModule, isProvider } from "@openknot-ts/wire";

export type FlowPort =
  | InputPortDefinition
  | SubscriptionDefinition
  | PublisherDefinition
  | ReaderDefinition
  | WriterDefinition;

type FlowEntry =
  | FlowPort
  | ReaderComposition
  | WriterComposition
  | ExposureComposition
  | Provider<unknown, never, "unit">;

export type FlowSource = CompositionSource<FlowEntry>;

/** A flow package's module, passed to defineApplication({ modules }). */
export type ProvidedFlow<N = any, G = any> = DeferredModule<N, G>;

function isEntry(value: unknown): value is FlowEntry {
  return (
    isInputPort(value) ||
    isSubscription(value) ||
    isPublisher(value) ||
    isReader(value) ||
    isWriter(value) ||
    isReaderComposition(value) ||
    isWriterComposition(value) ||
    isExposureComposition(value) ||
    (isProvider(value) && value.kind === "unit")
  );
}

function portMembers(port: FlowEntry): readonly Definition[] {
  return isReaderComposition(port) || isWriterComposition(port) || isExposureComposition(port)
    ? (Object.values(port.members) as readonly Definition[])
    : [port];
}

/** A package provides ports and native units; handlers and policies stay in requirements. */
export function provideFlow<const Sources extends readonly unknown[]>(
  sources: Sources & CheckedSources<Sources, FlowSource>,
): SourceModule<Sources> {
  return composeModule({
    sources: sources as readonly FlowSource[],
    accepts: isEntry,
    label: "provideFlow()",
    members: portMembers,
  }) as SourceModule<Sources>;
}
