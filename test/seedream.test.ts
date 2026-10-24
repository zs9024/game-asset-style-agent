import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import sharp from "sharp";
import { createApp } from "../src/app.js";
import { generateAsset } from "../src/agent/assets.js";
import type { Job } from "../src/agent/events.js";
import { shrink } from "../src/image/io.js";
import { seedream, seedreamSize } from "../src/providers/seedream.js";
import { getProvider } from "../src/providers/index.js";
import type { GenerateRequest } from "../src/providers/types.js";
import * as store from "../src/store/index.js";
import { newRunUsage } from "../src/usage/index.js";
import { pixel, solidPng, useTempDataDir, validStyleGuide } from "./helpers.js";
import type { AddressInfo } from "node:net";

useTempDataDir();
const savedEnv = { ...process.env };
const realFetch = globalThis.fetch;
const png = await solidPng(32, 32, "#3366cc");
const json = (body: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const ok = () => json({ data: [{ b64_json: png.toString("base64") }] });
const request = (over: Partial<GenerateRequest> = {}): GenerateRequest => ({ prompt: "A sword icon", references: [], aspect: "square", transparent: false, ...over });
let calls: { url: string; init: RequestInit }[] = [];
function stub(handler: (index: number) => Response) {
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(calls.length);
  };
}
beforeEach(() => {
  process.env = { ...savedEnv, ARK_API_KEY: "ark-test-secret", IMAGE_MAX_RETRIES: "0" };
  delete process.env.ACCESS_TOKEN;
  for (const key of Object.keys(process.env)) if (key.startsWith("SEEDREAM_") || key === "IMAGE_PRICE_SEEDREAM") delete process.env[key];
  calls = [];
});
afterEach(() => { process.env = { ...savedEnv }; globalThis.fetch = realFetch; });

describe("Seedream Flash image provider", () => {
  it("is available with only the Ark key and uses the exact Flash model by default", async () => {
    delete process.env.OPENAI_API_KEY; delete process.env.GEMINI_API_KEY; delete process.env.GOOGLE_API_KEY; delete process.env.SD_WEBUI_URL;
    assert.equal(seedream.available(), true);
    assert.equal(getProvider(undefined).id, "seedream");
    stub(ok);
    const image = await seedream.generate(request());
    assert.ok(image.data.equals(png));
    assert.equal(image.mime, "image/png");
    assert.equal(calls[0].url, "https://ark.cn-beijing.volces.com/api/v3/images/generations");
    assert.equal(new Headers(calls[0].init.headers).get("Authorization"), "Bearer ark-test-secret");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      model: "doubao-seedream-5-0-flash-260915", prompt: "A sword icon", size: "2048x2048", response_format: "b64_json", output_format: "png",
      stream: false, watermark: false, background: "opaque",
    });
    process.env.ARK_API_KEY = " ";
    assert.equal(seedream.available(), false);
    assert.throws(() => getProvider("seedream"), /未配置/);
    await assert.rejects(seedream.generate(request()), /ARK_API_KEY/);
  });

  it("sends up to ten inline references in their original order and reports omitted references", async () => {
    stub(ok);
    const notices: string[] = [];
    const references = Array.from({ length: 12 }, (_, i) => ({ data: Buffer.from(`reference-${i}`), mime: "image/jpeg" }));
    await seedream.generate(request({ references, aspect: "landscape", onNotice: (notice) => notices.push(notice) }));
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.image.length, 10);
    assert.deepEqual(body.image, references.slice(0, 10).map((r) => `data:image/jpeg;base64,${r.data.toString("base64")}`));
    assert.equal(body.size, "2560x1440");
    assert.match(notices[0], /12 张中保留前 10 张/);
    assert.equal(body.n, undefined);
    assert.equal(body.sequential_image_generation, undefined, "Flash does not accept the older models' group-generation options");
  });

  it("requests a flat backdrop for cutout assets and accepts model/base/output settings", async () => {
    process.env.SEEDREAM_MODEL = "custom-endpoint-id";
    process.env.SEEDREAM_BASE_URL = "https://ark-proxy.example/api/v3/";
    process.env.SEEDREAM_SIZE = "1.5K";
    process.env.SEEDREAM_WATERMARK = "true";
    process.env.SEEDREAM_RESPONSE_FORMAT = "url";
    stub(ok);
    await seedream.generate(request({ transparent: true, aspect: "portrait", references: [{ data: png, mime: "image/png" }] }));
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(calls[0].url, "https://ark-proxy.example/api/v3/images/generations");
    assert.equal(body.model, "custom-endpoint-id");
    assert.equal(body.size, "1080x1920");
    assert.equal(body.watermark, true);
    assert.equal(body.response_format, "url");
    assert.equal(body.background, "opaque", "single opaque or multiple reference images cannot use native alpha mode");
    assert.match(body.prompt, /^A sword icon\n\n.*pure-white \(#FFFFFF\)/s);
  });

  it("downloads URL responses immediately without forwarding the Ark key and detects JPEG bytes", async () => {
    const jpeg = await sharp(png).jpeg().toBuffer();
    stub((index) => index === 1 ? json({ data: [{ url: "https://images.example/temporary.png?signature=abc" }] })
      : new Response(new Uint8Array(jpeg), { headers: { "Content-Type": "application/octet-stream" } }));
    const ac = new AbortController();
    const result = await seedream.generate(request(), ac.signal);
    assert.equal(result.mime, "image/jpeg");
    assert.ok(result.data.equals(jpeg));
    assert.equal(calls[1].url, "https://images.example/temporary.png?signature=abc");
    assert.equal(calls[0].init.signal, ac.signal);
    assert.equal(calls[1].init.signal, ac.signal);
    assert.equal(new Headers(calls[1].init.headers).get("Authorization"), null);
    assert.equal(calls.length, 2);
  });

  it("retries downloads without re-submitting a successful generation", async () => {
    process.env.IMAGE_MAX_RETRIES = "1";
    stub((index) => index === 1 ? json({ data: [{ url: "https://images.example/output.png" }] })
      : index === 2 ? new Response("busy", { status: 503, headers: { "retry-after-ms": "1" } })
      : new Response(new Uint8Array(png)));
    const notices: unknown[] = [];
    await seedream.generate(request({ onRetry: (info) => notices.push(info) }));
    assert.equal(calls.filter((c) => c.init.method === "POST").length, 1);
    assert.equal(calls.length, 3);
    assert.deepEqual(notices, [{ attempt: 1, delayMs: 1, reason: "HTTP 503" }]);
  });

  it("retries rate-limited generation requests intact", async () => {
    process.env.IMAGE_MAX_RETRIES = "1";
    stub((index) => index === 1 ? new Response("rate limited", { status: 429, headers: { "retry-after-ms": "1" } }) : ok());
    const retries: unknown[] = [];
    await seedream.generate(request({ onRetry: (info) => retries.push(info) }));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.body, calls[1].init.body);
    assert.deepEqual(retries, [{ attempt: 1, delayMs: 1, reason: "HTTP 429" }]);
  });

  it("rejects invalid configuration before any paid request", async () => {
    stub(ok);
    for (const [key, value] of [["SEEDREAM_SIZE", "4K"], ["SEEDREAM_WATERMARK", "maybe"], ["SEEDREAM_RESPONSE_FORMAT", "png"]]) {
      process.env[key] = value;
      await assert.rejects(seedream.generate(request()), new RegExp(key));
      delete process.env[key];
    }
    assert.equal(calls.length, 0);
  });

  it("reports HTTP, item errors, missing or invalid images and unsupported download protocols", async () => {
    stub(() => new Response("invalid Ark key", { status: 401 }));
    await assert.rejects(seedream.generate(request()), /Seedream HTTP 401/);
    stub(() => json({ data: [{ error: { code: "ContentPolicy", message: "request rejected" } }] }));
    await assert.rejects(seedream.generate(request()), /ContentPolicy.*request rejected/);
    stub(() => json({ error: { message: "quota exceeded" } }));
    await assert.rejects(seedream.generate(request()), /quota exceeded/);
    stub(() => json({ data: [] }));
    await assert.rejects(seedream.generate(request()), /未返回图片/);
    stub(() => json({ data: [{ b64_json: "not-an-image" }] }));
    await assert.rejects(seedream.generate(request()), /图片无效/);
    stub(() => json({ data: [{ url: "file:///etc/passwd" }] }));
    await assert.rejects(seedream.generate(request()), /HTTPS/);
  });

  it("reports failed downloads and handles prefixed Base64 responses", async () => {
    stub((index) => index === 1 ? json({ data: [{ url: "https://images.example/expired" }] }) : new Response("expired", { status: 403 }));
    await assert.rejects(seedream.generate(request()), /Seedream 图片下载 HTTP 403/);
    calls = [];
    stub(() => json({ data: [{ b64_json: `data:image/png;base64,${png.toString("base64")}` }] }));
    assert.ok((await seedream.generate(request())).data.equals(png));
  });
});

describe("Seedream in the project workflow", () => {
  it("is discoverable through config without exposing the Ark key", async () => {
    const server = createApp().listen(0, "127.0.0.1");
    try {
      await new Promise((resolve) => server.once("listening", resolve));
      const res = await realFetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/config`);
      const config = await res.json();
      assert.ok(config.providers.some((p: { id: string; available: boolean }) => p.id === "seedream" && p.available));
      assert.doesNotMatch(JSON.stringify(config), /ark-test-secret/);
    } finally { server.close(); }
  });

  it("prioritizes existing character references, logs reference limits, cuts out and saves the image, and records costs", async () => {
    process.env.IMAGE_PRICE_SEEDREAM = "0.02";
    const project = await store.createProject("Seedream integration");
    const reference = await solidPng(32, 32, "#aabbcc");
    await store.writeProjectFile(project.id, "refs/reference.png", reference);
    await store.writeProjectFile(project.id, "assets/character.png", png);
    await store.updateProject(project.id, (p) => {
      p.styleGuide = validStyleGuide();
      p.refs = Array.from({ length: 8 }, (_, i) => ({ id: `ref_${i}`, file: "refs/reference.png", mime: "image/png", originalName: "reference.png" }));
      p.assets = Array.from({ length: 4 }, (_, i) => ({
        id: `ast_${i}`, name: `角色${i}`, assetType: "character", prompt: "A character", file: "assets/character.png", mime: "image/png",
        status: "approved", runId: "old_run", provider: "mock", createdAt: new Date().toISOString(),
      }));
    });
    const job: Job = { id: "job_seedream", projectId: project.id, events: [], listeners: new Set(), finished: false, abort: new AbortController(),
      usage: newRunUsage("job_seedream", "制作图标", "agent"), budget: { maxImages: 1, maxUsd: 1 } };
    const generated = await sharp(await solidPng(32, 32, "#ffffff")).composite([{ input: await solidPng(16, 16, "#3366cc"), left: 8, top: 8 }]).png().toBuffer();
    stub(() => json({ data: [{ b64_json: generated.toString("base64") }] }));
    const { asset, image } = await generateAsset(job, seedream, {
      name: "角色图标", asset_type: "item_icon", prompt: "A character icon matching the references", aspect: "square", transparent_background: true,
      consistency_asset_ids: ["ast_0", "ast_1", "ast_2", "ast_3"],
    });
    const body = JSON.parse(String(calls[0].init.body));
    const character = await shrink({ data: png, mime: "image/png" }, 1024);
    assert.deepEqual(body.image.slice(0, 4), Array(4).fill(`data:image/jpeg;base64,${character.data.toString("base64")}`));
    assert.equal(body.image.length, 10);
    assert.ok(job.events.some((e) => e.type === "status" && /12 张中保留前 10 张/.test(e.text)));
    assert.equal(asset.provider, "seedream");
    assert.equal(asset.status, "pending_review");
    assert.ok(asset.originalFile);
    assert.ok((await store.readProjectFile(project.id, asset.originalFile)).equals(generated));
    const raw = await sharp(image.data).ensureAlpha().raw().toBuffer();
    assert.equal(raw[3], 0);
    assert.deepEqual(await pixel(image.data, 16, 16), { r: 51, g: 102, b: 204, a: 255 });
    assert.ok((await store.readProjectFile(project.id, asset.file)).equals(image.data));
    assert.equal((await store.loadProject(project.id)).assets.at(-1)?.id, asset.id);
    assert.deepEqual(job.usage.images, { calls: 1, failed: 0, byProvider: { seedream: 1 } });
    assert.equal(job.usage.cost.images, 0.02);
  });
});

describe("Seedream size mapping", () => {
  it("maps aspect presets and keeps every sprite strip within the documented pixel and ratio limits", () => {
    assert.equal(seedreamSize("square", undefined, "1K"), "1024x1024");
    assert.equal(seedreamSize("landscape", undefined, "1K"), "1280x720");
    assert.equal(seedreamSize("portrait", undefined, "2K"), "1440x2560");
    for (const tier of ["1K", "1.5K", "2K"]) for (let frames = 2; frames <= 16; frames++) {
      const [width, height] = seedreamSize("landscape", frames, tier).split("x").map(Number);
      assert.equal(width / height, frames);
      assert.ok(width * height >= 921600 && width * height <= 4624220, `${tier}/${frames}: ${width}x${height}`);
      assert.ok(width / height <= 16);
    }
    assert.throws(() => seedreamSize("square", 1), /帧数/);
    assert.throws(() => seedreamSize("square", 17), /帧数/);
  });
});
