import { Router } from "express";
import multer from "multer";
import { jobs, runningJobFor, startJob } from "../agent/index.js";
import { HandoffError, cancelHandoff, handoffIsLive, handoffZip, listHandoffs, readHandoff, uploadHandoff } from "../handoff/service.js";
import { msg } from "../i18n.js";
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
  if (!req.file) return void res.status(400).json({ error: msg("err.uploadImage") });
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
  if (handoffIsLive(projectId, record.id)) throw new HandoffError(msg("err.handoffStillWaiting"));
  if (record.status !== "submitted" && record.status !== "imported") throw new HandoffError(msg("err.handoffUploadFirst"));
  const running = runningJobFor(projectId);
  if (running) return void res.status(409).json({ error: msg("err.projectBusy"), jobId: running.id });
  const job = startJob({ projectId, request: msg("run.handoffReview", { name: record.name }), assetTypes: [], providerId: "mock",
    handoffResume: { taskId: record.id }, continueConversation: false, budget: { maxImages: 1 } });
  res.json({ jobId: job.id });
});
handoffsRouter.use((error: unknown, _req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
  if (error instanceof HandoffError) return void res.status(error.status).json({ error: error.message });
  if (error instanceof multer.MulterError) return void res.status(400).json({ error: msg("err.uploadFailed") });
  next(error);
});
