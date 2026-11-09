import { error } from "@openknot-ts/behavior";
import type { DeliveryOptions } from "@openknot-ts/flow";
import type { ResourceHandle } from "@openknot-ts/wire";
import type { EventEmitter } from "node:events";
import { ReadableStream } from "node:stream/web";
import type { ReadableStreamDefaultController } from "node:stream/web";

export type NodeEventName = string | symbol;
export interface InMemoryPubSubOptions {
  /** Caller-owned emitter; other listeners and its listener-limit configuration stay caller-owned. */
  readonly events: EventEmitter;
  /** Maximum queued messages per subscription. Defaults to 64. */
  readonly capacity?: number;
}
export const SlowSubscriberError = error("SlowSubscriberError", (capacity: number) => ({
  message: `Realtime subscription exceeded its ${capacity}-message capacity`,
  capacity,
}));
export type SlowSubscriberError = ReturnType<typeof SlowSubscriberError>;
interface Subscription<Key> {
  readonly key: Key;
  readonly close: () => Promise<void>;
}
export interface InMemoryPubSub<Key, Message> {
  publish(key: Key, message: Message, options?: DeliveryOptions): void;
  subscribe(key: Key, options?: DeliveryOptions): AsyncIterableIterator<Message, void>;
  keys(): readonly Key[];
  subscriberCount(key: Key): number;
}

/** EventEmitter owns routing/listeners; each native stream owns its bounded message queue. */
export function inMemoryPubSub<Key, Message>(
  options: InMemoryPubSubOptions & { readonly event: (key: Key) => NodeEventName },
): Promise<ResourceHandle<InMemoryPubSub<Key, Message>>> {
  const { events, event, capacity = 64 } = options;
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new TypeError("Subscription capacity must be a positive safe integer");
  }
  async function open(): Promise<ResourceHandle<InMemoryPubSub<Key, Message>>> {
    // Metadata is weakly associated with actual native listeners, not a second membership index.
    const subscriptions = new WeakMap<object, Subscription<Key>>();
    let closed = false;
    let release: Promise<void> | undefined;
    function available(): void {
      if (closed) {
        throw new Error("In-memory pub/sub resource is closed");
      }
    }
    function owned(name: NodeEventName): Subscription<Key>[] {
      return events.listeners(name).flatMap((listener) => {
        const subscription = subscriptions.get(listener);
        return subscription === undefined ? [] : [subscription];
      });
    }
    return {
      value: Object.freeze({
        publish(key: Key, message: Message, execution: DeliveryOptions = {}): void {
          available();
          execution.signal?.throwIfAborted();
          events.emit(event(key), message);
        },
        subscribe(key: Key, execution: DeliveryOptions = {}): AsyncIterableIterator<Message, void> {
          available();
          const { signal } = execution;
          signal?.throwIfAborted();
          const name = event(key);
          let controller!: ReadableStreamDefaultController<Message>;
          const stream = new ReadableStream<Message>(
            {
              start(value) {
                controller = value;
              },
            },
            { highWaterMark: capacity },
          );
          const reader = stream.getReader();
          let active = true;
          let released = false;
          let stopping: Promise<void> | undefined;
          function release(): void {
            if (!released) {
              released = true;
              reader.releaseLock();
            }
          }
          function detach(): void {
            if (!active) {
              return;
            }
            active = false;
            subscriptions.delete(receive);
            signal?.removeEventListener("abort", onAbort);
            events.off(name, receive);
          }
          function receive(message: Message): void {
            if (!active) {
              return;
            }
            if ((controller.desiredSize ?? 0) <= 0) {
              detach();
              controller.error(SlowSubscriberError(capacity));
            } else {
              controller.enqueue(message);
            }
          }
          function close(): Promise<void> {
            return (stopping ??= (async () => {
              detach();
              try {
                // An errored native stream has already discarded its queue.
                if (!released && controller.desiredSize !== null) {
                  await reader.cancel();
                }
              } finally {
                release();
              }
            })());
          }
          function onAbort(): void {
            void close();
          }
          const iterator: AsyncIterableIterator<Message, void> = {
            [Symbol.asyncIterator]() {
              return iterator;
            },
            async next(): Promise<IteratorResult<Message, void>> {
              if (released) {
                return { done: true, value: undefined };
              }
              try {
                const result = await reader.read();
                if (result.done) {
                  release();
                  return { done: true, value: undefined };
                }
                return { done: false, value: result.value };
              } catch (error) {
                detach();
                release();
                throw error;
              }
            },
            async return(): Promise<IteratorResult<Message, void>> {
              await close();
              return { done: true, value: undefined };
            },
            async throw(error: unknown): Promise<IteratorResult<Message, void>> {
              await close();
              throw error;
            },
          };
          subscriptions.set(receive, { key, close });
          try {
            events.on(name, receive);
            signal?.addEventListener("abort", onAbort, { once: true });
            if (signal?.aborted) {
              onAbort();
            }
          } catch (error) {
            void close();
            throw error;
          }
          return iterator;
        },
        keys(): readonly Key[] {
          return Object.freeze(
            events.eventNames().flatMap((name) => {
              const first = owned(name)[0];
              return first === undefined ? [] : [first.key];
            }),
          );
        },
        subscriberCount(key: Key): number {
          return owned(event(key)).length;
        },
      }),
      release(): Promise<void> {
        return (release ??= (async () => {
          closed = true;
          const results = await Promise.allSettled(
            events.eventNames().flatMap((name) => owned(name).map((entry) => entry.close())),
          );
          const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
          if (errors.length > 0) {
            throw new AggregateError(errors, "In-memory pub/sub subscription cleanup failed");
          }
        })());
      },
    };
  }
  return open();
}
