import type { ConnectionWatch } from "@openknot-ts/wire";
import { connectionWatch } from "@openknot-ts/wire";
import type { Connection } from "rabbitmq-client";

/** Watches a native connection: an error while it is not ready reports `lost`, its next `connection` event `restored`. */
export function rabbitConnectionOf(connection: Pick<Connection, "on" | "off" | "ready">): ConnectionWatch {
  return connectionWatch(({ lost, restored }) => {
    const onError = () => {
      if (!connection.ready) {
        lost();
      }
    };
    connection.on("error", onError);
    connection.on("connection", restored);
    return () => {
      connection.off("error", onError);
      connection.off("connection", restored);
    };
  });
}
