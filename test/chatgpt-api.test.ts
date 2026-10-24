import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { chatGPTAuth } from "../src/openai/chatgpt.js";
import { useTempDataDir } from "./helpers.js";

useTempDataDir();
process.env.ACCESS_TOKEN = "test-owner-token";
process.env.AGENT_PROVIDER = "gpt";
process.env.GPT_AUTH_MODE = "chatgpt";
process.env.GPT_MODEL = "gpt-6.1-sol";
const server = createApp();
let listener: ReturnType<typeof server.listen>;
let base: string;
const originalFetch = globalThis.fetch;
before(async () => {
  listener = server.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "https://auth.openai.com/.well-known/openid-configuration");
    return new Response(JSON.stringify({ issuer: "https://auth.openai.com", authorization_endpoint: "https://auth.openai.com/api/accounts/authorize",
      token_endpoint: "https://auth.openai.com/api/accounts/oauth/token", jwks_uri: "https://auth.openai.com/.well-known/jwks.json", revocation_endpoint: "https://auth.openai.com/oauth/revoke" }), { headers: { "content-type": "application/json" } });
  };
});
afterEach(() => chatGPTAuth.close());
after(() => { globalThis.fetch = originalFetch; listener.close(); });
const request = (route: string, init?: RequestInit) => originalFetch(base + route, {
  ...init, headers: { Authorization: "Bearer test-owner-token", ...init?.headers },
});
const post = (route: string, body: unknown = {}, headers = {}) => request(route, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("local ChatGPT connection HTTP API", () => {
  it("keeps login management behind access-token authentication", async () => {
    assert.equal((await originalFetch(base + "/api/chatgpt/status")).status, 401);
    const status = await request("/api/chatgpt/status");
    assert.equal(status.status, 200);
    assert.equal(status.headers.get("cache-control"), "no-store");
    assert.equal((await status.json()).connected, false);
    const cfg = await (await request("/api/config")).json();
    assert.deepEqual(cfg.agent, { provider: "gpt", model: "gpt-6.1-sol", authMode: "chatgpt" });
  });

  it("rejects forwarded, cross-origin and DNS-rebinding requests", async () => {
    assert.equal((await request("/api/chatgpt/status", { headers: { "X-Forwarded-For": "203.0.113.1" } })).status, 403);
    const rebound = await new Promise<number | undefined>((resolve, reject) => {
      const req = http.get(base + "/api/chatgpt/status", { headers: { Host: "attacker.example", Authorization: "Bearer test-owner-token" } }, (res) => {
        res.resume(); resolve(res.statusCode);
      });
      req.on("error", reject);
    });
    assert.equal(rebound, 403);
    assert.equal((await post("/api/chatgpt/login", {}, { Origin: "https://attacker.example" })).status, 403);
    assert.equal((await post("/api/chatgpt/login", {}, { Origin: "null" })).status, 403);
    assert.equal((await request("/api/chatgpt/login", { method: "POST" })).status, 403);
  });

  it("starts a local OAuth attempt without an API key and exposes only public status", async () => {
    delete process.env.OPENAI_API_KEY;
    const response = await post("/api/chatgpt/login", {}, { Origin: base });
    assert.equal(response.status, 200);
    const login = await response.json();
    assert.equal(new URL(login.url).origin, "https://auth.openai.com");
    assert.equal(new URL(new URL(login.url).searchParams.get("redirect_uri")!).hostname, "127.0.0.1");
    const status = await (await request("/api/chatgpt/status")).json();
    assert.equal(status.attempt.id, login.attemptId);
    assert.equal(status.attempt.status, "pending");
    assert.doesNotMatch(JSON.stringify(status), /code_verifier|nonce|accessToken|refreshToken/);
    const cancel = await post("/api/chatgpt/cancel");
    assert.equal((await cancel.json()).attempt.status, "error");
  });

  it("validates account parameters and requires a login before listing account models", async () => {
    assert.equal((await post("/api/chatgpt/login", { accountId: 42 })).status, 400);
    assert.equal((await post("/api/chatgpt/account")).status, 400);
    assert.equal((await post("/api/chatgpt/logout")).status, 400);
    const models = await request("/api/chatgpt/models");
    assert.equal(models.status, 500);
    assert.match((await models.json()).error, /Continue with ChatGPT/);
  });
});
