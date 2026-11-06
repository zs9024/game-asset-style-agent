import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { ChatGPTAuth } from "../src/openai/chatgpt.js";
import { useTempDataDir } from "./helpers.js";

const dataDir = useTempDataDir();
const services: ChatGPTAuth[] = [];
afterEach(() => services.splice(0).forEach((auth) => auth.close()));
const keys = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(keys.publicKey), kid: "test-key", alg: "RS256", use: "sig" };
const discovery = {
  issuer: "https://auth.openai.com", authorization_endpoint: "https://auth.openai.com/api/accounts/authorize",
  token_endpoint: "https://auth.openai.com/api/accounts/oauth/token", jwks_uri: "https://auth.openai.com/.well-known/jwks.json",
  revocation_endpoint: "https://auth.openai.com/oauth/revoke",
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function fixture() {
  const directory = path.join(dataDir, crypto.randomUUID());
  const requests: { url: string; init?: RequestInit }[] = [];
  let nonce = "";
  let clientId = "oaiapp_account1";
  let subject = "user_1";
  let scope = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
  let exp = 3600;
  let issuer = discovery.issuer;
  let audience: string | undefined;
  let wrongSignature = false;
  let revokeFails = false;
  let invalidTokens = false;
  let refreshes = 0;
  const auth = new ChatGPTAuth({ directory: () => directory, fetch: async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("openid-configuration")) return json(discovery);
    if (url.endsWith("jwks.json")) return json({ keys: [jwk] });
    if (url.endsWith("/models")) return json({ models: [
      { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" },
      { slug: "hidden", display_name: "Internal", visibility: "hidden" },
    ] });
    if (url === discovery.revocation_endpoint) {
      if (revokeFails) throw new Error("offline");
      return new Response(null, { status: 200 });
    }
    assert.equal(url, discovery.token_endpoint);
    const params = new URLSearchParams(String(init?.body));
    assert.equal(params.get("resource"), "https://api.openai.com/v1");
    if (params.get("grant_type") === "refresh_token") {
      refreshes++;
      assert.equal(params.get("scope"), null);
      return json({ access_token: `access-refreshed-${refreshes}`, refresh_token: `refresh-${refreshes}`, expires_in: 3600, token_type: "Bearer", scope });
    }
    assert.equal(params.get("client_id"), clientId);
    const idToken = await new SignJWT({ nonce, email: "artist@example.com" }).setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer).setAudience(audience ?? clientId).setSubject(subject).setIssuedAt().setExpirationTime(exp < 0 ? "-1s" : "1h")
      .sign(wrongSignature ? (await generateKeyPair("RS256")).privateKey : keys.privateKey);
    return json({ access_token: invalidTokens ? "" : "access-secret", refresh_token: "refresh-secret", id_token: idToken, expires_in: 3600, token_type: "Bearer", scope });
  } });
  services.push(auth);
  return {
    auth, requests, directory, get refreshes() { return refreshes; },
    setScope: (value: string) => { scope = value; }, setSubject: (value: string) => { subject = value; },
    setIssuer: (value: string) => { issuer = value; }, setAudience: (value: string) => { audience = value; },
    setNonce: (value: string) => { nonce = value; }, expireJwt: () => { exp = -1; },
    wrongSignature: () => { wrongSignature = true; }, revokeFails: () => { revokeFails = true; }, invalidTokens: () => { invalidTokens = true; },
    async start(accountId?: string) {
      const result = await auth.startLogin(accountId);
      const url = new URL(result.url);
      nonce = url.searchParams.get("nonce")!;
      return { ...result, url, callback: new URL(url.searchParams.get("redirect_uri")!), state: url.searchParams.get("state")! };
    },
    async complete(attempt: { callback: URL; state: string }, extras: Record<string, string> = {}) {
      const callback = new URL(attempt.callback);
      callback.search = new URLSearchParams({ state: attempt.state, code: "authorization-code", client_id: clientId, ...extras }).toString();
      return fetch(callback);
    },
    async expireAccess() {
      const file = path.join(directory, "chatgpt.json");
      const store = JSON.parse(await fs.readFile(file, "utf8"));
      store.accounts.find((a: { clientId: string }) => a.clientId === clientId).expiresAt = 1;
      await fs.writeFile(file, JSON.stringify(store));
    },
    nextAccount() { clientId = "oaiapp_account2"; subject = "user_2"; },
  };
}

describe("official ChatGPT subscription OAuth", () => {
  it("explains a pre-authorization discovery 403 and never substitutes unverified metadata", async () => {
    const directory = path.join(dataDir, crypto.randomUUID());
    const auth = new ChatGPTAuth({ directory: () => directory, fetch: async (_input, init) => {
      assert.equal(new Headers(init?.headers).get("Accept"), "application/json");
      return new Response("<html>denied</html>", { status: 403, headers: { server: "cloudflare", "content-type": "text/html" } });
    } });
    services.push(auth);
    await assert.rejects(auth.startLogin(), /HTTP 403.*HTTP_PROXY \/ HTTPS_PROXY/);
    assert.equal((await auth.status()).connected, false);
  });
  it("registers with PKCE, rejects forged state, validates identity and never exposes tokens in status", async () => {
    const f = await fixture();
    const attempt = await f.start();
    assert.equal(attempt.url.origin, "https://auth.openai.com");
    assert.equal(attempt.url.searchParams.get("client_id"), "dynamic_agent_client");
    assert.equal(attempt.url.searchParams.get("agent_name_hint"), "Game Asset Agent");
    assert.equal(attempt.callback.hostname, "127.0.0.1");
    assert.equal(attempt.callback.pathname, "/auth/callback");
    assert.match(attempt.url.searchParams.get("ext_agent_host_id")!, /^urn:uuid:/);
    const forged = await f.complete(attempt, { state: "forged" });
    assert.equal(forged.status, 400);
    assert.equal(f.requests.filter((r) => r.url === discovery.token_endpoint).length, 0);
    assert.equal((await f.complete(attempt)).status, 200);
    const exchange = f.requests.find((r) => r.url === discovery.token_endpoint)!;
    const params = new URLSearchParams(String(exchange.init?.body));
    assert.equal(params.get("redirect_uri"), attempt.callback.toString());
    assert.equal(crypto.createHash("sha256").update(params.get("code_verifier")!).digest("base64url"), attempt.url.searchParams.get("code_challenge"));
    assert.equal(params.get("client_secret"), null);
    const status = await f.auth.status();
    assert.equal(status.connected, true);
    assert.equal(status.planEnabled, true);
    assert.equal(status.accounts[0].email, "artist@example.com");
    assert.doesNotMatch(JSON.stringify(status), /access-secret|refresh-secret|id_token|accessToken|refreshToken/);
    assert.deepEqual(await f.auth.credential(), { accessToken: "access-secret", accountId: "oaiapp_account1" });
    assert.deepEqual(await f.auth.models(), [{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol" }]);
    if (process.platform !== "win32") assert.equal((await fs.stat(path.join(f.directory, "chatgpt.json"))).mode & 0o777, 0o600);
    const again = await f.start("oaiapp_account1");
    assert.equal(again.url.searchParams.get("client_id"), "oaiapp_account1");
    assert.equal(again.url.searchParams.get("agent_name_hint"), null);
    assert.equal(again.url.searchParams.get("ext_agent_host_id"), attempt.url.searchParams.get("ext_agent_host_id"));
    assert.ok(again.url.searchParams.get("id_token_hint"));
    assert.equal((await f.complete(again, { client_id: "oaiapp_different" })).status, 400);
    assert.equal((await f.auth.status()).connected, true, "a failed sign-in preserves the active account");
  });

  for (const scenario of ["nonce", "audience", "issuer", "signature", "expired", "tokens"] as const) {
    it(`rejects an invalid ${scenario} before storing credentials`, async () => {
      const f = await fixture();
      const attempt = await f.start();
      if (scenario === "nonce") f.setNonce("forged");
      if (scenario === "audience") f.setAudience("oaiapp_wrong");
      if (scenario === "issuer") f.setIssuer("https://wrong.example");
      if (scenario === "signature") f.wrongSignature();
      if (scenario === "expired") f.expireJwt();
      if (scenario === "tokens") f.invalidTokens();
      assert.equal((await f.complete(attempt)).status, 400);
      assert.equal((await f.auth.status()).connected, false);
      assert.equal((await f.auth.status()).attempt?.status, "error");
      assert.doesNotMatch(await fs.readFile(path.join(f.directory, "chatgpt.json"), "utf8"), /access-secret|refresh-secret/);
    });
  }

  it("checks granted scopes rather than trusting callback scopes, and handles declined consent", async () => {
    const f = await fixture();
    await assert.rejects(f.auth.credential(), /Continue with ChatGPT/);
    await assert.rejects(f.auth.selectAccount("missing"), /不存在/);
    f.setScope("openid email");
    const first = await f.start();
    assert.equal((await f.complete(first, { scope: "chatgpt.tokens.use.direct" })).status, 200);
    assert.equal((await f.auth.status()).planEnabled, false);
    await assert.rejects(f.auth.credential(), /尚未授权/);
    const declined = await f.start();
    assert.equal((await f.complete(declined, { error: "access_denied" })).status, 400);
    assert.equal((await f.auth.status()).accounts.length, 1);
  });

  it("rotates refresh tokens once under concurrent requests and preserves separate account registrations", async () => {
    const f = await fixture();
    await f.complete(await f.start());
    await f.expireAccess();
    const tokens = await Promise.all([f.auth.credential(), f.auth.credential(), f.auth.credential()]);
    assert.equal(f.refreshes, 1);
    assert.ok(tokens.every((t) => t.accessToken === "access-refreshed-1"));
    f.nextAccount();
    await f.complete(await f.start());
    assert.equal((await f.auth.status()).accounts.length, 2);
    await assert.rejects(f.auth.credential("oaiapp_account1"), /账号已切换/);
    await f.auth.selectAccount("oaiapp_account1");
    assert.equal((await f.auth.credential()).accountId, "oaiapp_account1");
    assert.equal((await f.auth.logout("oaiapp_account1")).revoked, true);
    assert.equal((await f.auth.status()).connected, false);
    const revoked = f.requests.find((r) => r.url === discovery.revocation_endpoint)!;
    assert.equal(new URLSearchParams(String(revoked.init?.body)).get("token"), "refresh-1");
    await f.auth.selectAccount("oaiapp_account2");
    f.revokeFails();
    const result = await f.auth.logout("oaiapp_account2");
    assert.equal(result.revoked, false);
    assert.match(result.message, /远程撤销未确认/);
    assert.equal((await f.auth.status()).connected, false);
  });

  it("does not accept a different identity when reauthorizing an existing client", async () => {
    const f = await fixture();
    await f.complete(await f.start());
    const returning = await f.start("oaiapp_account1");
    f.setSubject("another_user");
    assert.equal((await f.complete(returning)).status, 400);
    assert.equal((await f.auth.status()).activeAccountId, "oaiapp_account1");
  });
});
