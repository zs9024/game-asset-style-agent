import { gemini } from "./gemini.js";
import { mock } from "./mock.js";
import { openai } from "./openai.js";
import { sdwebui } from "./sdwebui.js";
import { seedream } from "./seedream.js";
import { codexImage } from "./codexImage.js";
import { chatgptManual } from "./chatgptManual.js";
import type { ImageProvider } from "./types.js";
import { msg, providerLabel } from "../i18n.js";

export * from "./types.js";

export const providers: ImageProvider[] = [openai, gemini, seedream, sdwebui, codexImage, chatgptManual, mock];

/** The named provider (must be configured), or the first available one. */
export function getProvider(id: string | undefined): ImageProvider {
  const requested = id ?? (process.env.IMAGE_PROVIDER?.trim() || undefined);
  const chosen = providers.find((p) => p.id === requested);
  if (requested && !chosen && id === undefined) throw new Error(msg("err.unknownImageProvider", { provider: requested }));
  if (chosen) {
    if (!chosen.available()) throw new Error(msg("err.providerKey", { provider: providerLabel(chosen.id, chosen.label) }));
    return chosen;
  }
  return providers.find((p) => p.available())!;
}
