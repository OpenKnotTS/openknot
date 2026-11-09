import { guard } from "../src/index.ts";
import { actorResolver, executionActorResolver } from "../src/wire.ts";
import { success } from "@openknot-ts/behavior";
import { defineApplication, providePlugs, runApplication, unit } from "@openknot-ts/wire";
import type { Resolved } from "@openknot-ts/wire";

const identityApi = unit({ factory: () => (token: string) => ({ subject: token, permissions: ["roles:create"] }) });
const identity = actorResolver({
  requirements: { identityApi },
  resolve: (token: string, ctx) => {
    ctx.signal.throwIfAborted();
    // @ts-expect-error Only declared dependencies are available.
    void ctx.missing;
    return ctx.identityApi(token);
  },
});
const consumer = unit({
  requirements: { resolve: executionActorResolver },
  factory: ({ resolve }) => resolve,
});
const configured = defineApplication({ modules: [providePlugs([identityApi, identity, consumer])] });
void runApplication(configured);
const missingIdentity = defineApplication({ modules: [providePlugs([consumer])] });
// @ts-expect-error A required actor resolver still needs an implementation.
void runApplication(missingIdentity);
type Actor = Awaited<ReturnType<Resolved<typeof identity>>>;
const valid: Actor = { subject: "external", permissions: ["roles:create"] };
void valid;
// @ts-expect-error Actor shape is inferred from the resolver; no framework id is required.
const invalid: Actor = { id: "external" };
void invalid;
guard({
  run: (_, ctx) => {
    // @ts-expect-error Without application augmentation the actor's shape is unknown.
    void ctx.actor.userId;
    return success();
  },
});
