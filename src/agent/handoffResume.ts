import { handoffResult, markHandoffImported, readHandoff } from "../handoff/service.js";
import { loadProject } from "../store/index.js";
import { config } from "../config.js";
import { msg } from "../i18n.js";
import { generateAsset } from "./assets.js";
import { type Job, type RunOptions, emit } from "./events.js";
import { runAgent } from "./loop.js";

/** Recover a human result after a restart/stop without requiring the human to generate it again. */
export async function runHandoffResume(job: Job, opts: RunOptions) {
  const id = opts.handoffResume!.taskId;
  const record = await readHandoff(job.projectId, id);
  const project = await loadProject(job.projectId);
  let asset = project.assets.find((a) => a.handoffId === id);
  if (!asset) {
    const image = await handoffResult(job.projectId, id);
    ({ asset } = await generateAsset(job, { id: "chatgpt_manual", label: msg("provider.handoffImport"), available: () => true, generate: async () => image }, record.input));
  } else {
    await markHandoffImported(job.projectId, id, asset.id);
  }
  emit(job, { type: "status", text: msg("run.handoffImported") });
  if (config.demo) {
    emit(job, { type: "text", delta: msg("run.handoffImportedDemo") });
    return;
  }
  job.budget.maxImages = job.usage.images.calls; // This continuation reviews the supplied image only.
  await runAgent(job, { ...opts, request: msg("run.handoffReviewRequest", { name: asset.name }),
    providerId: "mock", continueConversation: false, reviewAssetIds: [asset.id], handoffResume: undefined });
}
