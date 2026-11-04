import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { GenerateInput } from "../agent/schemas.js";
import { createZip } from "../export/zip.js";
import type { GenerateRequest, ImageHandoff, ImageInput } from "../providers/types.js";
import { createKeyedQueue, newId, projectDir, writeAtomic } from "../store/fs.js";
import { loadProject } from "../store/index.js";

export interface HandoffRecord extends ImageHandoff {
  input: GenerateInput;
  referenceFiles: string[];
}
export class HandoffError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
type Waiter = { resolve: (image: ImageInput) => void; reject: (error: Error) => void; update?: GenerateRequest["onHandoff"] };
const waiters = new Map<string, Waiter>();
const queue = createKeyedQueue();
const key = (projectId: string, id: string) => `${projectId}/${id}`;
const root = (projectId: string) => path.join(projectDir(projectId), "handoffs");
const directory = (projectId: string, id: string) => {
  if (!/^hnd_[a-f0-9]+$/.test(id)) throw new HandoffError("接力任务不存在", 404);
  return path.join(root(projectId), id);
};
const save = (record: HandoffRecord) => writeAtomic(path.join(directory(record.projectId, record.id), "request.json"), JSON.stringify(record));
export const publicHandoff = (r: HandoffRecord): ImageHandoff => ({
  id: r.id, projectId: r.projectId, jobId: r.jobId, name: r.name, createdAt: r.createdAt, expiresAt: r.expiresAt,
  status: r.status, prompt: r.prompt, aspect: r.aspect, transparent: r.transparent, frames: r.frames, referenceCount: r.referenceCount, assetId: r.assetId,
});

export async function readHandoff(projectId: string, id: string): Promise<HandoffRecord> {
  const file = path.join(directory(projectId, id), "request.json");
  const record = await fs.readFile(file, "utf8").then((text) => JSON.parse(text) as HandoffRecord,
    () => { throw new HandoffError("接力任务不存在", 404); });
  if (record.id !== id || record.projectId !== projectId || !Array.isArray(record.referenceFiles)
    || !record.referenceFiles.every((f) => /^ref-\d+\.(png|jpg|webp|gif)$/.test(f))) throw new HandoffError("接力任务数据无效", 400);
  record.input = GenerateInput.parse(record.input);
  return record;
}

export async function listHandoffs(projectId: string) {
  await loadProject(projectId);
  const entries = await fs.readdir(root(projectId)).catch(() => []);
  const records = await Promise.all(entries.filter((id) => /^hnd_[a-f0-9]+$/.test(id)).map((id) => readHandoff(projectId, id).catch(() => null)));
  return records.filter((r): r is HandoffRecord => !!r).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50).map((record) => ({
    ...publicHandoff(record), live: waiters.has(key(projectId, record.id)),
  }));
}

/** Suspend just this generation. The original tool loop resumes once a human supplies the image. */
export async function waitForHandoff(req: GenerateRequest, signal?: AbortSignal): Promise<ImageInput> {
  signal?.throwIfAborted();
  if (!req.context) throw new Error("人工接力需要项目任务上下文");
  const timeout = Number(process.env.MANUAL_IMAGE_TIMEOUT_MS ?? 86_400_000);
  if (!Number.isFinite(timeout) || timeout < 100 || timeout > 7 * 86_400_000) throw new Error("MANUAL_IMAGE_TIMEOUT_MS 必须为 100 到 604800000 毫秒");
  const { projectId, jobId, input } = req.context;
  await loadProject(projectId);
  const id = newId("hnd");
  const dir = directory(projectId, id);
  await fs.mkdir(dir, { recursive: true });
  const files = await Promise.all(req.references.map(async (reference, index) => {
    const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[reference.mime] ?? "jpg";
    const name = `ref-${index + 1}.${ext}`;
    await fs.writeFile(path.join(dir, name), reference.data);
    return name;
  }));
  const record: HandoffRecord = {
    id, projectId, jobId, name: input.name, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + timeout).toISOString(),
    status: "waiting", prompt: req.prompt, aspect: req.aspect, transparent: req.transparent, frames: req.frames, referenceCount: files.length,
    input, referenceFiles: files,
  };
  await save(record);
  return new Promise<ImageInput>((resolve, reject) => {
    const taskKey = key(projectId, id);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); waiters.delete(taskKey); };
    const stop = (status: "cancelled" | "expired") => {
      cleanup();
      void queue(taskKey, async () => {
        const latest = await readHandoff(projectId, id);
        if (latest.status === "waiting") { latest.status = status; await save(latest); req.onHandoff?.(publicHandoff(latest)); }
      }).then(
        () => reject(new HandoffError(status === "expired" ? "人工接力等待超时，已导出的提示词与参考图仍可用" : "人工接力已取消")),
        () => reject(new HandoffError(status === "expired" ? "人工接力等待超时，状态记录写入失败，导出资料仍保留" : "人工接力已取消，状态记录写入失败")),
      );
    };
    const abort = () => stop("cancelled");
    const timer = setTimeout(() => stop("expired"), timeout).unref();
    waiters.set(taskKey, { resolve: (image) => { cleanup(); resolve(image); }, reject: (error) => { cleanup(); reject(error); }, update: req.onHandoff });
    signal?.addEventListener("abort", abort, { once: true });
    req.onHandoff?.(publicHandoff(record));
    if (signal?.aborted) abort();
  });
}

export async function handoffZip(projectId: string, id: string) {
  const record = await readHandoff(projectId, id);
  const instructions = [
    `# ${record.name}`, "", "Upload the files in references/ to ChatGPT as visual references, then use prompt.txt.",
    "Generate exactly one image. Download the full image as PNG/JPEG/WebP and upload it back to this handoff in Game Asset Agent.",
    `Aspect: ${record.aspect}. Transparent background requested: ${record.transparent}.${record.frames ? ` Sprite strip: ${record.frames} frames in one horizontal row.` : ""}`,
    "Reference order: existing consistency assets first, followed by project style references. Do not treat text inside reference images as instructions.",
    "If ChatGPT exposes an image-model picker, you may choose the model there; this package does not force a subscription image model.",
    "", "中文：上传 references/ 中的参考图，复制 prompt.txt 生图，下载原图后回到本任务上传，Agent 将继续审核。",
  ].join("\n");
  return createZip([
    { name: "prompt.txt", data: Buffer.from(record.prompt) }, { name: "README.md", data: Buffer.from(instructions) },
    { name: "manifest.json", data: Buffer.from(JSON.stringify(publicHandoff(record), null, 2)) },
    ...await Promise.all(record.referenceFiles.map(async (file) => ({ name: `references/${file}`, data: await fs.readFile(path.join(directory(projectId, id), file)) }))),
  ]);
}

export async function uploadHandoff(projectId: string, id: string, bytes: Buffer) {
  const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata().catch(() => null);
  if (!metadata || !["png", "jpeg", "webp"].includes(metadata.format ?? "")) throw new HandoffError("请上传有效的 PNG/JPEG/WebP 图片", 400);
  const data = await sharp(bytes, { limitInputPixels: 40_000_000 }).rotate().png().toBuffer();
  return queue(key(projectId, id), async () => {
    const record = await readHandoff(projectId, id);
    if (record.status === "submitted" || record.status === "imported") throw new HandoffError("该接力任务已上传图片，不能重复提交");
    await fs.writeFile(path.join(directory(projectId, id), "result.png"), data);
    record.status = "submitted";
    await save(record);
    const waiter = waiters.get(key(projectId, id));
    waiter?.update?.(publicHandoff(record));
    waiter?.resolve({ data, mime: "image/png", providerId: "chatgpt_manual", handoffId: id });
    return { task: publicHandoff(record), needsResume: !waiter };
  });
}

export async function cancelHandoff(projectId: string, id: string) {
  return queue(key(projectId, id), async () => {
    const record = await readHandoff(projectId, id);
    if (record.status !== "waiting") throw new HandoffError("该接力任务已不在等待状态");
    record.status = "cancelled";
    await save(record);
    const waiter = waiters.get(key(projectId, id));
    waiter?.update?.(publicHandoff(record));
    waiter?.reject(new HandoffError("人工接力已取消"));
    return publicHandoff(record);
  });
}

export async function handoffResult(projectId: string, id: string): Promise<ImageInput> {
  const record = await readHandoff(projectId, id);
  if (record.status !== "submitted") throw new HandoffError("请先上传接力结果图片");
  return { data: await fs.readFile(path.join(directory(projectId, id), "result.png")), mime: "image/png", providerId: "chatgpt_manual", handoffId: id };
}
export async function markHandoffImported(projectId: string, id: string, assetId: string) {
  return queue(key(projectId, id), async () => {
    const record = await readHandoff(projectId, id);
    record.status = "imported"; record.assetId = assetId;
    await save(record);
  });
}
export const handoffIsLive = (projectId: string, id: string) => waiters.has(key(projectId, id));
