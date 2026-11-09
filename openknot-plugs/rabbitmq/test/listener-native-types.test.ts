import type { RabbitConsumerConnection } from "../src/index.ts";
import { test } from "node:test";
import type { Connection } from "rabbitmq-client";

/** A complete native connection satisfies the adapter's selected SDK methods. */
function nativeCompatibility(connection: Connection): RabbitConsumerConnection {
  return connection;
}
test("a native rabbitmq-client connection satisfies the consumer API", () => {
  void nativeCompatibility;
});
