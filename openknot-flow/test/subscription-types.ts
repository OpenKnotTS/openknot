import { broadcast, topic, guard } from "../src/index.ts";
import type { BroadcastMessage, TopicKey, TopicMessage, ResolvedRequirement } from "../src/index.ts";
import { success } from "@openknot-ts/behavior";
import { plug } from "@openknot-ts/wire";
import type { Resolved } from "@openknot-ts/wire";
import "../src/wire.ts";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
const access = guard<string>()({ run: (_token) => success() });
type Recipient = { readonly userId: string; readonly resourceId: number; readonly scope: "read" };
const targeted = topic<Recipient, string>()({ guards: { access } });
type RecipientInference = Assert<Equal<TopicKey<typeof targeted>, Recipient>>;
export type StructuredKeyInference = RecipientInference;
export async function structuredKeys(port: Resolved<typeof targeted>) {
  const input: Recipient = { userId: "alice", resourceId: 42, scope: "read" };
  const stream: AsyncIterable<string> = await port.subscribe({ input, access: "token" });
  await port.publish(input, "changed");
  // @ts-expect-error Keys preserve the entire declared shape.
  port.publish("alice", "changed");
  // @ts-expect-error Named guard inputs remain required for structured keys.
  port.subscribe({ input });
  // @ts-expect-error Publication preserves the event type alongside the structured key.
  port.publish(input, 42);
  void stream;
}
const roles = topic<`roles:${string}`, { readonly id: string }>()({ guards: { access } });
const logs = broadcast<{ readonly action: string }>()({ guards: { access } });
const binding = plug({
  port: roles,
  bind: () => ({
    publish: (key, event) => {
      const k: `roles:${string}` = key;
      const id: string = event.id;
      void k;
      void id;
    },
    subscribe: async function* () {
      yield { id: "one" };
    },
  }),
});
plug({
  port: logs,
  bind: () => ({
    publish() {},
    subscribe: async function* () {
      yield { action: "created" };
    },
  }),
});
// @ts-expect-error Different realtime contracts require independent plugs.
plug({ port: [roles, logs], bind: () => binding });
export type Inference = [
  Assert<Equal<TopicKey<typeof roles>, `roles:${string}`>>,
  Assert<Equal<TopicMessage<typeof roles>, { readonly id: string }>>,
  Assert<Equal<BroadcastMessage<typeof logs>, { readonly action: string }>>,
  Assert<Equal<ResolvedRequirement<typeof roles>, Resolved<typeof roles>>>,
];
export async function check(rolesPort: ResolvedRequirement<typeof roles>, logsPort: ResolvedRequirement<typeof logs>) {
  const roleStream: AsyncIterable<{ readonly id: string }> = await rolesPort.subscribe({
    input: "roles:one",
    access: "token",
  });
  const logStream: AsyncIterable<{ readonly action: string }> = await logsPort.subscribe({
    input: undefined,
    access: "token",
  });
  void roleStream;
  void logStream;
  await rolesPort.publish("roles:one", { id: "one" });
  await logsPort.publish({ action: "created" });
  // @ts-expect-error Topic keys retain their template literal type.
  rolesPort.publish("other", { id: "one" });
  // @ts-expect-error Topic publication retains its payload type.
  rolesPort.publish("roles:one", { id: 1 });
  // @ts-expect-error Broadcasts have no key argument.
  logsPort.publish("roles:one", { action: "created" });
  // @ts-expect-error Broadcast subscription requires its named guard inputs.
  logsPort.subscribe({ input: undefined });
  // @ts-expect-error Topics also require their named guard inputs.
  rolesPort.subscribe({ input: "roles:one" });
  plug({
    port: roles,
    bind: () => ({
      publish() {},
      // @ts-expect-error Backend output must match the declared message contract.
      subscribe: async function* () {
        yield 1;
      },
    }),
  });
}
