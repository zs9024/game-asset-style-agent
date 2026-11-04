import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createLocalJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { config } from "../config.js";
import { msg } from "../i18n.js";
import { createKeyedQueue } from "../store/fs.js";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;
const accountSchema = z.object({
  clientId: z.string().regex(/^oaiapp_[\w-]+$/), subject: z.string(), email: z.string().optional(),
  accessToken: z.string().optional(), refreshToken: z.string().optional(), idToken: z.string().optional(),
  expiresAt: z.number().optional(), scopes: z.array(z.string()),
});
const storeSchema = z.object({ hostId: z.string(), activeAccountId: z.string().optional(), accounts: z.array(accountSchema) });
type Account = z.infer<typeof accountSchema>;
type AuthStore = z.infer<typeof storeSchema>;
interface Tokens { access_token: string; refresh_token?: string; id_token?: string; expires_in: number; scope?: string; token_type: string }
interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; revocation_endpoint: string }
interface Attempt {
  id: string; state: string; nonce: string; verifier: string; redirectUri: string; account?: Account;
  status: "pending" | "complete" | "error"; error?: string; server: http.Server; timer: NodeJS.Timeout; used: boolean;
}

/** Official OSS Sign in with ChatGPT flow. Credentials belong to this app, never to the Codex installation. */
export class ChatGPTAuth {
  private queue = createKeyedQueue();
  private pending?: Attempt;
  private metadata?: Discovery;

  constructor(private options: { directory?: () => string; fetch?: typeof fetch } = {}) {}
  private directory() { return this.options.directory?.() ?? path.join(config.dataDir, "auth"); }
  private file() { return path.join(this.directory(), "chatgpt.json"); }
  private fetch(url: string, init: RequestInit = {}) {
    return (this.options.fetch ?? globalThis.fetch)(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000), redirect: "error" });
  }
  private async load(): Promise<AuthStore> {
    try {
      return storeSchema.parse(JSON.parse(await fs.readFile(this.file(), "utf8")));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { hostId: `urn:uuid:${crypto.randomUUID()}`, accounts: [] };
      throw new Error(msg("err.chatgptLoginFile"));
    }
  }
  private async save(store: AuthStore) {
    await fs.mkdir(this.directory(), { recursive: true, mode: 0o700 });
    const temp = `${this.file()}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(store), { mode: 0o600, flag: "wx" });
      await fs.rename(temp, this.file());
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
  private async discovery() {
    if (!this.metadata) {
      const res = await this.fetch(`${ISSUER}/.well-known/openid-configuration`);
      if (!res.ok) throw new Error(msg("err.chatgptConfigFetch", { status: res.status }));
      const metadata = await res.json() as Discovery;
      if (metadata.issuer !== ISSUER || [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri, metadata.revocation_endpoint]
        .some((url) => !url || new URL(url).origin !== ISSUER)) throw new Error(msg("err.chatgptConfigInvalid"));
      this.metadata = metadata;
    }
    return this.metadata;
  }
  private async exchange(params: Record<string, string>): Promise<Tokens> {
    const metadata = await this.discovery();
    const res = await this.fetch(metadata.token_endpoint, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, resource: RESOURCE }),
    });
    if (!res.ok) throw new Error(msg("err.chatgptAuthFailed", { status: res.status }));
    const tokens = await res.json() as Tokens;
    if (!tokens.access_token || tokens.token_type?.toLowerCase() !== "bearer" || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) {
      throw new Error(msg("err.chatgptResponseInvalid"));
    }
    return tokens;
  }

  async status() {
    const store = await this.load();
    const active = store.accounts.find((a) => a.clientId === store.activeAccountId);
    return {
      activeAccountId: store.activeAccountId,
      connected: !!active?.accessToken,
      planEnabled: !!active?.accessToken && active.scopes.includes(DIRECT_SCOPE),
      accounts: store.accounts.map((a) => ({ id: a.clientId, email: a.email, label: `${a.email ?? a.subject} · ${a.clientId.slice(-8)}`,
        connected: !!a.accessToken, planEnabled: !!a.accessToken && a.scopes.includes(DIRECT_SCOPE) })),
      attempt: this.pending ? { id: this.pending.id, status: this.pending.status, error: this.pending.error } : undefined,
    };
  }

  async startLogin(accountId?: string, includeIdTokenHint = true) {
    return this.queue(this.file(), async () => {
      if (this.pending?.status === "pending") throw new Error(msg("err.chatgptPending"));
      const store = await this.load();
      const account = accountId ? store.accounts.find((a) => a.clientId === accountId) : undefined;
      if (accountId && !account) throw new Error(msg("err.chatgptAccountMissing"));
      await this.save(store); // Persist the host identity before first registration.
      const metadata = await this.discovery();
      const server = http.createServer((req, res) => void this.callback(req, res));
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      server.unref();
      const attempt: Attempt = {
        id: crypto.randomUUID(), state: crypto.randomBytes(32).toString("base64url"), nonce: crypto.randomBytes(32).toString("base64url"),
        verifier: crypto.randomBytes(64).toString("base64url"), redirectUri: `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/callback`,
        account, status: "pending", server, used: false,
        timer: setTimeout(() => this.finish("error", msg("err.chatgptAttemptExpired")), 10 * 60_000).unref(),
      };
      this.pending = attempt;
      const url = new URL(metadata.authorization_endpoint);
      url.search = new URLSearchParams({
        client_id: account?.clientId ?? "dynamic_agent_client", ext_agent_host_id: store.hostId,
        ...(account ? { ...(account.idToken && includeIdTokenHint ? { id_token_hint: account.idToken } : {}), ...(account.email ? { login_hint: account.email } : {}) }
          : { agent_name_hint: "Game Asset Agent" }),
        response_type: "code", redirect_uri: attempt.redirectUri, scope: SCOPES, resource: RESOURCE,
        state: attempt.state, nonce: attempt.nonce, code_challenge_method: "S256",
        code_challenge: crypto.createHash("sha256").update(attempt.verifier).digest("base64url"),
      }).toString();
      return { url: url.toString(), attemptId: attempt.id };
    });
  }

  private finish(status: "complete" | "error", error?: string) {
    if (!this.pending) return;
    this.pending.status = status;
    this.pending.error = error;
    clearTimeout(this.pending.timer);
    this.pending.server.close();
  }
  private async callback(req: http.IncomingMessage, res: http.ServerResponse) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    const attempt = this.pending;
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== "/auth/callback") { res.writeHead(404); res.end("Not found"); return; }
    if (!attempt || attempt.status !== "pending" || attempt.used || url.searchParams.get("state") !== attempt.state) {
      res.writeHead(400); res.end(msg("err.chatgptStateInvalid")); return;
    }
    attempt.used = true; // Consume exactly once before exchanging a code.
    try {
      if (url.searchParams.has("error")) throw new Error(msg("err.chatgptNotAuthorized"));
      const clientId = url.searchParams.get("client_id") ?? attempt.account?.clientId;
      if (!clientId || !/^oaiapp_[\w-]+$/.test(clientId) || (attempt.account && clientId !== attempt.account.clientId)) throw new Error(msg("err.chatgptClientInvalid"));
      const code = url.searchParams.get("code");
      if (!code) throw new Error(msg("err.chatgptNoCode"));
      const tokens = await this.exchange({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri });
      if (!tokens.id_token) throw new Error(msg("err.chatgptNoIdToken"));
      const metadata = await this.discovery();
      const jwksResponse = await this.fetch(metadata.jwks_uri);
      if (!jwksResponse.ok) throw new Error(msg("err.chatgptVerify"));
      const keys = createLocalJWKSet(await jwksResponse.json());
      const { payload } = await jwtVerify(tokens.id_token, keys, { issuer: metadata.issuer, audience: clientId, algorithms: ["RS256", "ES256"], requiredClaims: ["sub", "exp", "iat", "nonce"] });
      if (payload.nonce !== attempt.nonce || !payload.sub || (attempt.account && payload.sub !== attempt.account.subject)) throw new Error(msg("err.chatgptIdentityMismatch"));
      await this.queue(this.file(), async () => {
        if (this.pending !== attempt || attempt.status !== "pending") throw new Error(msg("err.chatgptCancelled"));
        const store = await this.load();
        const previous = store.accounts.find((a) => a.clientId === clientId);
        if (previous && previous.subject !== payload.sub) throw new Error(msg("err.chatgptIdentityMismatch"));
        const account: Account = { clientId, subject: payload.sub!, email: typeof payload.email === "string" ? payload.email : undefined,
          accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token,
          expiresAt: Date.now() + tokens.expires_in * 1000, scopes: (tokens.scope ?? "").split(/\s+/).filter(Boolean) };
        store.accounts = [...store.accounts.filter((a) => a.clientId !== clientId), account];
        store.activeAccountId = clientId;
        await this.save(store);
      });
      this.finish("complete");
      res.end(msg("chatgpt.pageDone"));
    } catch {
      // Do not reflect provider responses, codes or JWT payloads in browser/API errors.
      this.finish("error", msg("err.chatgptLoginFailed"));
      res.writeHead(400); res.end(msg("chatgpt.pageFailed"));
    }
  }

  async selectAccount(accountId: string) {
    return this.queue(this.file(), async () => {
      const store = await this.load();
      if (!store.accounts.some((a) => a.clientId === accountId)) throw new Error(msg("err.chatgptAccountMissing"));
      if (this.pending?.status === "pending") this.finish("error", msg("err.chatgptSwitchCancelled"));
      store.activeAccountId = accountId;
      await this.save(store);
    });
  }

  async credential(expectedAccountId?: string) {
    return this.queue(this.file(), async () => {
      const store = await this.load();
      const account = store.accounts.find((a) => a.clientId === store.activeAccountId);
      if (!account?.accessToken) throw new Error(msg("err.chatgptLoginFirst"));
      if (expectedAccountId && account.clientId !== expectedAccountId) throw new Error(msg("err.chatgptAccountSwitched"));
      if (!account.scopes.includes(DIRECT_SCOPE)) throw new Error(msg("err.chatgptScopeMissing"));
      if (!account.expiresAt || account.expiresAt <= Date.now() + 60_000) {
        if (!account.refreshToken) throw new Error(msg("err.chatgptExpired"));
        const tokens = await this.exchange({ grant_type: "refresh_token", client_id: account.clientId, refresh_token: account.refreshToken });
        if (!tokens.refresh_token) throw new Error(msg("err.chatgptNoRefresh"));
        account.accessToken = tokens.access_token;
        account.refreshToken = tokens.refresh_token;
        account.expiresAt = Date.now() + tokens.expires_in * 1000;
        if (tokens.scope !== undefined) account.scopes = tokens.scope.split(/\s+/).filter(Boolean);
        await this.save(store);
        if (!account.scopes.includes(DIRECT_SCOPE)) throw new Error(msg("err.chatgptScopeRevoked"));
      }
      return { accessToken: account.accessToken, accountId: account.clientId };
    });
  }

  async models() {
    const { accessToken } = await this.credential();
    const res = await this.fetch(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(msg("err.chatgptModelsFetch", { status: res.status }));
    const result = await res.json() as { models?: { slug: string; display_name: string; visibility: string }[] };
    if (!Array.isArray(result.models)) throw new Error(msg("err.chatgptModelsInvalid"));
    return result.models.filter((m) => m.visibility === "list").map((m) => ({ id: m.slug, name: m.display_name }));
  }

  async logout(accountId: string) {
    return this.queue(this.file(), async () => {
      const store = await this.load();
      const account = store.accounts.find((a) => a.clientId === accountId);
      if (!account) throw new Error(msg("err.chatgptAccountMissing"));
      if (this.pending?.status === "pending") this.finish("error", msg("err.chatgptLogoutCancelled"));
      let revoked = !account.refreshToken;
      if (account.refreshToken) {
        try {
          const metadata = await this.discovery();
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const res = await this.fetch(metadata.revocation_endpoint, { method: "POST", signal: AbortSignal.timeout(10_000), headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ token: account.refreshToken, token_type_hint: "refresh_token", client_id: account.clientId }) });
              revoked = res.ok;
              if (revoked || res.status < 500) break;
            } catch { /* Retry transient failures before discarding the renewable session. */ }
            if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
          }
        } catch { /* Clear local tokens even when remote revocation cannot be confirmed. */ }
      }
      delete account.accessToken; delete account.refreshToken; delete account.idToken; delete account.expiresAt;
      account.scopes = [];
      await this.save(store);
      return { revoked, message: revoked ? msg("chatgpt.loggedOut") : msg("chatgpt.loggedOutLocal") };
    });
  }

  /** Called on shutdown/tests to close the local callback listener. */
  close() { if (this.pending?.status === "pending") this.finish("error", msg("err.chatgptCancelled")); }
}

export const chatGPTAuth = new ChatGPTAuth();
