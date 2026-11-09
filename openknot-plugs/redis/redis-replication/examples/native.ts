import { createClient } from "redis";

/** Native node-redis connections shared by the focused example and broker tests. */
export async function redisConnections(url: string) {
  const commands = createClient({ url });
  const subscriber = commands.duplicate();
  const native = [commands, subscriber];

  for (const client of native) {
    client.on("error", console.error);
  }

  try {
    await Promise.all(native.map((client) => client.connect()));
  } catch (error) {
    for (const client of native) {
      if (client.isOpen) {
        client.destroy();
      }
    }

    throw error;
  }

  return {
    commands,
    subscriber,
    async close() {
      const results = await Promise.allSettled(native.map((client) => client.close()));
      const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));

      if (errors.length > 0) {
        throw new AggregateError(errors, "Redis connection cleanup failed");
      }
    },
  };
}
