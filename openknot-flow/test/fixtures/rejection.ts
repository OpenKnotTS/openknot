import assert from "node:assert/strict";

/** The error a plug-facing invocation rejects with; resolving fails the test. */
export async function rejection(invocation: Promise<unknown>): Promise<unknown> {
  try {
    await invocation;
  } catch (error) {
    return error;
  }
  return assert.fail("Expected the invocation to reject.");
}
