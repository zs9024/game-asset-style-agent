import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, beforeEach, describe, it } from "node:test";
import sharp from "sharp";
import { createApp } from "../src/app.js";
import { jobs, startJob } from "../src/agent/index.js";
import { handoffResult, listHandoffs, readHandoff, uploadHandoff, waitForHandoff } from "../src/handoff/service.js";
import { projectDir } from "../src/store/fs.js";
import * as store from "../src/store/index.js";
import { chatgptManual } from "../src/providers/chatgptManual.js";
import { newRunUsage } from "../src/usage/index.js";
import { generateAsset } from "../src/agent/assets.js";
import type { Job } from "../src/agent/events.js";
import { readZip, solidPng, useTempDataDir, validStyleGuide } from "./helpers.js";
import { startFakeAnthropic, type Recorded } from "./fakeAnthropic.js";

useTempDataDir();
const fake = await startFakeAnthropic();
const originalFetch = globalThis.fetch;
const server = createApp().listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const png = await solidPng(32, 32, "#3366cc");
const input = { name: "人工木剑", asset_type: "item_icon" as const, prompt: "A wooden sword icon, flat vector art, matching the reference palette", aspect: "square" as const, transparent_background: true };
beforeEach(() => {
  fake.reset();
  process.env.ANTHROPIC_BASE_URL = fake.url; process.env.ANTHROPIC_API_KEY = "fake-key"; process.env.CLAUDE_MODEL = "claude-opus-5-5";
  process.env.AGENT_PROVIDER = "claude"; process.env.MANUAL_IMAGE_ENABLED = "true"; process.env.MANUAL_IMAGE_TIMEOUT_MS = "60000";
  delete process.env.AGENT_MODE; delete process.env.ACCESS_TOKEN; delete process.env.IMAGE_PROVIDER;
});
after(async () => { for (const job of jobs.values()) if (!job.finished) job.abort.abort(); server.close(); await fake.close(); });
const json = async (url: string, body?: unknown) => {
  const res = await originalFetch(base + url, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { res, body: await res.json().catch(() => null) };
};
const waitUntil = async <T>(fn: () => T | Promise<T>) => {
  for (let i = 0; i < 300; i++) { const value = await fn(); if (value) return value; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("timed out waiting for test state");
};
async function newProject() {
  const project = await store.createProject("Human relay");
  await store.writeProjectFile(project.id, "refs/style.png", png);
  await store.updateProject(project.id, (p) => { p.refs.push({ id: "ref_1", file: "refs/style.png", mime: "image/png", originalName: "style.png" }); p.styleGuide = validStyleGuide(); });
  return project.id;
}
const generateTurn = { content: [{ type: "tool_use" as const, id: "gen_human", name: "generate_image", input }], stop_reason: "tool_use" as const };
const finish = { content: [{ type: "text" as const, text: "人工生成的素材已审核。" }], stop_reason: "end_turn" as const };
function reviewTurn(req: Recorded) {
  const text = JSON.stringify(req.body.messages.at(-1)!.content);
  const assetId = /asset_id[=:](ast_[\da-f]+)/.exec(text)?.[1];
  assert.ok(assetId, text);
  assert.match(text, /image/);
  return { content: [{ type: "tool_use" as const, id: "review_human", name: "review_asset", input: { asset_id: assetId, verdict: "approved", consistency_score: 9, notes: "参考风格一致" } }], stop_reason: "tool_use" as const };
}
async function begin() {
  const projectId = await newProject();
  const { body } = await json(`/api/projects/${projectId}/run`, { request: "制作一个木剑图标", provider: "chatgpt_manual", budget: { maxImages: 1 } });
  const task = await waitUntil(async () => (await listHandoffs(projectId))[0]);
  return { projectId, task, jobId: body.jobId as string, url: `/api/projects/${projectId}/handoffs/${task.id}` };
}
async function upload(url: string, data: Buffer = png) {
  const form = new FormData(); form.append("image", new Blob([new Uint8Array(data)], { type: "image/png" }), "result.png");
  return originalFetch(base + url + "/result", { method: "POST", body: form });
}

describe("ChatGPT human image relay", () => {
  it("exports the exact prompt/references, accepts a real image once, resumes the original agent and records its review", async () => {
    fake.script(generateTurn, reviewTurn, finish);
    const run = await begin();
    assert.equal(run.task.status, "waiting");
    assert.equal(run.task.live, true);
    assert.ok(jobs.get(run.jobId)!.events.some((e) => e.type === "handoff"));
    const archive = await originalFetch(base + run.url + "/package.zip");
    assert.equal(archive.status, 200);
    const entries = readZip(Buffer.from(await archive.arrayBuffer()));
    assert.equal(entries["prompt.txt"].data.toString(), input.prompt);
    assert.ok(entries["references/ref-1.jpg"]);
    assert.equal((await sharp(entries["references/ref-1.jpg"].data).metadata()).format, "jpeg");
    assert.match(entries["README.md"].data.toString(), /ChatGPT/);
    assert.equal(JSON.parse(entries["manifest.json"].data.toString()).id, run.task.id);
    const bad = await upload(run.url, Buffer.from("not-an-image"));
    assert.equal(bad.status, 400);
    assert.equal((await readHandoff(run.projectId, run.task.id)).status, "waiting");
    const responses = await Promise.all([upload(run.url), upload(run.url)]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    const accepted = responses.find((r) => r.status === 200)!;
    assert.equal((await accepted.json()).needsResume, false);
    await waitUntil(() => jobs.get(run.jobId)?.finished);
    const job = jobs.get(run.jobId)!;
    assert.equal(job.usage.status, "ok");
    assert.deepEqual(job.usage.images.byProvider, { chatgpt_manual: 1 });
    assert.equal(job.usage.cost.images, 0);
    const assets = (await store.loadProject(run.projectId)).assets;
    assert.equal(assets.length, 1);
    assert.equal(assets[0].provider, "chatgpt_manual");
    assert.equal(assets[0].status, "approved");
    assert.equal(assets[0].handoffId, run.task.id);
    assert.equal((await readHandoff(run.projectId, run.task.id)).status, "imported");
    fake.script(reviewTurn, finish);
    assert.equal((await json(run.url + "/resume", {})).res.status, 200, "an imported asset may be reviewed again without duplicating it");
    await waitUntil(() => [...jobs.values()].filter((j) => j.projectId === run.projectId).every((j) => j.finished));
    assert.equal((await store.loadProject(run.projectId)).assets.length, 1);
  });

  it("keeps exported work after stopping, then imports the upload and starts a fresh visual review", async () => {
    fake.script(generateTurn);
    const run = await begin();
    const cancelled = await json(run.url + "/cancel", {});
    assert.equal(cancelled.res.status, 200);
    await waitUntil(() => jobs.get(run.jobId)?.finished);
    assert.equal(jobs.get(run.jobId)!.usage.status, "stopped");
    assert.equal((await listHandoffs(run.projectId))[0].live, false);
    assert.equal((await originalFetch(base + run.url + "/package.zip")).status, 200);
    const response = await upload(run.url);
    assert.equal((await response.json()).needsResume, true);
    fake.script(reviewTurn, finish);
    const resume = await json(run.url + "/resume", {});
    assert.equal(resume.res.status, 200);
    await waitUntil(() => jobs.get(resume.body.jobId)?.finished);
    assert.equal(jobs.get(resume.body.jobId)!.usage.status, "ok");
    const asset = (await store.loadProject(run.projectId)).assets[0];
    assert.equal(asset.status, "approved");
    assert.equal(asset.handoffId, run.task.id);
    assert.match(JSON.stringify(fake.requests.at(-2)!.body.messages), /Human-generated asset to REVIEW/);
  });

  it("handles timeout and abort without losing packages, and validates paths and upload state", async () => {
    const projectId = await newProject();
    process.env.MANUAL_IMAGE_TIMEOUT_MS = "100";
    let taskId = "";
    const pending = waitForHandoff({ prompt: input.prompt, references: [{ data: png, mime: "image/png" }], aspect: "square", transparent: true,
      context: { projectId, jobId: "job_timeout", input }, onHandoff: (task) => { taskId = task.id; } });
    await assert.rejects(pending, /超时/);
    await waitUntil(async () => (await readHandoff(projectId, taskId)).status === "expired");
    await assert.rejects(handoffResult(projectId, taskId), /先上传/);
    const result = await uploadHandoff(projectId, taskId, png);
    assert.equal(result.needsResume, true);
    assert.ok((await handoffResult(projectId, taskId)).data.length);
    await assert.rejects(uploadHandoff(projectId, taskId, png), /重复提交/);
    await assert.rejects(readHandoff(projectId, "../outside"), /不存在/);
    const another = await newProject();
    assert.equal((await json(`/api/projects/${another}/handoffs/${taskId}/resume`, {})).res.status, 404);
    const recordFile = path.join(projectDir(projectId), "handoffs", taskId, "request.json");
    const record = JSON.parse(await fs.readFile(recordFile, "utf8")); record.referenceFiles = ["../../outside.png"];
    await fs.writeFile(recordFile, JSON.stringify(record));
    await assert.rejects(readHandoff(projectId, taskId), /无效/);
    const ac = new AbortController(); ac.abort();
    await assert.rejects(waitForHandoff({ prompt: "x", references: [], aspect: "square", transparent: false }, ac.signal), { name: "AbortError" });
    await assert.rejects(waitForHandoff({ prompt: "x", references: [], aspect: "square", transparent: false }), /任务上下文/);
  });

  it("shows the handoff provider in config and resumes a cancelled result without an Agent in demo mode", async () => {
    assert.equal((await json("/api/config")).body.providers.find((p: { id: string }) => p.id === "chatgpt_manual").available, true);
    const projectId = await newProject();
    const ac = new AbortController(); let taskId = "";
    const job: Job = { id: "job_direct", projectId, events: [], listeners: new Set(), finished: false, abort: ac,
      usage: newRunUsage("job_direct", "", "agent"), budget: { maxImages: 1, maxUsd: null } };
    const generate = generateAsset(job, { ...chatgptManual, generate: (req, signal) => chatgptManual.generate({ ...req, onHandoff: (task) => { taskId = task.id; req.onHandoff?.(task); } }, signal) }, input);
    const failed = assert.rejects(generate, /取消/);
    await waitUntil(() => taskId); ac.abort(); await failed;
    await uploadHandoff(projectId, taskId, png);
    process.env.AGENT_MODE = "demo";
    const resumed = startJob({ projectId, request: "resume", assetTypes: [], handoffResume: { taskId }, budget: { maxImages: 1 } });
    await waitUntil(() => resumed.finished);
    assert.equal(resumed.usage.status, "ok");
    assert.equal((await store.loadProject(projectId)).assets[0].status, "pending_review");
    assert.equal(fake.requests.length, 0);
  });
});
