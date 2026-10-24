import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { addTokens } from "../usage/record.js";
import { pastHardStop } from "./budget.js";
import { type Job, type RunOptions, emit, reportUsage } from "./events.js";
import { runGptAgent } from "./gpt.js";
import { prepareRun } from "./prepare.js";
import { SYSTEM } from "./prompts.js";
import { runTool } from "./runTool.js";
import { tools } from "./tools.js";

type Message = Anthropic.Beta.BetaMessageParam;

/** Both services support the Messages API, including images inside tool results. */
export async function runAgent(job: Job, opts: RunOptions) {
  const agentProvider = config.agentProvider;
  if (agentProvider === "gpt") return runGptAgent(job, opts);
  const deepseek = agentProvider === "deepseek";
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (deepseek && !apiKey) throw new Error("请配置 DEEPSEEK_API_KEY");
  const client = deepseek
    ? new Anthropic({ apiKey, authToken: null, baseURL: process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com/anthropic" })
    : new Anthropic();
  const model = config.model;
  const { provider, history, opening, persist } = await prepareRun(job, opts, { agentProvider, model });
  const messages: Message[] = [...((history?.messages ?? []) as Message[]), opening];
  let jsonRetries = 0;

  for (let turn = 0; turn < config.maxTurns; turn++) {
    if (pastHardStop(job.budget, job.usage)) {
      emit(job, { type: "status", text: `估算费用 $${job.usage.cost.total.toFixed(3)} 已明显超过上限 $${job.budget.maxUsd}，强制结束本次运行` });
      return;
    }
    const stream = client.beta.messages.stream(
      {
        model,
        max_tokens: 64000,
        ...(deepseek
          ? { thinking: { type: "enabled" as const, budget_tokens: 10000 } }
          : {
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default" as const,
            cache_control: { type: "ephemeral" as const },
            thinking: { type: "adaptive" as const, display: "summarized" as const },
          }),
        output_config: { effort: config.effort },
        system: SYSTEM,
        tools: deepseek ? tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })) : tools,
        messages,
      },
      { signal: job.abort.signal },
    );
    stream.on("text", (delta) => emit(job, { type: "text", delta }));

    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      // A failed stream may still have billed tokens; record what the SDK saw.
      const partial = stream.currentMessage;
      if (partial?.usage) {
        addTokens(job.usage, partial.model ?? model, partial.usage);
        reportUsage(job);
      }
      if (err instanceof Anthropic.APIError || job.abort.signal.aborted || jsonRetries++ >= 2) throw err;
      emit(job, { type: "status", text: "工具参数解析失败，重试本轮" });
      continue;
    }

    addTokens(job.usage, message.model ?? model, message.usage);
    reportUsage(job);

    for (const b of message.content) {
      if (b.type === "thinking" && b.thinking) emit(job, { type: "thinking", text: b.thinking });
    }

    if (message.stop_reason === "refusal") {
      throw new Error(`模型拒绝了该请求${message.stop_details?.explanation ? `：${message.stop_details.explanation}` : ""}`);
    }
    if (message.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: message.content });
      continue;
    }

    const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (message.stop_reason === "end_turn" || toolUses.length === 0) {
      // Only a cleanly finished run is saved, so the stored history never ends on an unanswered tool call.
      messages.push({ role: "assistant", content: message.content });
      await persist(messages);
      return;
    }
    if (message.stop_reason === "max_tokens") throw new Error("输出超出 max_tokens，工具参数被截断");

    messages.push({ role: "assistant", content: message.content });
    for (const t of toolUses) emit(job, { type: "tool", name: t.name, input: t.input });
    // Every tool_result goes back in one user message; generations run concurrently.
    const results = await Promise.all(toolUses.map((t) => runTool(job, provider, t)));
    messages.push({ role: "user", content: results });
  }
  emit(job, { type: "status", text: `已达到最大轮数 ${config.maxTurns}，停止` });
}
