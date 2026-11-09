import { success } from "../src/behavior/index.ts";
import { query } from "@openknot-ts/core/flow";

// An application that depends only on "@openknot-ts/core" types its actor through the bundled Flow entry.
declare module "@openknot-ts/core/flow" {
  interface ExecutionTypes {
    readonly actor: { readonly userId: string };
  }
}

export const whoAmI = query({
  run: (_input, ctx) => {
    const userId: string | undefined = ctx.actor?.userId;
    return success(userId);
  },
});
