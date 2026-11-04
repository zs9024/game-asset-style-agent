import { Router } from "express";
import { assetsRouter } from "./assets.js";
import { configRouter } from "./config.js";
import { chatgptRouter } from "./chatgpt.js";
import { exportRouter } from "./export.js";
import { jobsRouter } from "./jobs.js";
import { projectsRouter } from "./projects.js";
import { refsRouter } from "./refs.js";
import { usageRouter } from "./usage.js";
import { handoffsRouter } from "./handoffs.js";

export const apiRouter = Router();
for (const r of [configRouter, chatgptRouter, projectsRouter, refsRouter, assetsRouter, exportRouter, jobsRouter, usageRouter, handoffsRouter]) apiRouter.use(r);
