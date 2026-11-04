import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addImageCall, addTokens, computeCost, imagePrice, modelPrice, newRunUsage, summarize, totalTokens } from "../src/usage/index.js";

describe("modelPrice", () => {
  it("prices GPT independently of Claude and DeepSeek overrides", () => {
    assert.deepEqual(modelPrice("gpt-6.1-sol", { CLAUDE_PRICE: "99,99,99,99", DEEPSEEK_PRICE: "88,88,88,88" }), { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 });
    assert.equal(modelPrice("gpt-6.1-sol-2026-10-01", {})?.input, 2);
    assert.deepEqual(modelPrice("gpt-custom", { GPT_PRICE: "1,2,1.25,0.1" }), { input: 1, output: 2, cacheWrite: 1.25, cacheRead: 0.1 });
    assert.equal(modelPrice("gpt-custom", {}), null);
  });
  it("prices DeepSeek Flash aliases and isolates service-specific overrides", () => {
    for (const model of ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4.1-flash-1017"]) {
      assert.deepEqual(modelPrice(model, { CLAUDE_PRICE: "10,20,30,40" }), { input: 0.3, output: 1.2, cacheWrite: 0.3, cacheRead: 0.006 });
    }
    assert.deepEqual(modelPrice("deepseek-flash", { DEEPSEEK_PRICE: "0.15,0.6,0.15,0.003" }), { input: 0.15, output: 0.6, cacheWrite: 0.15, cacheRead: 0.003 });
    assert.equal(modelPrice("deepseek-flash", { DEEPSEEK_PRICE: "bad" })?.input, 0.3);
    assert.equal(modelPrice("claude-opus-5-5", { DEEPSEEK_PRICE: "1,2,3,4" })?.input, 4);
    assert.equal(modelPrice("deepseek-unknown", {}), null);
  });

  it("matches the most specific model family first", () => {
    assert.equal(modelPrice("claude-opus-5-5", {})?.input, 4);
    assert.equal(modelPrice("claude-opus-5", {})?.input, 5);
    assert.equal(modelPrice("claude-fable-5-1", {})?.cacheRead, 0.25);
    assert.equal(modelPrice("claude-fable-5", {})?.cacheRead, 1);
    assert.equal(modelPrice("claude-haiku-5-5", {})?.output, 0.5);
    assert.equal(modelPrice("claude-sonnet-4-5", {})?.input, 3);
  });

  it("returns null for unknown models", () => {
    assert.equal(modelPrice("some-other-model", {}), null);
  });

  it("CLAUDE_PRICE overrides every model, and is ignored when malformed", () => {
    assert.deepEqual(modelPrice("x", { CLAUDE_PRICE: "1,2,3,4" }), { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 });
    assert.equal(modelPrice("claude-opus-5-5", { CLAUDE_PRICE: "1,2,3" })?.input, 4);
    assert.equal(modelPrice("claude-opus-5-5", { CLAUDE_PRICE: "a,b,c,d" })?.input, 4);
  });
});

describe("imagePrice", () => {
  it("mock is free; others come from IMAGE_PRICE_<ID>", () => {
    assert.equal(imagePrice("mock", {}), 0);
    assert.equal(imagePrice("sdwebui", {}), 0, "local SD is free unless priced");
    assert.equal(imagePrice("sdwebui", { IMAGE_PRICE_SDWEBUI: "0.002" }), 0.002);
    assert.equal(imagePrice("openai", {}), null);
    assert.equal(imagePrice("openai", { IMAGE_PRICE_OPENAI: "0.17" }), 0.17);
    assert.equal(imagePrice("gemini", { IMAGE_PRICE_GEMINI: " " }), null);
    assert.equal(imagePrice("gemini", { IMAGE_PRICE_GEMINI: "-1" }), null);
    assert.equal(imagePrice("seedream", {}), null);
    assert.equal(imagePrice("seedream", { IMAGE_PRICE_SEEDREAM: "0.02" }), 0.02);
    assert.equal(imagePrice("codex_image", { IMAGE_PRICE_CODEX_IMAGE: "100" }), 0, "subscription generations are not priced as Platform API images");
    assert.equal(imagePrice("chatgpt_manual", {}), 0);
  });
});

describe("run usage", () => {
  it("tracks ChatGPT subscription tokens without charging Platform token prices, while still charging images", () => {
    const run = newRunUsage("job_sub", "req", "agent");
    run.agent = { provider: "gpt", model: "gpt-6.1-sol", authMode: "chatgpt" };
    addTokens(run, "gpt-6.1-sol", { input_tokens: 1_000_000, output_tokens: 100_000 });
    addImageCall(run, "openai", true);
    assert.equal(run.claude.requests, 1);
    assert.equal(totalTokens(run).input_tokens, 1_000_000);
    assert.deepEqual(computeCost(run, { IMAGE_PRICE_OPENAI: "0.04", GPT_PRICE: "100,100,100,100" }), { claude: 0, images: 0.04, total: 0.04 });
  });
  it("accumulates tokens per model and prices them", () => {
    const run = newRunUsage("job_1", "req", "agent");
    addTokens(run, "claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 100_000, cache_creation_input_tokens: null, cache_read_input_tokens: 1_000_000 });
    addTokens(run, "claude-opus-5-5", { input_tokens: 0, output_tokens: 100_000 });
    assert.equal(run.claude.requests, 2);
    assert.deepEqual(totalTokens(run), {
      input_tokens: 1_000_000, output_tokens: 200_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 1_000_000,
    });
    // 1M*4 + 0.2M*20 + 1M*0.2 = 8.2
    assert.equal(run.cost.claude, 8.2);
  });

  it("keeps tokens apart when a fallback model served some turns", () => {
    const run = newRunUsage("job_1", "", "agent");
    addTokens(run, "claude-opus-5-5", { input_tokens: 1_000_000 });
    addTokens(run, "claude-sonnet-5-5", { input_tokens: 1_000_000 });
    assert.deepEqual(Object.keys(run.claude.byModel).sort(), ["claude-opus-5-5", "claude-sonnet-5-5"]);
    assert.equal(run.cost.claude, 6);
  });

  it("counts failed image calls without billing them", () => {
    const run = newRunUsage("job_1", "", "demo");
    addImageCall(run, "mock", true);
    addImageCall(run, "mock", false);
    assert.equal(run.images.calls, 2);
    assert.equal(run.images.failed, 1);
    assert.deepEqual(run.images.byProvider, { mock: 1 });
  });

  it("marks a cost part null when its price is unknown, but still totals the rest", () => {
    const run = newRunUsage("job_1", "", "agent");
    addTokens(run, "claude-opus-5-5", { output_tokens: 1_000_000 });
    run.images.byProvider = { openai: 3 };
    assert.deepEqual(computeCost(run, {}), { claude: 20, images: null, total: 20 });
    assert.deepEqual(computeCost(run, { IMAGE_PRICE_OPENAI: "0.1" }), { claude: 20, images: 0.3, total: 20.3 });
  });

  it("summarize adds runs up and propagates unknown prices", () => {
    const a = newRunUsage("a", "", "agent");
    addTokens(a, "claude-opus-5-5", { input_tokens: 500_000 });
    const b = newRunUsage("b", "", "agent");
    addTokens(b, "mystery-model", { input_tokens: 10 });
    addImageCall(b, "mock", true);
    const s = summarize([a, b]);
    assert.equal(s.runs, 2);
    assert.equal(s.claudeRequests, 2);
    assert.equal(s.tokens.input_tokens, 500_010);
    assert.equal(s.images.calls, 1);
    assert.equal(s.cost.claude, null);
    assert.equal(s.cost.images, 0);
    assert.equal(s.cost.total, 2);
  });

  it("summarize of nothing is all zeros", () => {
    assert.deepEqual(summarize([]).cost, { claude: 0, images: 0, total: 0 });
  });
});
