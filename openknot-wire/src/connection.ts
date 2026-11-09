/**
 * A native connection's state, which a resource exposes when work must react to the connection dropping and coming
 * back, as a cache that clears or an outbox that redelivers. Acquire and release bound the resource's lifetime and a
 * health check answers whether it is up now; a watch reports the transitions in between, which only the native
 * client sees. Plugs map their client's own events to it.
 */
export interface ConnectionWatch {
  /**
   * Calls `lost` once when the connection drops and `restored` once when it is back, for every outage. Watchers are
   * independent; the returned function stops this one and does nothing when called again.
   */
  watch(handlers: { readonly lost: () => void; readonly restored: () => void }): () => void;
}

type ConnectionEvents = { readonly lost: () => void; readonly restored: () => void };

/**
 * A `ConnectionWatch` over a native client: `attach` subscribes the given `lost` and `restored` to the client's own
 * events and returns the function that unsubscribes them. It attaches with the first watcher and detaches with the
 * last, and reports each outage once to every watcher however many native events announce it.
 */
export function connectionWatch(attach: (events: ConnectionEvents) => () => void): ConnectionWatch {
  const watchers = new Set<ConnectionEvents>();
  let down = false;
  let detach: (() => void) | undefined;
  const events: ConnectionEvents = {
    lost: () => {
      if (!down) {
        down = true;
        for (const watcher of watchers) {
          watcher.lost();
        }
      }
    },
    restored: () => {
      if (down) {
        down = false;
        for (const watcher of watchers) {
          watcher.restored();
        }
      }
    },
  };

  return Object.freeze({
    watch(handlers: ConnectionEvents) {
      const watcher: ConnectionEvents = { lost: handlers.lost, restored: handlers.restored };
      watchers.add(watcher);
      detach ??= attach(events);
      return () => {
        if (watchers.delete(watcher) && watchers.size === 0) {
          detach?.();
          detach = undefined;
          // Unwatched, the client's events go unseen: a later watcher starts from the next transition it sees.
          down = false;
        }
      };
    },
  });
}
