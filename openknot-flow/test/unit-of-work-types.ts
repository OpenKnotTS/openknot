import { command, hook, publisher, unitOfWork, writer } from "../src/index.ts";
import type { FlowExecutionError, UowActive, UowCommitted, UowCompleted } from "../src/index.ts";
import { success } from "@openknot-ts/behavior";

const active = hook<UowActive>()({ run: (_input) => success() });
const committed = hook<UowCommitted>()({
  run: (_input, ctx) => {
    const actor: unknown = ctx.actor;
    void actor;
    return success();
  },
});
unitOfWork({ hooks: { beforeCommit: [active], afterCommit: [committed] } });
// @ts-expect-error Hook inputs belong to their lifecycle phase.
unitOfWork({ hooks: { beforeCommit: [committed] } });
// @ts-expect-error Hooks return void Outcomes.
hook({ run: () => success(42) });
hook<UowCompleted>()({
  run: (input) => {
    if (input.status === "rolled-back") {
      const reason: Error = input.error;
      void reason;
    }
    return success();
  },
});
const messages = publisher<number>(),
  save = writer<(value: number) => void>();
command({
  requirements: { messages, save },
  run: (_, ctx) => {
    ctx.uow.afterCommit(() => ctx.messages.publish(1));
    return success();
  },
});
command({
  requirements: { save },
  // @ts-expect-error The removed timing configuration is not part of command().
  executionConfig: { publications: { save: "immediate" } },
  run: () => success(),
});
command({
  requirements: { messages },
  // @ts-expect-error The removed timing configuration is not part of command().
  executionConfig: { publications: { missing: "immediate" } },
  run: () => success(),
});
// Every Flow execution error narrows through its literal type discriminator.
export function describeFailure(error: FlowExecutionError): string {
  switch (error.type) {
    case "PostCommitError":
      return error.phase;
    case "UnitOfWorkError":
      return String(error.transactionStatus);
    case "VersionConflict":
      return error.target;
    case "InternalBehaviorError":
    case "InternalFlowError":
    case "InputCancelledError":
      return error.type;
  }
}
