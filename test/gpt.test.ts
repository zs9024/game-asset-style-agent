import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { startJob, type AgentEvent } from "../src/agent/index.js";
import { config } from "../src/config.js";
import * as store from "../src/store/index.js";
import { solidPng, useTempDataDir, validStyleGuide } from "./helpers.js";

const dataDir = useTempDataDir();
const originalFetch = globalThis.fetch;
type Recorded = { url: string; headers: Headers; body: { input: ResponseInputItem[]; [key: string]: unknown } };
type Turn = { output?: unknown[]; terminalOutput?: unknown[]; streamedOutput?: unknown[]; extraEvents?: object[]; status?: string; code?: string; httpStatus?: number; truncate?: boolean; usage?: unknown; summary?: string };
const requests: Recorded[] = [];
const script: (Turn | ((req: Recorded) => Turn | Promise<Turn>))[] = [];
const events = (data: object) => `data: ${JSON.stringify(data)}\n\n`;
const tokens = { input_tokens: 1000, input_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 30 }, total_tokens: 1100 };
const call = (id: string, name: string, args: unknown) => ({ type: "function_call", id: `fc_${id}`, call_id: id, name, namespace: "game_assets", arguments: JSON.stringify(args), status: "completed" });
const say = (text: string) => ({ type: "message", id: "msg_test", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });
const reasoning = { type: "reasoning", id: "rs_test", summary: [{ type: "summary_text", text: "检查参考配色。" }], encrypted_content: "opaque-encrypted-reasoning" };
after(() => { globalThis.fetch = originalFetch; });
beforeEach(async () => {
  process.env.AGENT_PROVIDER = "gpt";
  process.env.GPT_AUTH_MODE = "api_key";
  process.env.GPT_BASE_URL = "https://api-test.example/v1";
  process.env.OPENAI_API_KEY = "platform-api-secret";
  process.env.OPENAI_ORG_ID = "unrelated-platform-org";
  process.env.OPENAI_PROJECT_ID = "unrelated-platform-project";
  process.env.GPT_MODEL = "gpt-6.1-sol";
  delete process.env.GPT_EFFORT;
  delete process.env.GPT_PRICE;
  delete process.env.AGENT_MAX_TURNS;
  delete process.env.AGENT_MODE;
  requests.length = 0;
  script.length = 0;
  await fs.mkdir(path.join(dataDir, "auth"), { recursive: true });
  await fs.writeFile(path.join(dataDir, "auth/chatgpt.json"), JSON.stringify({
    hostId: "urn:uuid:test", activeAccountId: "oaiapp_test", accounts: [{ clientId: "oaiapp_test", subject: "user_test", email: "artist@example.com",
      accessToken: "subscription-access-secret", refreshToken: "refresh-secret", expiresAt: Date.now() + 3600_000, scopes: ["chatgpt.tokens.use.direct"] }],
  }));
  globalThis.fetch = async (input, init) => {
    const request: Recorded = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
    requests.push(request);
    const next = script.shift();
    assert.ok(next, "unexpected additional request");
    const turn = typeof next === "function" ? await next(request) : next;
    if (turn.httpStatus) return new Response(JSON.stringify({ error: { code: turn.code, message: turn.code } }), {
      status: turn.httpStatus, headers: { "content-type": "application/json", "x-should-retry": "false" },
    });
    const output = turn.output ?? [];
    let body = "";
    for (const item of output) {
      const message = item as { type: string; content?: { type: string; text: string }[] };
      if (message.type === "message") for (const part of message.content ?? []) if (part.type === "output_text") {
        body += events({ type: "response.output_text.delta", delta: part.text });
      }
    }
    for (const [index, item] of (turn.streamedOutput ?? output).entries()) {
      body += events({ type: "response.output_item.done", output_index: index, item });
    }
    for (const event of turn.extraEvents ?? []) body += events(event);
    if (turn.summary) body += events({ type: "response.reasoning_summary_text.done", text: turn.summary });
    if (!turn.truncate) body += events({ type: `response.${turn.status ?? "completed"}`, response: {
      id: "resp_test", model: process.env.GPT_MODEL, status: turn.status ?? "completed", output: turn.terminalOutput ?? output, usage: turn.usage ?? tokens,
      error: turn.code ? { code: turn.code, message: turn.code } : null,
      incomplete_details: turn.status === "incomplete" ? { reason: "max_output_tokens" } : null,
    } });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
});

async function project() {
  const p = await store.createProject("GPT flow");
  await store.writeProjectFile(p.id, "refs/ref.png", await solidPng(32, 32, "#aabbcc"));
  await store.updateProject(p.id, (q) => void q.refs.push({ id: "ref_1", file: "refs/ref.png", mime: "image/png", originalName: "ref.png" }));
  return p.id;
}
function run(projectId: string, extra = {}) {
  const job = startJob({ projectId, request: "制作图标", assetTypes: ["item_icon"], providerId: "mock", continueConversation: true, ...extra });
  return new Promise<typeof job>((resolve) => { job.listeners.add((event) => event.type === "done" && resolve(job)); });
}
const errors = (job: { events: AgentEvent[] }) => job.events.filter((e) => e.type === "error");

describe("GPT Responses agent in both billing modes", () => {
  it("continues commentary and executes tools recovered from empty terminal outputs", async () => {
    process.env.GPT_AUTH_MODE = "chatgpt";
    const id = await project();
    const preamble = { ...say("我会生成一张夜晚下雨环境的图。"), phase: "commentary" };
    script.push(
      { output: [reasoning, preamble], terminalOutput: [] },
      (req) => {
        assert.deepEqual(req.body.input.at(-1), preamble, "the exact commentary phase must be replayed");
        return { output: [call("style_sparse", "save_style_guide", validStyleGuide())], terminalOutput: [] };
      },
      { output: [call("gen_sparse", "generate_image", { name: "雨夜", asset_type: "background", prompt: "A cozy treehouse in a rainy night, indigo moonlight, warm amber lanterns", aspect: "portrait", transparent_background: false })], terminalOutput: [] },
      (req) => {
        const result = JSON.stringify(req.body.input.at(-1));
        const assetId = /asset_id=(ast_[\da-f]+)/.exec(result)![1];
        assert.match(result, /input_image/);
        return { output: [call("review_sparse", "review_asset", { asset_id: assetId, verdict: "approved", consistency_score: 9, notes: "雨夜风格一致" })], terminalOutput: [] };
      },
      { output: [{ ...say("已生成并审核雨夜环境图。"), phase: "final_answer" }], terminalOutput: [] },
    );
    const job = await run(id, { request: "继续生成一张夜晚下雨环境的图" });
    assert.deepEqual(errors(job), []);
    assert.equal(requests.length, 5);
    assert.equal(job.usage.images.calls, 1);
    assert.equal((await store.loadProject(id)).assets[0].status, "approved");
    const history = (await store.loadConversation(id))!;
    assert.ok(history.messages.some((item) => (item as { phase?: string }).phase === "commentary"));
    assert.equal((history.messages.at(-1) as { phase: string }).phase, "final_answer");
    assert.ok(job.events.some((event) => event.type === "status" && /执行说明/.test(event.text)));
  });

  it("continues a full commentary-only response and allows a genuine informational final answer", async () => {
    const id = await project();
    script.push({ output: [{ ...say("我先分析配色。"), phase: "commentary" }] }, { output: [{ ...say("参考图主要采用柔和的绿与暖棕。"), phase: "final_answer" }] });
    const job = await run(id, { request: "只解释参考图配色，不生成图片", assetTypes: [] });
    assert.deepEqual(errors(job), []);
    assert.equal(requests.length, 2);
    assert.equal(job.usage.images.calls, 0);
  });

  it("bounds commentary-only continuations and does not mark an unexecuted plan as success", async () => {
    const id = await project();
    script.push(...Array.from({ length: 3 }, () => ({ output: [{ ...say("我会继续生成。"), phase: "commentary" }] })));
    const job = await run(id);
    assert.equal(job.usage.status, "error");
    assert.equal(job.usage.claude.requests, 3);
    assert.equal(job.usage.images.calls, 0);
    assert.match((errors(job)[0] as { message: string }).message, /不会将计划当作生成成功/);
    assert.equal(await store.loadConversation(id), null);
  });

  it("reports delta-only/empty outputs as incomplete rather than saving user-only history", async () => {
    const id = await project();
    script.push({ output: [say("我会生成。")], streamedOutput: [], terminalOutput: [] });
    const job = await run(id);
    assert.equal(job.usage.status, "error");
    assert.match((errors(job)[0] as { message: string }).message, /没有可确认的输出/);
    assert.equal(await store.loadConversation(id), null);
    assert.equal(job.usage.images.calls, 0);
  });

  it("never executes conflicting or duplicate function calls even after a completed stream", async () => {
    const gen = call("conflict", "generate_image", { name: "木剑", asset_type: "item_icon", prompt: "A wooden sword icon with simple outlines", aspect: "square", transparent_background: true });
    for (const output of [[{ ...gen, arguments: "{}" }], [{ ...gen, id: "different_id" }, gen]]) {
      const id = await project();
      script.push(output.length === 1 ? { output, streamedOutput: [gen] } : { output });
      const job = await run(id);
      assert.equal(job.usage.status, "error");
      assert.match((errors(job)[0] as { message: string }).message, /不完整或互相冲突/);
      assert.equal(job.usage.images.calls, 0);
      assert.equal((await store.loadProject(id)).assets.length, 0);
    }
  });

  it("runs vision → style → image → visual review; streams text and persists encrypted reasoning", async () => {
    const id = await project();
    script.push(
      { output: [reasoning, call("style", "save_style_guide", validStyleGuide())], summary: "检查参考配色。" },
      { output: [call("gen", "generate_image", { name: "宝剑", asset_type: "item_icon", prompt: "A sword icon, flat vector style, palette #112233 #aabbcc #ffeedd", aspect: "square", transparent_background: true })] },
      (req) => {
        const result = req.body.input.at(-1) as { type: string; output: { type: string; text?: string; image_url?: string }[] };
        assert.equal(result.type, "function_call_output");
        assert.ok(result.output.some((b) => b.type === "input_image" && b.image_url?.startsWith("data:image/jpeg;base64,")));
        const assetId = /asset_id=(ast_[\da-f]+)/.exec(JSON.stringify(result.output))![1];
        return { output: [call("review", "review_asset", { asset_id: assetId, verdict: "approved", consistency_score: 9, notes: "配色一致" })] };
      },
      { output: [say("完成，已通过审核。")] },
    );
    const job = await run(id);
    assert.deepEqual(errors(job), []);
    assert.equal(job.usage.status, "ok");
    assert.equal(requests[0].url, "https://api-test.example/v1/responses");
    assert.equal(requests[0].headers.get("authorization"), "Bearer platform-api-secret");
    assert.equal(requests[0].headers.get("openai-organization"), null);
    assert.equal(requests[0].headers.get("openai-project"), null);
    const first = requests[0].body;
    assert.equal(first.stream, true);
    assert.equal(first.store, false);
    assert.equal(first.previous_response_id, undefined);
    assert.deepEqual(first.include, ["reasoning.encrypted_content"]);
    assert.deepEqual(first.reasoning, { effort: "medium", summary: "auto" });
    const tool = (first.tools as { type: string; name: string; tools: { name: string; strict: boolean }[] }[])[0];
    assert.equal(tool.type, "namespace");
    assert.equal(tool.name, "game_assets");
    assert.equal(tool.tools.length, 11);
    assert.ok(tool.tools.every((t) => t.strict === false));
    assert.match(JSON.stringify(first.input), /input_image/);
    assert.deepEqual(requests[1].body.input[1], reasoning);
    assert.equal((await store.loadProject(id)).assets[0].status, "approved");
    assert.equal(job.usage.claude.requests, 4);
    assert.equal(job.usage.cost.claude, 0.01068);
    assert.deepEqual(job.usage.agent, { provider: "gpt", model: "gpt-6.1-sol", authMode: "api_key" });
    assert.ok(job.events.some((e) => e.type === "thinking" && e.text === "检查参考配色。"));
    assert.ok(job.events.some((e) => e.type === "text" && e.delta === "完成，已通过审核。"));
    const history = (await store.loadConversation(id))!;
    assert.equal(history.authMode, "api_key");
    assert.doesNotMatch(JSON.stringify(history), /platform-api-secret|subscription-access-secret/);
    script.push({ output: [say("继续。")] });
    const next = await run(id);
    assert.deepEqual(errors(next), []);
    assert.deepEqual(requests[4].body.input.slice(0, history.messages.length), history.messages);
  });

  it("uses only subscription OAuth on the fixed endpoint, resets API history, and avoids Platform cost estimates", async () => {
    const id = await project();
    script.push({ output: [say("API")] });
    await run(id);
    process.env.GPT_AUTH_MODE = "chatgpt";
    process.env.GPT_PRICE = "100,100,100,100";
    script.push({ output: [say("订阅")] });
    const job = await run(id);
    assert.deepEqual(errors(job), []);
    assert.equal(requests[1].url, "https://api.openai.com/v1/responses");
    assert.equal(requests[1].headers.get("authorization"), "Bearer subscription-access-secret");
    assert.equal(requests[1].body.input.length, 1);
    for (const key of ["max_output_tokens", "temperature", "previous_response_id", "conversation", "background", "metadata"]) {
      assert.equal(requests[1].body[key], undefined);
    }
    assert.equal(job.usage.claude.requests, 1);
    assert.equal(job.usage.cost.claude, 0);
    assert.equal(job.usage.agent?.authMode, "chatgpt");
    const history = (await store.loadConversation(id))!;
    assert.equal(history.accountId, "oaiapp_test");
    script.push({ output: [say("继续订阅")] });
    await run(id);
    assert.deepEqual(requests[2].body.input.slice(0, history.messages.length), history.messages);
  });

  for (const status of ["failed", "incomplete", "truncated"] as const) {
    it(`does not execute tools or save history for a ${status} stream`, async () => {
      const id = await project();
      script.push({ output: [call("bad", "save_style_guide", validStyleGuide())], status: status === "truncated" ? undefined : status,
        code: status === "failed" ? "subscription_sharing_usage_limit_exceeded" : undefined, truncate: status === "truncated" });
      const job = await run(id);
      assert.equal(job.usage.status, "error");
      assert.equal(errors(job).length, 1);
      assert.equal((await store.loadProject(id)).styleGuide, null);
      assert.equal(await store.loadConversation(id), null);
      assert.equal(job.usage.claude.requests, status === "truncated" ? 0 : 1);
    });
  }

  it("does not retry failed subscription authorization or fall back to the configured API key", async () => {
    process.env.GPT_AUTH_MODE = "chatgpt";
    script.push({ httpStatus: 401, code: "invalid_token" });
    const job = await run(await project());
    assert.equal(job.usage.status, "error");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers.get("authorization"), "Bearer subscription-access-secret");
  });

  it("reports missing API keys and invalid configuration before a request", async () => {
    delete process.env.OPENAI_API_KEY;
    const job = await run(await project());
    assert.match((errors(job)[0] as { message: string }).message, /OPENAI_API_KEY/);
    assert.equal(requests.length, 0);
    delete process.env.GPT_AUTH_MODE;
    assert.equal(config.gptAuthMode, "api_key");
    process.env.GPT_AUTH_MODE = "typo";
    assert.throws(() => config.gptAuthMode, /GPT_AUTH_MODE/);
    process.env.GPT_EFFORT = "none";
    assert.throws(() => config.effort, /GPT_EFFORT/);
    delete process.env.GPT_MODEL;
    assert.equal(config.model, "gpt-6.1-sol");
  });

  it("returns malformed tool arguments for correction rather than failing the job", async () => {
    const id = await project();
    script.push({ output: [{ ...call("bad_json", "generate_image", {}), arguments: "{truncated" }] }, (req) => {
      assert.match(JSON.stringify(req.body.input.at(-1)), /INVALID_JSON/);
      return { output: [say("重新调整参数。")] };
    });
    const job = await run(id);
    assert.deepEqual(errors(job), []);
    assert.equal(job.usage.images.calls, 0);
  });

  it("enforces image and dollar budgets, and the maximum number of agent turns", async () => {
    const id = await project();
    const gen = (suffix: string) => call(suffix, "generate_image", { name: suffix, asset_type: "item_icon", prompt: "A sword icon with bold dark outlines", aspect: "square", transparent_background: true });
    script.push({ output: [gen("one"), gen("two")] }, (req) => {
      assert.match(JSON.stringify(req.body.input), /BUDGET_EXHAUSTED/);
      return { output: [say("预算用完。")] };
    });
    const limited = await run(id, { budget: { maxImages: 1 } });
    assert.equal(limited.usage.images.calls, 1);
    assert.deepEqual(errors(limited), []);
    script.push({ output: [call("budget", "unknown_tool", {})] });
    const expensive = await run(id, { budget: { maxUsd: 0.001 } });
    assert.ok(expensive.events.some((e) => e.type === "status" && /强制结束/.test(e.text)));
    process.env.AGENT_MAX_TURNS = "1";
    script.push({ output: [call("turn_cap", "unknown_tool", {})] });
    const capped = await run(id);
    assert.ok(capped.events.some((e) => e.type === "status" && /最大轮数 1/.test(e.text)));
  });
});
