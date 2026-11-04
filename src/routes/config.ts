import { Router } from "express";
import { resolveBudget } from "../agent/budget.js";
import { config } from "../config.js";
import { ASSET_TYPES } from "../domain/assetTypes.js";
import { SIZE_PRESETS } from "../image/sizes.js";
import { getProvider, providers } from "../providers/index.js";

export const configRouter = Router();

configRouter.get("/api/config", (_req, res) => {
  res.json({
    providers: providers.map((p) => ({ id: p.id, label: p.label, available: p.available() })),
    defaultProvider: getProvider(undefined).id,
    imageCapabilities: { codex_image: { modelSelection: false, variant: "auto", billing: "subscription" },
      openai: { modelSelection: true, model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-flare" }, chatgpt_manual: { billing: "external" } },
    assetTypes: ASSET_TYPES,
    sizePresets: SIZE_PRESETS,
    demo: config.demo,
    agent: { provider: config.agentProvider, model: config.model, ...(config.agentProvider === "gpt" ? { authMode: config.gptAuthMode } : {}) },
    auth: !!config.accessToken,
    budget: resolveBudget(undefined),
    trashDays: Number(process.env.TRASH_DAYS ?? 7),
  });
});
