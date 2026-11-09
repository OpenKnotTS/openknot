import { fixture } from "./fixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("SSE authenticates before guarded subscription admission and sends native event data", async (t) => {
  const server = await fixture(t);
  const response = await fetch(`${server.url}/changes`, {
    headers: { authorization: `Bearer ${server.token}`, accept: "text/event-stream" },
  });
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);

  const frames = await response.text();

  assert.match(frames, /data: "update"/);
  assert.deepEqual(server.counts(), { authentications: 1, executions: 0, admissions: 1 });
});

test("SSE reports authored authentication errors in the stream and never accepts URL credentials", async (t) => {
  const server = await fixture(t);
  const connectionParams = encodeURIComponent(JSON.stringify({ token: server.token }));
  for (const query of ["", `?connectionParams=${connectionParams}`]) {
    const response = await fetch(`${server.url}/changes${query}`, { headers: { accept: "text/event-stream" } });
    const frames = await response.text();
    const serialized = frames
      .split("\n")
      .find((line) => line.startsWith("data: ") && line.includes("authenticationError"));
    assert.ok(serialized, frames);
    assert.match(frames, /event: serialized-error/);
    assert.partialDeepStrictEqual(JSON.parse(serialized.slice(6)), {
      data: { code: "UNAUTHORIZED", authenticationError: { type: "ActorAuthenticationError" } },
    });
  }
  assert.deepEqual(server.counts(), { authentications: 0, executions: 0, admissions: 0 });
});
