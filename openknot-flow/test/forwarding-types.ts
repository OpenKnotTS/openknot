import type { ResolvedRequirement } from "../src/index.ts";
import { command, expose, guard, listener, query, scheduler } from "../src/index.ts";
import { success } from "@openknot-ts/behavior";

const rename = command<string>()({ run: (name) => success(name.length) });
const access = guard<string>()({ run: (_token) => success() });
const exposed = expose({ handler: rename, guards: { access } });
const received = listener({ handler: rename });
const show = query<number>()({ run: (length) => success({ length }) });
const viewed = expose({ handler: rename, view: show, guards: { access } });

export async function verifyForwarding(
  invoke: ResolvedRequirement<typeof exposed>,
  receive: ResolvedRequirement<typeof received>,
): Promise<void> {
  const length: number = await invoke({ input: "role", access: "token" });
  void length;
  // @ts-expect-error The handler's input type is inferred.
  void invoke({ input: 1, access: "token" });
  // @ts-expect-error Guard inputs remain required.
  void invoke({ input: "role" });
  void receive({ input: "role" });
  // @ts-expect-error The listener input comes from the handler.
  void receive({ input: 1 });
}

export async function verifyView(invoke: ResolvedRequirement<typeof viewed>): Promise<void> {
  const shown: { readonly length: number } = await invoke({ input: "role", access: "token" });
  void shown;
  // @ts-expect-error The response is the view's output, not the handler's.
  const length: number = await invoke({ input: "role", access: "token" });
  void length;
  // @ts-expect-error The handler's input and guard inputs still apply.
  void invoke({ input: 1, access: "token" });
}

// @ts-expect-error A view is a query.
expose({ handler: rename, view: rename });
// @ts-expect-error A view's input accepts the handler's output.
expose({ handler: rename, view: query<string>()({ run: (name) => success(name) }) });

// @ts-expect-error A forwarding port has no run().
expose({ handler: rename, run: () => success() });
// @ts-expect-error A forwarding port has no requirements.
listener({ handler: rename, requirements: {} });
// @ts-expect-error Schedulers forward only to handlers without input.
scheduler({ handler: rename, schedule: { every: { minutes: 1 } } });
scheduler({ handler: query({ run: () => success() }), schedule: { every: { minutes: 1 } } });
