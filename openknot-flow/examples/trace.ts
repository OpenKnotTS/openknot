import { expose, query } from "../src/index.ts";
import { provideFlow } from "../src/wire.ts";
import { success } from "@openknot-ts/behavior";
import type { Tracing } from "@openknot-ts/tracing";
import { trace } from "@openknot-ts/tracing/wire";
import { defineApplication, providePlugs, runApplication, unit } from "@openknot-ts/wire";

// A local timing adapter: it has no active span or distributed context to capture or bind.
const consoleTrace = unit({
  provides: trace,
  factory: (): Tracing => ({
    propagationFields: [],
    async run(span, work) {
      const started = performance.now();

      try {
        return await work();
      } finally {
        console.log(`${span.name}: ${(performance.now() - started).toFixed(2)} ms`);
      }
    },
    capture: () => undefined,
    bind: (work) => work,
  }),
});

const greet = query<string>()({ run: (name) => success(`Hello, ${name}!`) });
const hello = expose({ handler: greet });

const application = defineApplication({
  modules: [provideFlow([hello]), providePlugs([consoleTrace])],
});

const app = await runApplication(application);

try {
  console.log(await app.resolve(hello)({ input: "Giorgos" }));
} finally {
  await app.stop();
}
