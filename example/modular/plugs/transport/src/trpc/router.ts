import { createRoleExposure, getStateExposure } from "@modular/flow/exposures";
import { trpcAuthentication } from "@openknot-ts/trpc-context/wire";
import { trpcRouter as declareTrpcRouter } from "@openknot-ts/trpc-router";
import type { Resolved } from "@openknot-ts/wire";
import { z } from "zod";

const roleInput = z.object({
  id: z.string(),
  name: z.string(),
  active: z.boolean(),
});

export const trpcRouter = declareTrpcRouter({
  requirements: { authentication: trpcAuthentication, createRoleExposure, getStateExposure },
  routes: ({ trpc, authentication, createRoleExposure, getStateExposure }) => {
    const protectedProcedure = trpc.procedure.use(authentication);

    return {
      createRole: protectedProcedure.input(roleInput).mutation(createRoleExposure),
      getState: protectedProcedure.query(getStateExposure),
    };
  },
});

export type AppRouter = Resolved<typeof trpcRouter>;
