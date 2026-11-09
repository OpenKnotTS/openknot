/** The part of a Node.js-compatible process that stopOn binds. */
export interface SignalHost {
  once(name: string, listener: () => void): unknown;
  removeListener(name: string, listener: () => void): unknown;
}

interface Binding {
  readonly listeners: Set<() => void>;
  readonly dispatch: () => void;
}

// Process signals are process-wide, so every application of the process shares one listener per signal.
const bindings = new Map<string, Binding>();

/**
 * Calls the listener once when the signal arrives. The first delivery reaches every application bound at
 * that moment and removes the shared listener, so a repeated signal falls back to the platform default.
 * Returns the function that unbinds this application.
 */
export function onProcessSignal(host: SignalHost, name: string, listener: () => void): () => void {
  let binding = bindings.get(name);
  if (binding === undefined) {
    const listeners = new Set<() => void>();
    const created: Binding = {
      listeners,
      dispatch(): void {
        bindings.delete(name);
        for (const notify of listeners) {
          notify();
        }
      },
    };
    bindings.set(name, created);
    host.once(name, created.dispatch);
    binding = created;
  }
  const bound = binding;
  bound.listeners.add(listener);
  return () => {
    bound.listeners.delete(listener);
    if (bound.listeners.size === 0 && bindings.get(name) === bound) {
      bindings.delete(name);
      host.removeListener(name, bound.dispatch);
    }
  };
}
