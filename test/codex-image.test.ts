import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { codexImage, codexImageEnvironment } from "../src/providers/codexImage.js";
import { generateAsset } from "../src/agent/assets.js";
import type { Job } from "../src/agent/events.js";
import { getProvider } from "../src/providers/index.js";
import type { GenerateRequest } from "../src/providers/types.js";
import * as store from "../src/store/index.js";
import { newRunUsage } from "../src/usage/index.js";
import { uploadHandoff } from "../src/handoff/service.js";
import { solidPng, useTempDataDir } from "./helpers.js";

const dataDir = useTempDataDir();
const savedEnv = { ...process.env };
const realFetch = globalThis.fetch;
const fixtureDir = path.join(dataDir, "fake-cli");
const launcher = path.join(fixtureDir, "fake-codex.cjs");
const logFile = path.join(fixtureDir, "calls.jsonl");
const settingsFile = path.join(fixtureDir, "settings.json");
const png = await solidPng(32, 32, "#3366cc");
await fs.mkdir(fixtureDir, { recursive: true });
await fs.writeFile(launcher, `
const fs = require('node:fs');
const path = require('node:path');
const settings = JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8'));
const args = process.argv.slice(2);
const login = args.includes('login');
const log = (extra) => fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({ args, cwd: process.cwd(), at: Date.now(), ...extra }) + '\\n');
if (login) {
  log({ phase: 'login' });
  console.log(settings.mode === 'logged-out' ? 'Not logged in' : settings.mode === 'api-auth' ? 'Logged in using API key' : 'Logged in using ChatGPT');
  process.exit(settings.mode === 'logged-out' ? 1 : 0);
}
log({ phase: 'start', credentials: { openai: process.env.OPENAI_API_KEY, ark: process.env.ARK_API_KEY, token: process.env.ACCESS_TOKEN, auth: process.env.ANTHROPIC_AUTH_TOKEN }, home: process.env.CODEX_HOME });
let input = '';
process.stdin.on('data', (chunk) => input += chunk);
process.stdin.on('end', () => setTimeout(() => {
  if (settings.mode === 'exit') process.exit(2);
  if (settings.mode !== 'no-image') fs.writeFileSync('asset.png', settings.mode === 'bad-image' ? 'not an image' : Buffer.from('${png.toString("base64")}', 'base64'));
  log({ phase: 'end', input });
  console.log(JSON.stringify({ type: 'turn.completed' }));
}, settings.delay || 0));
`);
const request = (over: Partial<GenerateRequest> = {}): GenerateRequest => ({ prompt: "A sword icon", references: [{ data: png, mime: "image/png" }], aspect: "square", transparent: true, ...over });
const settings = (mode: string, delay = 0) => fs.writeFile(settingsFile, JSON.stringify({ mode, delay }));
const logs = async () => (await fs.readFile(logFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
beforeEach(async () => {
  process.env = { ...savedEnv, CODEX_IMAGE_BIN: launcher, CODEX_IMAGE_ENABLED: "true", CODEX_IMAGE_TIMEOUT_MS: "5000", CODEX_IMAGE_CONCURRENCY: "1", CODEX_IMAGE_HOME: path.join(dataDir, "selected-cli-profile"),
    OPENAI_API_KEY: "do-not-forward-platform-key", ARK_API_KEY: "do-not-forward-ark-key", ACCESS_TOKEN: "do-not-forward-access-token", ANTHROPIC_AUTH_TOKEN: "do-not-forward-oauth-token" };
  delete process.env.CODEX_IMAGE_VARIANT; delete process.env.CODEX_IMAGE_AUTH_MODE; delete process.env.CODEX_IMAGE_FALLBACK; delete process.env.CODEX_IMAGE_AGENT_MODEL; delete process.env.IMAGE_PROVIDER;
  await fs.writeFile(logFile, ""); await settings("success");
});
afterEach(() => { process.env = { ...savedEnv }; globalThis.fetch = realFetch; });

describe("Codex subscription image bridge", () => {
  it("uses a fixed argv and built-in imagegen prompt, keeps API credentials out, and reads the actual output", async () => {
    process.env.CODEX_IMAGE_AGENT_MODEL = "gpt-6.1-sol";
    const image = await codexImage.generate(request({ prompt: 'A sword with the literal text "$(do not execute)"', frames: 4 }));
    assert.ok(image.data.equals(png));
    assert.equal(image.providerId, "codex_image");
    const records = await logs();
    assert.equal(records.length, 3);
    const start = records.find((r) => r.phase === "start");
    assert.deepEqual(start.credentials, {});
    assert.equal(start.home, process.env.CODEX_IMAGE_HOME);
    assert.ok(start.args.includes('forced_login_method="chatgpt"'));
    assert.ok(start.args.includes("--ignore-user-config"));
    assert.ok(start.args.includes("workspace-write"));
    assert.ok(start.args.includes("image_generation"));
    assert.ok(start.args.includes("--image"));
    assert.ok(start.args.includes("gpt-6.1-sol"));
    assert.ok(!start.args.includes("--dangerously-bypass-approvals-and-sandbox"));
    const end = records.find((r) => r.phase === "end");
    assert.match(end.input, /\$imagegen/);
    assert.match(end.input, /\$\(do not execute\)/);
    assert.match(end.input, /"frames_in_one_horizontal_row": 4/);
    assert.equal(await fs.stat(start.cwd).then(() => true, () => false), false, "only the per-call workspace is cleaned up");
  });

  it("requires a ChatGPT CLI login and does not fall back by default", async () => {
    for (const mode of ["logged-out", "api-auth"]) {
      await settings(mode); await fs.writeFile(logFile, "");
      await assert.rejects(codexImage.generate(request()), /codex login/);
      assert.equal((await logs()).filter((r) => r.phase === "start").length, 0);
    }
  });

  it("rejects unsupported model forcing and invalid settings without launching a worker", async () => {
    process.env.CODEX_IMAGE_FALLBACK = "seedream";
    process.env.CODEX_IMAGE_VARIANT = "sunburst";
    await assert.rejects(codexImage.generate(request()), /Flare \/ Sunburst/);
    delete process.env.CODEX_IMAGE_VARIANT;
    process.env.CODEX_IMAGE_AUTH_MODE = "api_key";
    await assert.rejects(codexImage.generate(request()), /仅支持 chatgpt/);
    delete process.env.CODEX_IMAGE_AUTH_MODE;
    process.env.CODEX_IMAGE_TIMEOUT_MS = "0";
    await assert.rejects(codexImage.generate(request()), /CODEX_IMAGE_TIMEOUT_MS/);
    process.env.CODEX_IMAGE_TIMEOUT_MS = "5000";
    process.env.CODEX_IMAGE_CONCURRENCY = "0";
    await assert.rejects(codexImage.generate(request()), /CODEX_IMAGE_CONCURRENCY/);
    assert.deepEqual(await logs(), []);
  });

  it("does not treat a successful text response or invalid file as a generated image", async () => {
    await settings("no-image");
    await assert.rejects(codexImage.generate(request()), /未保存有效图片/);
    await settings("bad-image");
    await assert.rejects(codexImage.generate(request()), /不是有效图片/);
  });

  it("serializes workers at the configured concurrency", async () => {
    await settings("success", 100);
    await Promise.all([codexImage.generate(request()), codexImage.generate(request())]);
    const phases = (await logs()).filter((r) => r.phase !== "login").map((r) => r.phase);
    assert.deepEqual(phases, ["start", "end", "start", "end"]);
  });

  it("stops timed-out or aborted workers without starting a fallback", async () => {
    await settings("success", 5000);
    process.env.CODEX_IMAGE_TIMEOUT_MS = "500";
    const started = Date.now();
    await assert.rejects(codexImage.generate(request()), { name: "TimeoutError" });
    process.env.CODEX_IMAGE_TIMEOUT_MS = "5000";
    process.env.CODEX_IMAGE_FALLBACK = "seedream";
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 150);
    try { await assert.rejects(codexImage.generate(request(), ac.signal), { name: "AbortError" }); }
    finally { clearTimeout(timer); }
    assert.ok(Date.now() - started < 4000, "cancellation must terminate the worker instead of waiting for it to finish");
  });

  it("uses Seedream only when explicitly configured and attributes the asset/cost to the fallback", async () => {
    await settings("exit"); process.env.CODEX_IMAGE_FALLBACK = "seedream"; process.env.IMAGE_PRICE_SEEDREAM = "0.02";
    process.env.IMAGE_MAX_RETRIES = "0";
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }), { headers: { "Content-Type": "application/json" } });
    const project = await store.createProject("fallback");
    const job: Job = { id: "job_fallback", projectId: project.id, events: [], listeners: new Set(), finished: false, abort: new AbortController(),
      usage: newRunUsage("job_fallback", "", "agent"), budget: { maxImages: 1, maxUsd: 1 } };
    const { asset } = await generateAsset(job, codexImage, { name: "背景", asset_type: "background", prompt: "A forest background with no text", aspect: "square", transparent_background: false });
    assert.equal(asset.provider, "seedream");
    assert.deepEqual(job.usage.images.byProvider, { seedream: 1 });
    assert.equal(job.usage.cost.images, 0.02);
    assert.ok(job.events.some((e) => e.type === "status" && /方舟额度/.test(e.text)));
  });

  it("allows explicitly enabling providers and choosing the default without a Platform API key", () => {
    delete process.env.CODEX_IMAGE_ENABLED;
    assert.equal(codexImage.available(), false);
    process.env.IMAGE_PROVIDER = "codex_image";
    assert.equal(getProvider(undefined).id, "codex_image");
    process.env.IMAGE_PROVIDER = "typo";
    assert.throws(() => getProvider(undefined), /IMAGE_PROVIDER/);
    const env = codexImageEnvironment({ Path: "path", HOME: "home", OPENAI_API_KEY: "secret", CODEX_IMAGE_HOME: "chosen", FOO_SECRET: "hidden" });
    assert.deepEqual(env, { Path: "path", HOME: "home", CODEX_HOME: "chosen" });
  });

  it("can fall back to the human relay explicitly without consuming another API provider", async () => {
    await settings("exit"); process.env.CODEX_IMAGE_FALLBACK = "chatgpt_manual";
    globalThis.fetch = async () => { throw new Error("no API request should occur"); };
    const project = await store.createProject("manual fallback");
    const job: Job = { id: "job_manual_fallback", projectId: project.id, events: [], listeners: new Set(), finished: false, abort: new AbortController(),
      usage: newRunUsage("job_manual_fallback", "", "agent"), budget: { maxImages: 1, maxUsd: 1 } };
    const generation = generateAsset(job, codexImage, { name: "森林背景", asset_type: "background", prompt: "A forest background, no text", aspect: "square", transparent_background: false });
    let taskId = "";
    for (let i = 0; i < 200; i++) {
      const event = job.events.find((e) => e.type === "handoff");
      if (event?.type === "handoff") { taskId = event.handoff.id; break; }
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(taskId);
    await uploadHandoff(project.id, taskId, png);
    const { asset } = await generation;
    assert.equal(asset.provider, "chatgpt_manual");
    assert.equal(asset.handoffId, taskId);
    assert.deepEqual(job.usage.images.byProvider, { chatgpt_manual: 1 });
    assert.equal(job.usage.cost.images, 0);
  });
});
