import { handoffResult, markHandoffImported, readHandoff } from "../handoff/service.js";
import { loadProject } from "../store/index.js";
import { config } from "../config.js";
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
    ({ asset } = await generateAsset(job, { id: "chatgpt_manual", label: "人工接力导入", available: () => true, generate: async () => image }, record.input));
  } else {
    await markHandoffImported(job.projectId, id, asset.id);
  }
  emit(job, { type: "status", text: "人工接力图片已入库，继续由 Agent 看图审核" });
  if (config.demo) {
    emit(job, { type: "text", delta: "演示模式：接力图片已入库，待人工审核；关闭 demo 后可由 Agent 审核。" });
    return;
  }
  job.budget.maxImages = job.usage.images.calls; // This continuation reviews the supplied image only.
  await runAgent(job, { ...opts, request: `仅审核已上传的素材「${asset.name}」，记录评分和修改建议；不要重新生成图片。`,
    providerId: "mock", continueConversation: false, reviewAssetIds: [asset.id], handoffResume: undefined });
}
