import { replication } from "../src/index.ts";
import { reader } from "@openknot-ts/behavior";
import type {} from "@openknot-ts/behavior/wire";
import { plug, providePlugs } from "@openknot-ts/wire";

interface State {
  readonly entity: "role";
  readonly id: string;
}

const roleReader = reader<(id: string) => Promise<State | undefined>>();

// @ts-expect-error A distributed section whose port states lack version requires order.
const sharedNoOrder = replication.distributed({
  entity: "role",
  port: roleReader,
  namespace: "test:role",
  load: roleReader,
});

const sharedValid = replication.distributed({
  entity: "role",
  port: roleReader,
  namespace: "test:role:valid",
  load: roleReader,
  order: (state) => state.id,
});

// A replication is listed in a plug module like the plug it replaces.
const roleReaders = plug({ port: roleReader, bind: () => async () => undefined });
const listed = providePlugs([replication({ roleReaders, sharedValid })]);

void sharedNoOrder;
void listed;
