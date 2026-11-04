import sharp from "sharp";
import { msg } from "../i18n.js";
import { fetchWithRetry } from "./retry.js";
import { type Aspect, type ImageProvider, failOnHttpError } from "./types.js";

const MAX_REFERENCES = 10;
const SIZES = {
  "1K": { square: "1024x1024", landscape: "1280x720", portrait: "720x1280" },
  "1.5K": { square: "1536x1536", landscape: "1920x1080", portrait: "1080x1920" },
  "2K": { square: "2048x2048", landscape: "2560x1440", portrait: "1440x2560" },
} as const;

/** Explicit dimensions preserve the requested aspect; sheets use one square cell per frame. */
export function seedreamSize(aspect: Aspect, frames: number | undefined, tier = process.env.SEEDREAM_SIZE?.trim() || "2K") {
  if (tier !== "1K" && tier !== "1.5K" && tier !== "2K") throw new Error(msg("err.seedreamSize"));
  if (frames !== undefined) {
    if (!Number.isInteger(frames) || frames < 2 || frames > 16) throw new Error(msg("err.seedreamFrames"));
    const base = { "1K": 1024, "1.5K": 1536, "2K": 2048 }[tier];
    const cell = Math.floor(base / Math.sqrt(frames) / 16) * 16;
    return `${cell * frames}x${cell}`;
  }
  return SIZES[tier][aspect];
}

interface SeedreamResponse {
  data?: { b64_json?: string; url?: string; error?: { code?: string; message?: string } }[];
  error?: { code?: string; message?: string };
}

/** Volcengine Ark Seedream 5.0 Flash: JSON reference images, one output per call. */
export const seedream: ImageProvider = {
  id: "seedream",
  label: "Doubao Seedream 5.0 Flash（火山方舟）",
  available: () => !!process.env.ARK_API_KEY?.trim(),
  async generate(req, signal) {
    const key = process.env.ARK_API_KEY?.trim();
    if (!key) throw new Error(msg("err.seedreamKey"));
    const size = seedreamSize(req.aspect, req.frames);
    const watermark = process.env.SEEDREAM_WATERMARK?.trim().toLowerCase() || "false";
    if (watermark !== "true" && watermark !== "false") throw new Error(msg("err.seedreamWatermark"));
    const responseFormat = process.env.SEEDREAM_RESPONSE_FORMAT?.trim() || "b64_json";
    if (responseFormat !== "b64_json" && responseFormat !== "url") throw new Error(msg("err.seedreamFormat"));
    const base = (process.env.SEEDREAM_BASE_URL?.trim() || "https://ark.cn-beijing.volces.com/api/v3").replace(/\/+$/, "");
    if (req.references.length > MAX_REFERENCES) {
      req.onNotice?.(msg("run.seedreamRefs", { max: MAX_REFERENCES, shown: req.references.length }));
    }
    // Native alpha needs exactly one alpha reference. Normal project references are flattened JPEGs,
    // so ask for a flat backdrop and let the existing asset pipeline cut it out locally.
    const prompt = req.transparent
      ? `${req.prompt}\n\nIsolate the subject on a perfectly flat, plain pure-white (#FFFFFF) background with no ground shadow, no gradient, and no checkerboard, so it can be cut out cleanly.`
      : req.prompt;
    const images = req.references.slice(0, MAX_REFERENCES).map((r) => `data:${r.mime.toLowerCase()};base64,${r.data.toString("base64")}`);
    const res = await fetchWithRetry(`${base}/images/generations`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, signal,
      body: JSON.stringify({
        model: process.env.SEEDREAM_MODEL?.trim() || "doubao-seedream-5-0-flash-260915",
        prompt, ...(images.length ? { image: images } : {}), size,
        response_format: responseFormat, output_format: "png", stream: false, watermark: watermark === "true", background: "opaque",
      }),
    }, { onRetry: req.onRetry });
    await failOnHttpError(res, "Seedream");
    const json = await res.json() as SeedreamResponse;
    const image = json.data?.[0];
    const error = json.error ?? image?.error;
    if (error) throw new Error(msg("err.seedreamFailed", { code: error.code ?? "unknown_error", detail: error.message ? ` · ${error.message.slice(0, 300)}` : "" }));
    let data: Buffer;
    if (image?.b64_json) {
      data = Buffer.from(image.b64_json.replace(/^data:image\/[\w.+-]+;base64,/i, ""), "base64");
    } else if (image?.url) {
      const url = new URL(image.url);
      if (url.protocol !== "https:") throw new Error(msg("err.seedreamHttps"));
      // Only retry the download here, never re-submit a successful generation to obtain the bytes.
      // A signed image URL does not need (and must not receive) the Ark API key.
      const download = await fetchWithRetry(url.toString(), { signal }, { onRetry: req.onRetry });
      await failOnHttpError(download, msg("err.seedreamDownload"));
      data = Buffer.from(await download.arrayBuffer());
    } else {
      throw new Error(msg("err.seedreamNoImage"));
    }
    const metadata = await sharp(data).metadata().catch(() => null);
    if (!metadata || (metadata.format !== "png" && metadata.format !== "jpeg")) throw new Error(msg("err.seedreamInvalidImage"));
    return { data, mime: metadata.format === "jpeg" ? "image/jpeg" : "image/png" };
  },
};
