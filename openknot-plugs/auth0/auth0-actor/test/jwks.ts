import * as jose from "jose";
import { once } from "node:events";
import { createServer } from "node:http";
import type { TestContext } from "node:test";

export const audience = "https://airport.example/api";
const currentDate = new Date("2026-01-01T00:00:00Z");
const clocks = new WeakSet<TestContext>();

export async function jwks(t: TestContext, afterFetch?: () => Promise<void>) {
  if (!clocks.has(t)) {
    t.mock.timers.enable({ apis: ["Date"], now: currentDate });
    clocks.add(t);
  }
  const { publicKey, privateKey } = await jose.generateKeyPair("RS256", { extractable: true });
  const publicJwk = { ...(await jose.exportJWK(publicKey)), kid: "one", alg: "RS256" };
  let body: unknown = { keys: [publicJwk] };
  let status = 200;
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (request.url !== "/.well-known/jwks.json") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
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
  const urls: string[] = [];
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (...[input, options]: Parameters<typeof nativeFetch>) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== origin) {
      return nativeFetch(input, options);
    }
    urls.push(url.href);
    const response = await nativeFetch(new URL(url.pathname, local), options);
    await afterFetch?.();
    return response;
  });
  const claims = { iss: issuer, aud: audience, sub: "auth0|alice", exp: currentDate.getTime() / 1000 + 600 };

  return {
    issuer,
    publicJwk,
    claims,
    sign: (changes: Readonly<Record<string, unknown>> = {}, kid = "one") =>
      new jose.SignJWT({ ...claims, ...changes }).setProtectedHeader({ alg: "RS256", kid }).sign(privateKey),
    urls,
    counts: () => ({ requests }),
    respond: (nextStatus: number, nextBody: unknown = body) => {
      status = nextStatus;
      body = nextBody;
    },
  };
}
