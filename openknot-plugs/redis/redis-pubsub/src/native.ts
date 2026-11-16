import { error } from "@openknot-ts/behavior";
import type { DeliveryOptions } from "@openknot-ts/flow";
import { inMemoryTopic } from "@openknot-ts/knot-pubsub";
import type { NodeEventName } from "@openknot-ts/knot-pubsub";
import type { ConnectionWatch, ResourceHandle } from "@openknot-ts/wire";
import { EventEmitter } from "node:events";
import type { RedisClient, RedisClientType } from "redis";

export type RedisPublisher = {
  sendCommand(...args: Parameters<RedisClientType["sendCommand"]>): ReturnType<RedisClientType["sendCommand"]>;
};

export type RedisShardedSubscriber = {
  sSubscribe: typeof RedisClient.prototype.sSubscribe<false>;
  sUnsubscribe: typeof RedisClient.prototype.sUnsubscribe<false>;
};

export const SubscriptionLostError = error("SubscriptionLostError", () => ({
  message: "The Redis subscription connection was lost, so messages published meanwhile were missed",
}));
export type SubscriptionLostError = ReturnType<typeof SubscriptionLostError>;

export interface RedisPubSubOptions<Message> {
  readonly commands: RedisPublisher;
  readonly subscriber: RedisShardedSubscriber;
  /** Watches the subscriber client, such as `redis.connection.subscriber` from `@openknot-ts/redis-client`. */
  readonly connection: ConnectionWatch;
  /** Maximum queued messages per subscription. Defaults to 64. */
  readonly capacity?: number;
  readonly encode?: (message: Message) => string;
  /** Decodes a message from Redis. Defaults to `JSON.parse`; a payload it rejects is dropped. */
  readonly decode?: (text: string) => Message;
}

export interface RedisPubSub<Key, Message> {
  publish(key: Key, message: Message, options?: DeliveryOptions): Promise<void>;
  subscribe(key: Key, options?: DeliveryOptions): Promise<AsyncIterableIterator<Message, void>>;
}

function until<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const aborted = Promise.withResolvers<never>();
  const abort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  return Promise.race([work, aborted.promise]).finally(() => signal.removeEventListener("abort", abort));
}

/**
 * Redis carries each channel between instances once and the local streams fan it out: an instance subscribes to a
 * channel with its first local subscriber and unsubscribes after its last. Nothing is stored in Redis.
 */
export async function redisPubSub<Key, Message>(
  options: RedisPubSubOptions<Message> & { readonly channel: (key: Key) => string },
): Promise<ResourceHandle<RedisPubSub<Key, Message>>> {
  const { commands, subscriber, connection, channel, capacity, encode = JSON.stringify, decode = JSON.parse } = options;
  // Every local subscription is a listener of this emitter, so its listener count is the subscriber count.
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const local = await inMemoryTopic<Key, Message>({
    events,
    event: channel,
    ...(capacity === undefined ? {} : { capacity }),
  });
  // Channels with a local subscriber, and the last Redis call per channel: a channel's calls run one after another.
  const joined = new Set<string>();
  const pending = new Map<string, Promise<void>>();
  const failures: unknown[] = [];
  let outage = new AbortController();
  let released = false;

  function relay(text: string, name: string): void {
    let message: Message;
    try {
      message = decode(text);
    } catch {
      return;
    }
    events.emit(name, message);
  }

  function enqueue(name: string, call: () => Promise<void>): Promise<void> {
    const next = (pending.get(name) ?? Promise.resolve()).catch(() => undefined).then(call);
    const settle = () => {
      if (pending.get(name) === next) {
        pending.delete(name);
      }
    };
    pending.set(name, next);
    next.then(settle, settle);
    return next;
  }

  function join(name: string): Promise<void> {
    if (!joined.has(name)) {
      joined.add(name);
      // A refused subscription leaves the channel unsubscribed, so the next subscriber subscribes again.
      enqueue(name, () =>
        subscriber.sSubscribe(name, relay).catch((error: unknown) => {
          joined.delete(name);
          throw error;
        }),
      );
    }
    return pending.get(name) ?? Promise.resolve();
  }

  function leave(name: NodeEventName): void {
    if (typeof name !== "string" || events.listenerCount(name) > 0 || !joined.delete(name)) {
      return;
    }
    // A failed unsubscription keeps the channel's messages arriving with no listener; release reports it.
    enqueue(name, () =>
      subscriber.sUnsubscribe(name, relay).catch((error: unknown) => {
        failures.push(error);
      }),
    );
  }

  function available(): void {
    if (released) {
      throw new Error("Redis pub/sub resource is released");
    }
  }

  events.on("removeListener", leave);
  const unwatch = connection.watch({
    lost() {
      outage.abort(SubscriptionLostError());
      local.value.interrupt(SubscriptionLostError());
    },
    restored() {
      outage = new AbortController();
    },
  });

  return {
    value: Object.freeze({
      async publish(key: Key, message: Message, execution: DeliveryOptions = {}): Promise<void> {
        available();
        const { signal } = execution;
        signal?.throwIfAborted();
        await commands.sendCommand(
          ["SPUBLISH", channel(key), encode(message)],
          signal === undefined ? undefined : { abortSignal: signal },
        );
      },
      async subscribe(key: Key, execution: DeliveryOptions = {}): Promise<AsyncIterableIterator<Message, void>> {
        available();
        const { signal } = execution;
        const stop = signal === undefined ? outage.signal : AbortSignal.any([outage.signal, signal]);
        stop.throwIfAborted();
        const name = channel(key);
        const joining = join(name);
        let messages: AsyncIterableIterator<Message, void>;
        try {
          messages = local.value.subscribe(key, execution);
        } catch (error) {
          leave(name);
          throw error;
        }
        try {
          await until(joining, stop);
        } catch (error) {
          await messages.return?.();
          throw error;
        }
        return messages;
      },
    }),
    async release(): Promise<void> {
      released = true;
      unwatch();
      const errors: unknown[] = [];
      try {
        await local.release();
      } catch (error) {
        errors.push(error);
      }
      await Promise.allSettled(pending.values());
      events.off("removeListener", leave);
      errors.push(...failures);
      if (errors.length > 0) {
        throw new AggregateError(errors, "Redis pub/sub release failed");
      }
    },
  };
}
