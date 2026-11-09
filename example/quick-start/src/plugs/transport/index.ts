import "@openknot-ts/flow/wire";
import { trpcRouter } from "./trpc/router.ts";
import { providePlugs } from "@openknot-ts/wire";

export { trpcRouter } from "./trpc/router.ts";
export type { AppRouter } from "./trpc/router.ts";

export const transport = providePlugs([trpcRouter]);
