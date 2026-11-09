import type { UnitOfWorkDefinition, UnitOfWorkImplementation } from "../../src/index.ts";
import { defaultUnitOfWork } from "../../src/index.ts";
import type { Definition } from "@openknot-ts/wire";
import { composeModule, defineApplication, runApplication, unit } from "@openknot-ts/wire";

/** Runs the definitions, optionally selecting a Unit of Work in place of the default one. */
export function application(sources: readonly Definition[], selected?: UnitOfWorkDefinition) {
  const selection =
    selected === undefined
      ? []
      : [
          unit({
            provides: defaultUnitOfWork,
            lifetime: "scoped",
            requirements: { selected },
            factory: ({ selected }) => selected,
          }),
        ];
  return runApplication(
    defineApplication({
      modules: [composeModule({ providers: [...sources, ...selection].map((source) => ({ source })) })],
    }),
  );
}

/** A native driver that records whether each transaction committed or rolled back. */
export function recording(outcomes: string[]): UnitOfWorkImplementation {
  return {
    async transaction(work) {
      try {
        const result = await work();
        outcomes.push("commit");
        return result;
      } catch (error) {
        outcomes.push("rollback");
        throw error;
      }
    },
  };
}
