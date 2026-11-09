import type { RoleEvent } from "../src/app/behavior/events.ts";
import type { RoleState } from "../src/app/behavior/models/role.ts";
import type { createRoleOp } from "../src/app/behavior/operations.ts";
import type { OperationInput, OperationEvents } from "@openknot-ts/behavior";

const input: OperationInput<typeof createRoleOp> = { id: "one", name: "One", active: true };
const state: RoleState = input;
const event: OperationEvents<typeof createRoleOp> = { type: "RoleChanged", role: state };
const roleEvent: RoleEvent = event;
// @ts-expect-error active is part of the role state contract.
const invalid: RoleState = { id: "one", name: "One" };
// @ts-expect-error Only declared RoleEvent variants can be emitted.
const wrong: OperationEvents<typeof createRoleOp> = { type: "Other", role: state };
void [roleEvent, invalid, wrong];
