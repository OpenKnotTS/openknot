export type { AppActor } from "./actor.ts";
import type { RoleEvent, LogEvent } from "@modular/behavior/events";
import type { LogState } from "@modular/behavior/models/log";
import type { RoleState } from "@modular/behavior/models/role";
import { error, reader } from "@openknot-ts/behavior";
import { publisher, writer } from "@openknot-ts/flow";
import type { Upserted } from "@openknot-ts/flow";

export const AccessDenied = error("AccessDenied");
export type AccessDenied = ReturnType<typeof AccessDenied>;

// Persistence
export const saveRoleWriter = writer<(role: RoleState) => Promise<Upserted<RoleState>>>();
export const saveLogWriter = writer<(log: LogState) => Promise<Upserted<LogState>>>();

// Messaging
export const rolePublisher = publisher<RoleEvent>();
export const logPublisher = publisher<LogEvent>();

// Access
export const userHasAccessToRole = reader<(userId: string | undefined) => Promise<boolean>>();
