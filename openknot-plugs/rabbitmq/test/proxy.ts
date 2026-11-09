import { connect, createServer } from "node:net";
import type { Socket } from "node:net";
import type { TestContext } from "node:test";

/** Byte-level proxy: disconnect real AMQP sockets without touching native SDK internals. */
export async function brokerProxy(t: TestContext, url: string) {
  const target = new URL(url);
  const port = Number(target.port || 5672);
  const hostname = target.hostname;
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect(port, hostname);
    sockets.add(client);
    sockets.add(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      client.destroy();
    });
  });
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("AMQP proxy has no TCP address");
  }
  target.hostname = "127.0.0.1";
  target.port = String(address.port);
  return {
    url: target.href,
    disconnect() {
      for (const socket of sockets) {
        socket.destroy();
      }
    },
  };
}
