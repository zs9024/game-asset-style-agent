import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { shrink } from "../image/io.js";
import { getProvider } from "../providers/index.js";
import { loadConversation, loadProject, readProjectFile, saveConversation } from "../store/index.js";
import type { Conversation } from "../store/types.js";
import { refImages } from "./assets.js";
import { type Job, type RunOptions, emit, requestLabel } from "./events.js";
import { buildIntro } from "./prompts.js";
import { msg, providerLabel } from "../i18n.js";

type Identity = Required<Pick<Conversation, "agentProvider" | "model">> & Pick<Conversation, "authMode" | "accountId">;
const jpegBlock = (data: Buffer): Anthropic.Beta.BetaImageBlockParam => ({
  type: "image", source: { type: "base64", media_type: "image/jpeg", data: data.toString("base64") },
});

/** References, redraws and history boundaries are identical for all agent services. */
export async function prepareRun(job: Job, opts: RunOptions, identity: Identity) {
  const provider = getProvider(opts.providerId);
  const project = await loadProject(opts.projectId);
  if (!project.refs.length && !project.styleGuide) throw new Error(msg("err.needStyle"));
  const refs = await Promise.all((await refImages(project)).map((r) => shrink(r, 1024)));
  const redraws = (opts.redraws ?? []).map((r) => {
    const target = project.assets.find((a) => a.id === r.assetId);
    if (!target) throw new Error(msg("err.noRedrawAsset"));
    return { target, feedback: r.feedback };
  });
  const redrawImages = await Promise.all(redraws.map(async (r) =>
    shrink({ data: await readProjectFile(project.id, r.target.file), mime: r.target.mime }, 768)));
  const reviewAssets = (opts.reviewAssetIds ?? []).map((id) => {
    const asset = project.assets.find((a) => a.id === id);
    if (!asset) throw new Error(msg("err.reviewAssetMissing"));
    return asset;
  });
  const reviewImages = await Promise.all(reviewAssets.map(async (a) => shrink({ data: await readProjectFile(project.id, a.file), mime: a.mime }, 768)));
  let history = opts.continueConversation ? await loadConversation(project.id) : null;
  if (history && ((history.agentProvider ?? "claude") !== identity.agentProvider || (history.model && history.model !== identity.model)
    || history.authMode !== identity.authMode || history.accountId !== identity.accountId)) {
    emit(job, { type: "status", text: msg("run.agentSwitched") });
    history = null;
  }
  if (history && JSON.stringify(history.messages).length > config.conversationLimitBytes) {
    emit(job, { type: "status", text: msg("run.historyReset") });
    history = null;
  }
  const continuing = !!history?.messages.length;
  const opening: Anthropic.Beta.BetaMessageParam = { role: "user", content: [
    {
      type: "text",
      text: continuing
        ? "New request in the same project. The style guide below is current (the user may have edited it since)."
        : refs.length
          ? `Style reference images (${refs.length}):`
          : "No reference images: this project starts from its style guide (a built-in preset or the user's own). Follow it exactly.",
    },
    ...(continuing ? [] : refs.flatMap((r, i) => [{ type: "text" as const, text: `Reference ${i + 1}:` }, jpegBlock(r.data)])),
    ...redraws.flatMap((r, i) => [{ type: "text" as const, text: `Asset to redraw (${r.target.id}):` }, jpegBlock(redrawImages[i].data)]),
    ...reviewAssets.flatMap((a, i) => [{ type: "text" as const, text: `Human-generated asset to REVIEW: asset_id=${a.id}, name=${a.name}. Inspect this image and call review_asset. Do not call generate_image for this review-only request. If rejected, describe changes for the user.` }, jpegBlock(reviewImages[i].data)]),
    { type: "text", text: buildIntro({ project, request: opts.request, assetTypes: opts.assetTypes, redraws }) },
  ] };
  const limits = [
    job.budget.maxImages !== null ? msg("run.limitImages", { n: job.budget.maxImages }) : "",
    job.budget.maxUsd !== null ? msg("run.limitUsd", { n: job.budget.maxUsd }) : "",
  ].filter(Boolean);
  emit(job, {
    type: "status",
    text: [
      msg("run.agentStart", { model: identity.model, provider: providerLabel(provider.id, provider.label) }),
      continuing ? msg("run.continuing", { n: history!.runs.length + 1 }) : "",
      limits.length ? msg("run.budget", { limits: limits.join(msg("note.listSep")) }) : "",
    ]
      .filter(Boolean)
      .join(" · "),
  });
  const runs = [...(history?.runs ?? []), { request: requestLabel(opts), at: new Date().toISOString() }];
  return { provider, history, opening, persist: (messages: unknown[]) => saveConversation(project.id, { messages, runs, ...identity }) };
}
