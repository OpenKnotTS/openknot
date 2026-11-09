import "@openknot-ts/flow/wire";
import { rolePublishing, logPublishing, roleEvents } from "./node-events.ts";
import { providePlugs } from "@openknot-ts/wire";

export { eventBus, rolePublishing, logPublishing, roleEvents } from "./node-events.ts";

export const channels = providePlugs([rolePublishing, logPublishing, roleEvents]);
