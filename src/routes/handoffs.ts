import { Router } from "express";
import multer from "multer";
import { jobs, runningJobFor, startJob } from "../agent/index.js";
import { HandoffError, cancelHandoff, handoffIsLive, handoffZip, listHandoffs, readHandoff, uploadHandoff } from "../handoff/service.js";
import { loadProject } from "../store/index.js";
import { attachment, pid } from "./util.js";

export const handoffsRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

handoffsRouter.get("/api/projects/:id/handoffs", async (req, res) => {
  res.json({ tasks: await listHandoffs(pid(req)) });
});
handoffsRouter.get("/api/projects/:id/handoffs/:taskId/package.zip", async (req, res) => {
  await loadProject(pid(req));
  const zip = await handoffZip(pid(req), String(req.params.taskId));
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", attachment("handoff.zip", `handoff-${req.params.taskId}.zip`));
  res.send(zip);
});
handoffsRouter.post("/api/projects/:id/handoffs/:taskId/result", upload.single("image"), async (req, res) => {
  await loadProject(pid(req));
  if (!req.file) return void res.status(400).json({ error: "请上传 image 文件（PNG/JPEG/WebP，最大 20 MB）" });
  res.json(await uploadHandoff(pid(req), String(req.params.taskId), req.file.buffer));
});
handoffsRouter.post("/api/projects/:id/handoffs/:taskId/cancel", async (req, res) => {
  await loadProject(pid(req));
  const task = await cancelHandoff(pid(req), String(req.params.taskId));
  jobs.get(task.jobId)?.abort.abort();
  res.json({ task });
});
handoffsRouter.post("/api/projects/:id/handoffs/:taskId/resume", async (req, res) => {
  const projectId = pid(req);
  await loadProject(projectId);
  const record = await readHandoff(projectId, String(req.params.taskId));
  if (handoffIsLive(projectId, record.id)) throw new HandoffError("原任务仍在等待，请上传图片后等待它继续");
  if (record.status !== "submitted" && record.status !== "imported") throw new HandoffError("请先上传接力结果图片");
  const running = runningJobFor(projectId);
  if (running) return void res.status(409).json({ error: "项目已有任务在运行", jobId: running.id });
  const job = startJob({ projectId, request: `审核人工接力：${record.name}`, assetTypes: [], providerId: "mock",
    handoffResume: { taskId: record.id }, continueConversation: false, budget: { maxImages: 1 } });
  res.json({ jobId: job.id });
});
handoffsRouter.use((error: unknown, _req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
  if (error instanceof HandoffError) return void res.status(error.status).json({ error: error.message });
  if (error instanceof multer.MulterError) return void res.status(400).json({ error: "上传失败：最多一张图片，单张不超过 20 MB" });
  next(error);
});
