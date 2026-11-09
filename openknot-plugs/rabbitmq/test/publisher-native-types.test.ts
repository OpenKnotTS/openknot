import type { RabbitPublisherConnection } from "../src/index.ts";
import { test } from "node:test";
import type { Connection } from "rabbitmq-client";

/** A complete native connection satisfies the adapter's selected SDK methods. */
function nativeCompatibility(connection: Connection): RabbitPublisherConnection {
  return connection;
}
test("a native rabbitmq-client connection satisfies the publisher API", () => {
  void nativeCompatibility;
});
