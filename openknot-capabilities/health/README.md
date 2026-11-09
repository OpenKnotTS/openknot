# OpenKnot health

`@openknot-ts/health` supplies liveness, readiness and health checks bound to the application lifecycle through Wire's `applicationStatus`. Plugs declare checks next to the resources they check; the application selects a health module or a transport adapter; the adapter exposes the probes. The package owns no server and no HTTP code.

```text
runApplication → starting   liveness up   readiness down
               → ready      liveness up   readiness up    health = readiness + every check
stop / SIGTERM → stopping   liveness up   readiness down  (switches inside app.stop(), before any shutdown task)
               → stopped    liveness down
```

- **Liveness** is up while the application can serve. Checks never affect it, so a database outage does not restart the process.
- **Readiness** is up only while the application is `ready`: down during startup and from the moment stopping begins.
- **Health** is readiness combined with every check. Checks run concurrently; a check that rejects or throws counts as down.

## Declare checks

A check is declared beside the resource it checks and listed in that plug's existing provision:

```ts
import { healthCheck } from "@openknot-ts/health";

export const databaseHealth = healthCheck({
  name: "database",
  requirements: { database },
  check: async ({ database }, { signal }) => {
    await database.$client.execute("SELECT 1");
    return "up";
  },
});

export const io = providePlugs([database, transaction, databaseHealth, identity, storage]);
```

`healthCheck()` returns an ordinary Wire unit that joins the `healthChecks` collection contract. Every check listed in the application's selected modules joins, in module order; nothing is scanned or registered globally, so two applications in one process keep their own checks. Check names must be distinct; a duplicate fails startup. `signal` ends with the caller's request or at the check's `timeoutMs` deadline, one second by default; pass it to native work that accepts one. A check that has not settled by its deadline reports down, so a dependency that holds a request cannot hold the probe. A check is built only when the application selects the health probes, through the health module or an adapter that requires them.

## Enable the probes

List the module like any other layer:

```ts
import { health } from "@openknot-ts/health";

export const application = defineApplication({
  modules: [behavior, flow, health, io, channels, transport],
  // ...
});
```

The `health` module provides probe semantics without adding HTTP routes. For the Node HTTP host, select the separate [`@openknot-ts/knot-health`](../../openknot-plugs/knot/knot-health/README.md) adapter's `healthHttp` module instead: its middleware requires the probes, so they join without listing `health`; it implements generic native middleware, owns path configuration and maps up/down to 200/503. The HTTP host has no health import or dependency. Other transports can consume `healthProbes` and implement their own protocol mapping.

`healthProbes.health({ signal })` also returns the `application` status and each check's status by name. Public HTTP probes answer only `{ "status": "up" | "down" }`; a host that shows the details protects that view itself.

## Kubernetes

Point the probes at the host's paths. When a pod is deleted, Kubernetes removes it from Service endpoints while it sends SIGTERM, so give the endpoints time to propagate before the application stops:

```yaml
spec:
  terminationGracePeriodSeconds: 30 # above the preStop sleep plus the drain time
  containers:
    - name: api
      livenessProbe:
        httpGet: { path: /livez, port: 3000 }
      readinessProbe:
        httpGet: { path: /readyz, port: 3000 }
      lifecycle:
        preStop:
          sleep: { seconds: 5 }
```

SIGTERM then stops the application: readiness turns down, the HTTP host stops intake and admitted work finishes with `Connection: close` before resources close. A graceful signal-initiated stop exits with status 0.

[Tests](test/health.test.ts) cover the lifecycle phases, checks gathered from several modules, concurrency, failures, the absent module and duplicate names. The separate HTTP adapter's tests and both main examples verify the probes over real HTTP.
