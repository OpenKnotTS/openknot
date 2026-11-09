import * as jose from "jose";
import { once } from "node:events";
import { createServer } from "node:http";
import type { TestContext } from "node:test";

const currentDate = new Date("2026-01-01T00:00:00Z");
const clocks = new WeakSet<TestContext>();

export async function nativeJwt(t: TestContext, subject = "auth0|alice", afterFetch?: () => Promise<void>) {
  if (!clocks.has(t)) {
    t.mock.timers.enable({ apis: ["Date"], now: currentDate });
    clocks.add(t);
  }
  const audience = "https://example.test/api";
  const { publicKey, privateKey } = await jose.generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await jose.exportJWK(publicKey)), alg: "RS256", kid: "one" };
  let status = 200;
  const server = createServer((request, response) => {
    const code = request.url === "/.well-known/jwks.json" ? status : 404;
    response.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify({ keys: [jwk] }));
  });
  server.listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve, reject) => server.close((cause) => (cause ? reject(cause) : resolve()))));
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The JWKS fixture must listen on TCP");
  }
  const local = `http://127.0.0.1:${address.port}`;
  const origin = `https://tenant-${address.port}.auth0.test`;
  const issuer = `${origin}/`;
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (...[input, options]: Parameters<typeof nativeFetch>) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== origin) {
      return nativeFetch(input, options);
    }
    const response = await nativeFetch(new URL(url.pathname, local), options);
    await afterFetch?.();
    return response;
  });
  const token = await new jose.SignJWT({
    iss: issuer,
    aud: audience,
    sub: subject,
    exp: currentDate.getTime() / 1000 + 600,
  })
    .setProtectedHeader({ alg: "RS256", kid: "one" })
    .sign(privateKey);

  return {
    issuer,
    audience,
    token,
    respond: (value: number) => {
      status = value;
    },
  };
}
