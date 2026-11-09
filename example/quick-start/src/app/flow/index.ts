import { createRoleExposure, getStateExposure } from "./exposures.ts";
import { roleChangedListener } from "./listeners.ts";
import { saveRoleWriter, saveLogWriter, rolePublisher, logPublisher, userHasAccessToRole } from "./ports.ts";
import { provideFlow } from "@openknot-ts/flow/wire";

export const flow = provideFlow([
  // Inputs
  createRoleExposure,
  getStateExposure,
  roleChangedListener,

  // Outputs
  saveRoleWriter,
  saveLogWriter,
  rolePublisher,
  logPublisher,
  userHasAccessToRole,
]);
