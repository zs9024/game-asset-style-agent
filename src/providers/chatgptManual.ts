import { waitForHandoff } from "../handoff/service.js";
import type { ImageProvider } from "./types.js";

export const chatgptManual: ImageProvider = {
  id: "chatgpt_manual", label: "ChatGPT 人工接力（导出后上传）",
  available: () => process.env.MANUAL_IMAGE_ENABLED === "true" || process.env.IMAGE_PROVIDER === "chatgpt_manual",
  generate: waitForHandoff,
};
