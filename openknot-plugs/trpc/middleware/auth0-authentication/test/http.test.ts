import { auth0Authentication } from "../src/index.ts";
import { fixture } from "./fixture.ts";
import type { Router } from "./fixture.ts";
import { nativeJwt } from "./native-jwt.ts";
import { ActorAuthenticationError } from "@openknot-ts/flow";
import { createTrpcContext } from "@openknot-ts/trpc-context";
import type { TrpcAuthenticationContext } from "@openknot-ts/trpc-context";
import { createTRPCClient, httpBatchLink, httpLink, TRPCClientError } from "@trpc/client";
import { initTRPC, TRPCError } from "@trpc/server";
import assert from "node:assert/strict";
import { test } from "node:test";

test("HTTP forwards only the verified actor and shares verification across a protected batch", async (t) => {
  const server = await fixture(t);
  const client = createTRPCClient<Router>({
    links: [httpBatchLink({ url: server.url, headers: { authorization: `Bearer ${server.token}` } })],
  });

  const actors = await Promise.all([client.me.query(), client.me.query()]);

  assert.deepEqual(actors, [{ userId: "auth0|alice" }, { userId: "auth0|alice" }]);
  assert.deepEqual(server.counts(), { authentications: 1, executions: 2, admissions: 2 });
  const response = await fetch(`${server.url}/me?input=${encodeURIComponent(JSON.stringify({ actor: "forged" }))}`, {
    headers: { authorization: `Bearer ${server.token}`, "x-openknot-actor-id": "forged" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { result: { data: { userId: "auth0|alice" } } });
});

test("missing, malformed and invalid HTTP credentials return the authored error before Flow admission", async (t) => {
  const server = await fixture(t);
  for (const authorization of [undefined, "Basic valid", "Bearer ", "Bearer bad token", "Bearer invalid"]) {
    const response = await fetch(`${server.url}/me`, {
      headers: authorization === undefined ? {} : { authorization },
    });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.partialDeepStrictEqual(body, {
      error: {
        data: {
          code: "UNAUTHORIZED",
          httpStatus: 401,
          authenticationError: {
            type: "ActorAuthenticationError",
            message: "The supplied credentials are invalid",
          },
        },
      },
    });
    assert.equal(JSON.stringify(body).includes("stack"), false);
  }
  assert.deepEqual(server.counts(), { authentications: 0, executions: 0, admissions: 0 });
});

test("the native client recognizes authentication failures while JWKS outages remain server failures", async (t) => {
  const server = await fixture(t);
  for (const [token, status, code, authentication] of [
    ["invalid", 200, "UNAUTHORIZED", true],
    [server.token, 503, "INTERNAL_SERVER_ERROR", false],
  ] as const) {
    server.respond(status);
    const client = createTRPCClient<Router>({
      links: [httpLink({ url: server.url, headers: { authorization: `Bearer ${token}` } })],
    });
    await assert.rejects(client.me.query(), (cause) => {
      assert.ok(cause instanceof TRPCClientError);
      assert.equal(cause.data?.code, code);
      assert.equal(ActorAuthenticationError.is(cause.data?.authenticationError), authentication);
      return true;
    });
  }
  assert.equal(server.counts().admissions, 0);
});

test("public procedures do not verify credentials and middleware instances do not share application identities", async (t) => {
  const alice = await fixture(t);
  const bob = await fixture(t, "auth0|bob");
  const publicResponse = await fetch(`${alice.url}/ping`, { headers: { authorization: "Bearer invalid" } });
  assert.deepEqual(await publicResponse.json(), { result: { data: "public" } });
  assert.equal(alice.counts().authentications, 0);

  for (const [server, userId] of [
    [alice, "auth0|alice"],
    [bob, "auth0|bob"],
  ] as const) {
    const response = await fetch(`${server.url}/me`, { headers: { authorization: `Bearer ${server.token}` } });
    assert.deepEqual(await response.json(), { result: { data: { userId } } });
  }
});

test("cancellation during verification never admits an execution", { timeout: 10_000 }, async (t) => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  t.after(() => finish.resolve());
  const controller = new AbortController();
  const jwt = await nativeJwt(t, "auth0|alice", async () => {
    entered.resolve();
    await finish.promise;
  });
  const authentication = auth0Authentication({
    issuer: jwt.issuer,
    audience: jwt.audience,
    mapActor: (claims) => ({ userId: claims.sub }),
  });
  const trpc = initTRPC.context<TrpcAuthenticationContext>().create();
  let executions = 0;
  const router = trpc.router({
    me: trpc.procedure.use(authentication).query(() => ++executions),
  });
  const context = await createTrpcContext()({
    req: { headers: { authorization: `Bearer ${jwt.token}` } },
    info: { signal: controller.signal },
  });
  const request = router.createCaller(context).me();
  await entered.promise;
  controller.abort("cancelled");
  finish.resolve();

  await assert.rejects(
    request,
    (cause) =>
      cause instanceof TRPCError && cause.code === "CLIENT_CLOSED_REQUEST" && cause.cause?.message === "cancelled",
  );
  assert.equal(executions, 0);
});
