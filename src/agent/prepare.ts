import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { shrink } from "../image/io.js";
import { getProvider } from "../providers/index.js";
import { loadConversation, loadProject, readProjectFile, saveConversation } from "../store/index.js";
import type { Conversation } from "../store/types.js";
import { refImages } from "./assets.js";
import { type Job, type RunOptions, emit, requestLabel } from "./events.js";
import { buildIntro } from "./prompts.js";

type Identity = Required<Pick<Conversation, "agentProvider" | "model">> & Pick<Conversation, "authMode" | "accountId">;
const jpegBlock = (data: Buffer): Anthropic.Beta.BetaImageBlockParam => ({
  type: "image", source: { type: "base64", media_type: "image/jpeg", data: data.toString("base64") },
});

/** References, redraws and history boundaries are identical for all agent services. */
export async function prepareRun(job: Job, opts: RunOptions, identity: Identity) {
  const provider = getProvider(opts.providerId);
  const project = await loadProject(opts.projectId);
  if (!project.refs.length) throw new Error("请先上传至少一张风格参考图");
  const refs = await Promise.all((await refImages(project)).map((r) => shrink(r, 1024)));
  const redraws = (opts.redraws ?? []).map((r) => {
    const target = project.assets.find((a) => a.id === r.assetId);
    if (!target) throw new Error("要重画的素材不存在");
    return { target, feedback: r.feedback };
  });
  const redrawImages = await Promise.all(redraws.map(async (r) =>
    shrink({ data: await readProjectFile(project.id, r.target.file), mime: r.target.mime }, 768)));
  let history = opts.continueConversation ? await loadConversation(project.id) : null;
  if (history && ((history.agentProvider ?? "claude") !== identity.agentProvider || (history.model && history.model !== identity.model)
    || history.authMode !== identity.authMode || history.accountId !== identity.accountId)) {
    emit(job, { type: "status", text: "Agent 服务商、模型或登录身份已切换，本次开启新对话（风格指南与素材不受影响）" });
    history = null;
  }
  if (history && JSON.stringify(history.messages).length > config.conversationLimitBytes) {
    emit(job, { type: "status", text: "对话历史过长，本次开启新对话（风格指南与素材不受影响）" });
    history = null;
  }
  const continuing = !!history?.messages.length;
  const opening: Anthropic.Beta.BetaMessageParam = { role: "user", content: [
    { type: "text", text: continuing ? "New request in the same project. The style guide below is current (the user may have edited it since)." : `Style reference images (${refs.length}):` },
    ...(continuing ? [] : refs.flatMap((r, i) => [{ type: "text" as const, text: `Reference ${i + 1}:` }, jpegBlock(r.data)])),
    ...redraws.flatMap((r, i) => [{ type: "text" as const, text: `Asset to redraw (${r.target.id}):` }, jpegBlock(redrawImages[i].data)]),
    { type: "text", text: buildIntro({ project, request: opts.request, assetTypes: opts.assetTypes, redraws }) },
  ] };
  const limits = [job.budget.maxImages !== null ? `图像 ≤ ${job.budget.maxImages} 次` : "", job.budget.maxUsd !== null ? `费用 ≤ $${job.budget.maxUsd}` : ""].filter(Boolean);
  emit(job, { type: "status", text: `Agent 启动 · ${identity.model} · 图像通道 ${provider.label}${continuing ? ` · 延续对话（第 ${history!.runs.length + 1} 轮）` : ""}${limits.length ? ` · 预算 ${limits.join("，")}` : ""}` });
  const runs = [...(history?.runs ?? []), { request: requestLabel(opts), at: new Date().toISOString() }];
  return { provider, history, opening, persist: (messages: unknown[]) => saveConversation(project.id, { messages, runs, ...identity }) };
}
