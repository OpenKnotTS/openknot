import { broadcast, expose, guard, topic } from "../src/index.ts";
import type { GuardRequest, ResolvedRequirement } from "../src/index.ts";
import { success } from "@openknot-ts/behavior";
const access = guard<string>()({ run: (_input) => success() });
const organization = guard<{ readonly id: number }>()({ run: (_input) => success() });
const guards = { source: access, organization, destination: access };
const inputs = { source: "source", organization: { id: 1 }, destination: "destination" };
const exposure = expose<{ readonly id: string }>()({ guards, run: (input) => success(input) });
const updates = topic<"roles", string>()({ guards });
const notifications = broadcast<string>()({ guards });
expose({ guards: undefined, run: () => success() });
topic<string, string>()({ guards: undefined });
broadcast<string>()({ guards: undefined });
export function verifySharedRequests(
  entry: ResolvedRequirement<typeof exposure>,
  topics: ResolvedRequirement<typeof updates>,
  messages: ResolvedRequirement<typeof notifications>,
): void {
  const request: GuardRequest<{ readonly id: string }, typeof guards> = { ...inputs, input: { id: "role" } };
  void entry(request);
  void topics.subscribe({ ...inputs, input: "roles" });
  void messages.subscribe({ ...inputs, input: undefined });
  // @ts-expect-error Every named guard is required on exposures.
  entry({ source: "source", organization: { id: 1 }, input: { id: "role" } });
  // @ts-expect-error Every named guard is required on topics.
  topics.subscribe({ source: "source", organization: { id: 1 }, input: "roles" });
  // @ts-expect-error Every named guard is required on broadcasts.
  messages.subscribe({ source: "source", organization: { id: 1 }, input: undefined });
  // @ts-expect-error Independent guard input types are preserved.
  topics.subscribe({ ...inputs, organization: { id: "wrong" }, input: "roles" });
  // @ts-expect-error Nested guard envelopes are invalid.
  messages.subscribe({ guards: inputs, input: undefined });
  // @ts-expect-error The port input retains its own type.
  topics.subscribe({ ...inputs, input: "other" });
  // A field whose input is void carries no data and may be left out; the others stay required.
  void voidEntry({ source: "source" });
  void voidUpdates.subscribe({ source: "source", input: "roles" });
  void voidNotifications.subscribe({ source: "source" });
  // @ts-expect-error A guard input that carries data is still required.
  voidEntry({});
  // @ts-expect-error A port input that carries data is still required.
  voidUpdates.subscribe({ source: "source" });
}
const signedIn = guard({ run: () => success() });
const voidGuards = { signedIn, source: access };
const voidExposure = expose({ guards: voidGuards, run: () => success() });
const voidTopic = topic<"roles", string>()({ guards: voidGuards });
const voidBroadcast = broadcast<string>()({ guards: voidGuards });
declare const voidEntry: ResolvedRequirement<typeof voidExposure>;
declare const voidUpdates: ResolvedRequirement<typeof voidTopic>;
declare const voidNotifications: ResolvedRequirement<typeof voidBroadcast>;
// @ts-expect-error Reserved guard names use the shared declaration validation.
broadcast<string>()({ guards: { signal: access } });
// @ts-expect-error Propagation is a shared execution option, not a guard input name.
expose({ guards: { propagation: access }, run: () => success() });
// @ts-expect-error Transport trace attributes are shared execution options.
topic<string, string>()({ guards: { traceAttributes: access } });
// @ts-expect-error Input mappers are not accepted on any guardable.
topic<string, string>()({ guards, guardInputs: () => inputs });
