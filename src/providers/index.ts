import { gemini } from "./gemini.js";
import { mock } from "./mock.js";
import { openai } from "./openai.js";
import { sdwebui } from "./sdwebui.js";
import { seedream } from "./seedream.js";
import { codexImage } from "./codexImage.js";
import { chatgptManual } from "./chatgptManual.js";
import type { ImageProvider } from "./types.js";

export * from "./types.js";

export const providers: ImageProvider[] = [openai, gemini, seedream, sdwebui, codexImage, chatgptManual, mock];

/** The named provider (must be configured), or the first available one. */
export function getProvider(id: string | undefined): ImageProvider {
  const requested = id ?? (process.env.IMAGE_PROVIDER?.trim() || undefined);
  const chosen = providers.find((p) => p.id === requested);
  if (requested && !chosen && id === undefined) throw new Error(`未知 IMAGE_PROVIDER：${requested}`);
  if (chosen) {
    if (!chosen.available()) throw new Error(`图像通道 ${chosen.label} 未启用或未配置所需凭证`);
    return chosen;
  }
  return providers.find((p) => p.available())!;
}
