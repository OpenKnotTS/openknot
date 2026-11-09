import { auth0Resolver } from "../src/index.ts";
import { provideAuth0 } from "../src/wire.ts";
import { audience, jwks } from "./jwks.ts";
import { ActorAuthenticationError } from "@openknot-ts/flow";
import { executionActorResolver } from "@openknot-ts/flow/wire";
import { defineApplication, optional, providePlugs, runApplication, unit } from "@openknot-ts/wire";
import { customFetch, exportJWK, generateKeyPair, SignJWT } from "jose";
import assert from "node:assert/strict";
import { test } from "node:test";

test("native verification discovers the configured JWKS once and maps independently verified identities", async (t) => {
  const keys = await jwks(t);
  const signal = new AbortController().signal;
  let maps = 0;
  const resolve = auth0Resolver({
    issuer: keys.issuer,
    audience,
    mapActor: (claims, options) => {
      maps++;
      assert.equal(options.signal, signal);
      return { externalSubject: claims.sub, tenant: claims["https://airport.example/tenant"] };
    },
  });
  const alice = await keys.sign({ "https://airport.example/tenant": "airport-1" });
  const bob = await keys.sign({ sub: "auth0|bob", "https://airport.example/tenant": "airport-2" });

  assert.deepEqual(await resolve(alice, { signal }), { externalSubject: "auth0|alice", tenant: "airport-1" });
  assert.deepEqual(await resolve(bob, { signal }), { externalSubject: "auth0|bob", tenant: "airport-2" });
  assert.deepEqual(keys.urls, [`${keys.issuer}.well-known/jwks.json`]);
  assert.equal(keys.counts().requests, 1);
  assert.equal(maps, 2);
});

test("native JWKS fetch options and verification constraints reach jose without replacing Auth0 identity policy", async (t) => {
  const keys = await jwks(t);
  let fetched = 0;
  const resolve = auth0Resolver({
    issuer: keys.issuer,
    audience,
    jwks: {
      cacheMaxAge: 60_000,
      cooldownDuration: 1_000,
      timeoutDuration: 2_000,
      [customFetch]: async (url, options) => {
        fetched++;
        return fetch(url, options);
      },
    },
    verification: { subject: "auth0|bob", clockTolerance: 5, requiredClaims: ["tenant"] },
    mapActor: (claims) => claims.sub,
  });
  await assert.rejects(resolve(await keys.sign({ tenant: "one" })), ActorAuthenticationError.is);
  await assert.rejects(resolve(await keys.sign({ sub: "auth0|bob" })), ActorAuthenticationError.is);
  assert.equal(await resolve(await keys.sign({ sub: "auth0|bob", tenant: "one" })), "auth0|bob");
  assert.equal(fetched, 1);
});

test("invalid signatures, claims, algorithms and keys are rejected before actor mapping", async (t) => {
  const keys = await jwks(t);
  const alternative = await generateKeyPair("RS512", { extractable: true });
  keys.respond(200, {
    keys: [keys.publicJwk, { ...(await exportJWK(alternative.publicKey)), kid: "other", alg: "RS512" }],
  });
  const rsa512 = await new SignJWT(keys.claims)
    .setProtectedHeader({ alg: "RS512", kid: "other" })
    .sign(alternative.privateKey);
  let maps = 0;
  const resolve = auth0Resolver({
    issuer: keys.issuer,
    audience,
    mapActor: (claims) => {
      maps++;
      return claims.sub;
    },
  });
  const signed = await keys.sign();
  const altered = signed.slice(0, signed.lastIndexOf(".") + 1) + Buffer.alloc(256).toString("base64url");
  const hmac = await new SignJWT(keys.claims).setProtectedHeader({ alg: "HS256" }).sign(new Uint8Array(32));
  const tokens = [
    ["malformed", "not-a-jwt"],
    ["signature", altered],
    ["issuer", await keys.sign({ iss: "https://other.example/" })],
    ["audience", await keys.sign({ aud: "another-api" })],
    ["expired", await keys.sign({ exp: 0 })],
    ["not-yet-valid", await keys.sign({ nbf: 1_800_000_000 })],
    ["missing-expiration", await keys.sign({ exp: undefined })],
    ["missing-subject", await keys.sign({ sub: undefined })],
    ["empty-subject", await keys.sign({ sub: "" })],
    ["invalid-subject", await keys.sign({ sub: 42 })],
    ["algorithm", hmac],
    ["RSA-algorithm", rsa512],
    ["unknown-key", await keys.sign({}, "unknown")],
    ["empty-token", ""],
  ] as const;
  for (const [name, token] of tokens) {
    await t.test(name, () => assert.rejects(resolve(token), ActorAuthenticationError.is));
  }
  assert.equal(maps, 0);
});

test("JWKS service failures and malformed key sets remain native infrastructure failures", async (t) => {
  for (const [status, body, code] of [
    [503, {}, "ERR_JOSE_GENERIC"],
    [200, { keys: "invalid" }, "ERR_JWKS_INVALID"],
  ] as const) {
    const keys = await jwks(t);
    keys.respond(status, body);
    const resolve = auth0Resolver({ issuer: keys.issuer, audience, mapActor: (claims) => claims.sub });
    await assert.rejects(resolve(await keys.sign()), (cause) => {
      assert.ok(cause instanceof Error && "code" in cause);
      assert.equal(cause.code, code);
      assert.equal(ActorAuthenticationError.is(cause), false);
      return true;
    });
  }
});

test("application mapping errors retain their identity after successful native verification", async (t) => {
  const keys = await jwks(t);
  const failure = new Error("Identity service unavailable");
  const resolve = auth0Resolver({
    issuer: keys.issuer,
    audience,
    mapActor: () => {
      throw failure;
    },
  });
  await assert.rejects(resolve(await keys.sign()), (cause) => cause === failure);
});

test("cancellation before or during JWKS verification skips application mapping", { timeout: 10_000 }, async (t) => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  t.after(() => finish.resolve());
  const keys = await jwks(t, async () => {
    entered.resolve();
    await finish.promise;
  });
  let maps = 0;
  const resolve = auth0Resolver({
    issuer: keys.issuer,
    audience,
    mapActor: (claims) => {
      maps++;
      return claims.sub;
    },
  });
  const token = await keys.sign();
  await assert.rejects(resolve(token, { signal: AbortSignal.abort("before") }), (cause) => cause === "before");
  assert.equal(keys.counts().requests, 0);
  const controller = new AbortController();
  const pending = resolve(token, { signal: controller.signal });
  await entered.promise;
  controller.abort("cancelled");
  finish.resolve();
  await assert.rejects(pending, (cause) => cause === "cancelled");
  assert.equal(maps, 0);
});

test("Auth0 composition is conditional on configuration parents and configures verification once", async (t) => {
  const keys = await jwks(t);
  let configured = 0;
  const settings = unit({ factory: () => ({ issuer: keys.issuer, audience }) });
  const identity = provideAuth0({
    requirements: { settings },
    factory: ({ settings }) => {
      configured++;
      return { ...settings, mapActor: (claims) => ({ subject: claims.sub }) };
    },
  });
  const consume = unit({
    requirements: { resolve: optional(executionActorResolver) },
    factory: ({ resolve }) => resolve,
  });
  const missing = await runApplication(defineApplication({ modules: [identity, providePlugs([consume])] }));
  try {
    assert.equal(missing.resolve(consume), undefined);
    assert.equal(configured, 0);
  } finally {
    await missing.stop();
  }
  const app = await runApplication(defineApplication({ modules: [identity, providePlugs([settings, consume])] }));
  try {
    const resolve = app.resolve(consume);
    assert.ok(resolve);
    assert.deepEqual(await resolve(await keys.sign()), { subject: "auth0|alice" });
    assert.deepEqual(await resolve(await keys.sign({ sub: "auth0|bob" })), { subject: "auth0|bob" });
    assert.equal(configured, 1);
    assert.equal(keys.counts().requests, 1);
  } finally {
    await app.stop();
  }
});
