import { error, failure, isOutcome } from "../src/index.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";

const AccessDenied = error("AccessDenied");
const RoleNotFound = error("RoleNotFound", (id: string, cause?: unknown) => ({
  message: `Role ${id} was not found`,
  ...(cause === undefined ? {} : { cause }),
  id,
}));

function findRole(id: string) {
  return RoleNotFound(id, new Error("row missing"));
}

test("functional errors are frozen real Errors with type, name, message, cause and fields", () => {
  const cause = new Error("token expired");
  const denied = AccessDenied("A valid token is required.", { cause });
  assert.ok(denied instanceof Error);
  assert.equal(denied.type, "AccessDenied");
  assert.equal(denied.name, "AccessDenied");
  assert.equal(denied.message, "A valid token is required.");
  assert.equal(denied.cause, cause);
  assert.equal(AccessDenied().message, "AccessDenied");
  assert.equal("cause" in AccessDenied("no cause"), false);
  const missing = findRole("r1");
  assert.equal(missing.id, "r1");
  assert.equal((missing.cause as Error).message, "row missing");
  assert.ok(Object.isFrozen(missing));
  assert.throws(() => Reflect.set(missing, "id", "other") || assert.fail("frozen"), /frozen|read only/);
  assert.deepEqual(JSON.parse(JSON.stringify(missing)), { id: "r1", type: "RoleNotFound" });
  assert.ok(isOutcome(failure(missing)));
});

test("the stack starts at the caller and inspection shows the error type", () => {
  const missing = findRole("r1");
  const [header, firstFrame] = missing.stack?.split("\n") ?? [];
  assert.equal(header, "RoleNotFound: Role r1 was not found");
  assert.match(firstFrame ?? "", /at findRole /);
  assert.match(inspect(AccessDenied("denied")), /^AccessDenied: denied\n\s+at /);
});

test("name, stack and type belong to the error, so a describer cannot return them", () => {
  for (const key of ["name", "stack", "type"]) {
    const Clashing = error("Clashing", () => ({ message: "clash", [key]: "field" }) as never);
    assert.throws(() => Clashing(), {
      name: "TypeError",
      message: `error("Clashing") field '${key}' is reserved; name the field differently.`,
    });
  }
  const Taken = error("Taken", (taken: string) => ({ message: `${taken} is taken`, taken }));
  assert.deepEqual([Taken("admin").name, Taken("admin").taken], ["Taken", "admin"]);
});

test("is() narrows by type, and error() rejects invalid declarations", () => {
  assert.equal(AccessDenied.type, "AccessDenied");
  assert.equal(AccessDenied.is(AccessDenied()), true);
  assert.equal(AccessDenied.is(RoleNotFound("r1")), false);
  assert.equal(AccessDenied.is(new Error("plain")), false);
  assert.equal(AccessDenied.is({ type: "AccessDenied" }), true, "Type checks work across copies of a package.");
  assert.equal(AccessDenied.is(undefined), false);
  assert.throws(() => error(""), /non-empty type/);
  assert.throws(() => Reflect.apply(error, undefined, ["Bad", "not a function"]), /describe must be a function/);
});
