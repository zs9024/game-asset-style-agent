import type Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { Response as GptResponse, ResponseFunctionToolCall, ResponseInputContent, ResponseInputItem } from "openai/resources/responses/responses";
import { config } from "../config.js";
import { chatGPTAuth } from "../openai/chatgpt.js";
import { addTokens } from "../usage/record.js";
import { pastHardStop } from "./budget.js";
import { type Job, type RunOptions, emit, reportUsage } from "./events.js";
import { prepareRun } from "./prepare.js";
import { SYSTEM } from "./prompts.js";
import { errResult, runTool } from "./runTool.js";
import { tools } from "./tools.js";

const NAMESPACE = "game_assets";
type ImageOrText = Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam;

function contentParts(blocks: ImageOrText[]): ResponseInputContent[] {
  return blocks.map((b) => {
    if (b.type === "text") return { type: "input_text", text: b.text };
    if (b.source.type !== "base64") throw new Error("GPT 参考图必须为内嵌图片");
    return { type: "input_image", image_url: `data:${b.source.media_type};base64,${b.source.data}`, detail: "auto" };
  });
}

function reportTokens(job: Job, response: GptResponse) {
  const usage = response.usage;
  if (!usage) return;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const written = usage.input_tokens_details?.cache_write_tokens ?? 0;
  addTokens(job.usage, response.model, {
    input_tokens: Math.max(0, usage.input_tokens - cached - written), output_tokens: usage.output_tokens,
    cache_read_input_tokens: cached, cache_creation_input_tokens: written,
  });
  reportUsage(job);
}

/** Both GPT billing modes use Responses; the subscription route never falls back to an API key. */
export async function runGptAgent(job: Job, opts: RunOptions) {
  const authMode = config.gptAuthMode;
  const subscription = authMode === "chatgpt";
  const model = config.model;
  const credential = subscription ? await chatGPTAuth.credential() : null;
  const apiKey = subscription ? credential!.accessToken : process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("GPT API 模式需要配置 OPENAI_API_KEY（按 API 用量单独计费）");
  const clientOptions = {
    apiKey, baseURL: subscription ? "https://api.openai.com/v1" : process.env.GPT_BASE_URL?.trim() || "https://api.openai.com/v1",
    // Do not inherit organization/project identifiers from a separate Platform API account.
    organization: null, project: null, maxRetries: subscription ? 0 : 2,
  };
  const prepared = await prepareRun(job, opts, { agentProvider: "gpt", model, authMode, accountId: credential?.accountId });
  job.usage.agent = { provider: "gpt", model, authMode };
  const input: ResponseInputItem[] = [...((prepared.history?.messages ?? []) as ResponseInputItem[]), {
    role: "user", content: contentParts(prepared.opening.content as ImageOrText[]),
  }];
  emit(job, { type: "status", text: subscription ? "GPT 使用 ChatGPT 订阅额度；图像通道另行计费" : "GPT 使用 OpenAI API key，按 API 用量单独计费" });
  reportUsage(job);
  for (let turn = 0; turn < config.maxTurns; turn++) {
    job.abort.signal.throwIfAborted();
    if (pastHardStop(job.budget, job.usage)) {
      emit(job, { type: "status", text: "估算费用已明显超过上限，强制结束本次运行" });
      return;
    }
    // Refresh between turns; a rotating subscription token may expire during a long job.
    const token = subscription ? (await chatGPTAuth.credential(credential!.accountId)).accessToken : apiKey;
    const client = new OpenAI({ ...clientOptions, apiKey: token });
    const stream = await client.responses.create({
      model, instructions: SYSTEM, input, store: false, stream: true,
      include: ["reasoning.encrypted_content"], reasoning: { effort: config.effort, summary: "auto" },
      tools: [{ type: "namespace", name: NAMESPACE, description: "Create, inspect and review style-consistent game assets.",
        tools: tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.input_schema, strict: false })) }],
    }, { signal: job.abort.signal });
    let response: GptResponse | undefined;
    for await (const event of stream) {
      if (event.type === "response.output_text.delta") emit(job, { type: "text", delta: event.delta });
      if (event.type === "response.reasoning_summary_text.done") emit(job, { type: "thinking", text: event.text });
      if (event.type === "error") throw new Error(`GPT 请求失败：${event.code ?? "unknown_error"} · ${event.message}`);
      if (event.type === "response.failed" || event.type === "response.incomplete") {
        reportTokens(job, event.response);
        throw new Error(`GPT 运行未完成：${event.response.error?.code ?? event.response.incomplete_details?.reason ?? event.type}。请检查额度与授权；不会自动切换费用来源。`);
      }
      if (event.type === "response.completed") response = event.response;
    }
    job.abort.signal.throwIfAborted();
    if (!response || response.status !== "completed") throw new Error("GPT 事件流中断，未收到 response.completed；本轮未执行工具");
    reportTokens(job, response);
    if (response.output.some((item) => item.type === "message" && item.content.some((b) => b.type === "refusal"))) throw new Error("GPT 模型拒绝了该请求");
    // Preserve encrypted reasoning and all tool-call metadata unchanged across turns/runs.
    input.push(...response.output as ResponseInputItem[]);
    const calls = response.output.filter((item): item is ResponseFunctionToolCall => item.type === "function_call");
    if (!calls.length) {
      await prepared.persist(input);
      return;
    }
    const outputs = await Promise.all(calls.map(async (call): Promise<ResponseInputItem> => {
      let args: unknown;
      try { args = JSON.parse(call.arguments); } catch { args = call.arguments; }
      const block = { type: "tool_use" as const, id: call.call_id, name: call.name, input: args };
      emit(job, { type: "tool", name: call.name, input: args });
      const result = call.namespace && call.namespace !== NAMESPACE ? errResult(call.call_id, "Unknown tool namespace") : await runTool(job, prepared.provider, block);
      const output = typeof result.content === "string" ? result.content : contentParts((result.content ?? []) as ImageOrText[]);
      return { type: "function_call_output", call_id: call.call_id, name: call.name, namespace: call.namespace, output };
    }));
    input.push(...outputs);
  }
  emit(job, { type: "status", text: `已达到最大轮数 ${config.maxTurns}，停止` });
}
