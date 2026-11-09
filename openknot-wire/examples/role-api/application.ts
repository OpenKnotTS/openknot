import * as roles from "./role.providers.ts";
import { startApi, stopApi, lifecycle, roleService, warmup } from "./role.providers.ts";
import { runApplication, defineApplication, composeModule, requiredBy } from "@openknot-ts/wire";

// Only the role service is a root; what it requires joins through its requirements.
const roleApi = composeModule({ providers: roles }).includeOnly([roleService]);

const definition = defineApplication({
  modules: requiredBy(roleApi),
  startupTasks: [warmup, startApi],
  shutdownTasks: [stopApi],
});

const app = await runApplication(definition);

try {
  const service = app.resolve(roleService);
  const role = await service.create("Supervisor");

  console.log(await service.find(role.id));
  console.log({ ready: app.ready, lifecycle });
} finally {
  await app.stop();
  console.log({ status: app.status, lifecycle });
}
