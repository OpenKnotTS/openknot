import type { ReaderDefinition, ReaderFunction } from "@openknot-ts/behavior";
import type { EntityKey } from "@openknot-ts/flow/wire";
import type {
  AdaptedDefinition,
  DefinitionAdapter,
  DefinitionAdapterContext,
  PlugDefinition,
  Requirements,
  ResolvedReferences,
} from "@openknot-ts/wire";
import { isPlug, plug, resource } from "@openknot-ts/wire";
import { DefinitionIntegrationMarker, hasMarker } from "@openknot-ts/wire/internal/marker";
import { AsyncLocalStorage } from "node:async_hooks";

export type LayerStop = () => PromiseLike<void> | void;

/** A map key for an entity id that keeps ids of different types apart, such as `1` and `"1"`. */
export const keyOf = (id: EntityKey) => `${typeof id}\u0000${String(id)}`;

export function isAsyncIterable(value: unknown): value is AsyncIterable<readonly unknown[]> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

/**
 * Waits on a store whose native client may hold a call until it reconnects. `until(work, lostNow)` settles with the
 * work, or with `lost` at once when the store is lost already and otherwise when `release()` ends every wait.
 */
export function storeWaits<L>(lost: L) {
  const waiting = new Set<() => void>();
  return {
    until<T>(work: Promise<T>, lostNow: boolean): Promise<T | L> {
      return new Promise<T | L>((resolve, reject) => {
        const giveUp = () => resolve(lost);
        if (lostNow) {
          giveUp();
        } else {
          waiting.add(giveUp);
        }
        work.then(
          (value) => {
            waiting.delete(giveUp);
            resolve(value);
          },
          (error: unknown) => {
            waiting.delete(giveUp);
            reject(error);
          },
        );
      });
    },
    release(): void {
      for (const giveUp of waiting) {
        giveUp();
      }
      waiting.clear();
    },
  };
}

/** The layer whose startup is reading, so that it and the layers above it let the read through. */
const reading = new AsyncLocalStorage<object>();

/**
 * What a layer's decoration of a reader does: `answer` as usual, except during a startup read of this layer or of one
 * below it, which goes to `next`. Decorations wrap outside-in, so the layers below the reading one answer as usual.
 */
export function layered(layer: object, answer: ReaderFunction, next: ReaderFunction): ReaderFunction {
  return ((...args: never[]) => {
    const owner = reading.getStore();

    if (owner === undefined) {
      return (answer as (...args: never[]) => unknown)(...args);
    }

    const source = next as (...args: never[]) => unknown;
    return owner === layer ? reading.exit(() => source(...args)) : source(...args);
  }) as ReaderFunction;
}

const LayerStartupMarker = Symbol.for("@openknot-ts/cache/layer-startup");

interface LayerStartupPort {
  readonly [LayerStartupMarker]: true;
  readonly layer: object;
  readonly reads: readonly ReaderDefinition[];
}

type Start = (
  dependencies: ResolvedReferences<Requirements>,
  below: (reader: ReaderDefinition) => (...args: never[]) => Promise<unknown>,
) => PromiseLike<LayerStop | void> | LayerStop | void;

function adapt(definition: object, context?: DefinitionAdapterContext): AdaptedDefinition | undefined {
  if (!isPlug(definition) || !hasMarker(definition.port, LayerStartupMarker)) {
    return undefined;
  }

  if (context === undefined) {
    throw new TypeError("A layer's startup needs the application's scopes");
  }

  const { layer, reads } = definition.port as LayerStartupPort;
  const start = definition.bind as unknown as Start;

  return {
    reference: definition,
    references: reads,
    // It reads like a message consumer brings work in: after the other resources, and closed after what it serves.
    source: true,
    provider: resource({
      requirements: definition.requirements,
      initialize: async (dependencies, { signal }) => {
        const stopping = Promise.withResolvers<void>();
        const stop = await start(
          dependencies,
          (reader) =>
            (...args) =>
              context.withScope(
                (scope) =>
                  Promise.race([
                    reading.run(layer, () => (scope.resolve(reader) as (...args: never[]) => unknown)(...args)),
                    // A read that never settles must not hold the application's shutdown open.
                    stopping.promise.then(() => {
                      throw new Error("The application stopped during this read");
                    }),
                  ]),
                { root: reader, signal },
              ),
        );

        return {
          value: undefined,
          release: async () => {
            stopping.resolve();
            await stop?.();
          },
        };
      },
    }),
  };
}

const adapter: DefinitionAdapter = Object.freeze({ name: "@openknot-ts/cache", adapt });

/**
 * Startup work of a layer, given its dependencies and the readers it lists, each read in a scope of its own through
 * the layers below this one. The application starts once it settles; a returned stop function runs when it stops. A
 * read's scope closes with its result, so a reader that returns pages reads them from resources that outlive it.
 */
export function layerStartup(options: {
  readonly layer: object;
  readonly requirements: Requirements;
  readonly reads: readonly ReaderDefinition[];
  readonly start: Start;
}): PlugDefinition {
  const port = Object.freeze({
    [LayerStartupMarker]: true as const,
    layer: options.layer,
    reads: options.reads,
    [DefinitionIntegrationMarker]: {
      name: adapter.name,
      references: options.reads,
      load: async () => adapter,
    },
  });
  const declare = plug as unknown as (declaration: {
    readonly port: object;
    readonly requirements: Requirements;
    readonly bind: Start;
  }) => PlugDefinition;

  return declare({ port, requirements: options.requirements, bind: options.start });
}
