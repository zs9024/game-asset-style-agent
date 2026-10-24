import { Router } from "express";
import { jobs } from "../agent/events.js";
import { chatGPTAuth } from "../openai/chatgpt.js";

export const chatgptRouter = Router();

function stopSubscriptionJobs() {
  for (const job of jobs.values()) if (!job.finished && job.usage.agent?.authMode === "chatgpt") job.abort.abort();
}

// This connector controls local credentials. Forwarded/public requests must not manage them.
chatgptRouter.use("/api/chatgpt", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  const address = req.socket.remoteAddress;
  const local = address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  let hostname = "";
  let sameOrigin = !req.headers.origin;
  try {
    hostname = new URL(`http://${req.headers.host ?? "invalid"}`).hostname;
    if (req.headers.origin) sameOrigin = new URL(req.headers.origin).origin === `${req.protocol}://${req.headers.host}`;
  } catch { /* Invalid Host/Origin headers fail the local/same-origin checks below. */ }
  if (!local || req.headers["x-forwarded-for"] || !["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
    return void res.status(403).json({ error: "ChatGPT 登录管理仅允许从本机直接访问；远程部署请先在本机登录" });
  }
  if (req.method !== "GET") {
    if (!req.is("application/json") || !sameOrigin) {
      return void res.status(403).json({ error: "ChatGPT 登录操作需要同源 JSON 请求" });
    }
  }
  next();
});

chatgptRouter.get("/api/chatgpt/status", async (_req, res) => { res.json(await chatGPTAuth.status()); });
chatgptRouter.get("/api/chatgpt/models", async (_req, res) => { res.json({ models: await chatGPTAuth.models() }); });
chatgptRouter.post("/api/chatgpt/login", async (req, res) => {
  if (req.body?.accountId !== undefined && typeof req.body.accountId !== "string") return void res.status(400).json({ error: "accountId 必须为字符串" });
  res.json(await chatGPTAuth.startLogin(req.body?.accountId));
});
chatgptRouter.post("/api/chatgpt/cancel", async (_req, res) => {
  chatGPTAuth.close();
  res.json(await chatGPTAuth.status());
});
chatgptRouter.post("/api/chatgpt/account", async (req, res) => {
  if (typeof req.body?.accountId !== "string") return void res.status(400).json({ error: "需要 accountId" });
  stopSubscriptionJobs();
  await chatGPTAuth.selectAccount(req.body.accountId);
  res.json(await chatGPTAuth.status());
});
chatgptRouter.post("/api/chatgpt/logout", async (req, res) => {
  if (typeof req.body?.accountId !== "string") return void res.status(400).json({ error: "需要 accountId" });
  stopSubscriptionJobs();
  res.json(await chatGPTAuth.logout(req.body.accountId));
});
