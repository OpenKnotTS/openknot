import { provideAuth0 } from "../src/wire.ts";
import { composeModule, defineApplication, runApplication, unit } from "@openknot-ts/wire";

const required = unit.contract<string>();
const consumer = unit({ requirements: { required }, factory: ({ required }) => required });
const identity = provideAuth0({
  factory: () => ({
    issuer: "https://tenant.example/",
    audience: "https://api.example",
    mapActor: (claims) => claims.sub,
  }),
});
const application = defineApplication({ modules: [composeModule({ providers: { consumer } }), identity] });
// @ts-expect-error The Auth0 module keeps the application's check: the required contract has no implementation.
void runApplication(application);
