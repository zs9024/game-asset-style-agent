#!/usr/bin/env node
/**
 * Standalone probe for relay (中转站) image generation: checks which image
 * models a key/group can see and actually generates one image per model.
 *
 * No dependencies — run with: node tools/test-image-api.mjs --key <key>
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const HELP = `
中转站生图可用性测试工具（独立脚本，不依赖本项目）

用法:
  node tools/test-image-api.mjs --key <API_KEY> [options]

必填:
  --key <key>            中转站 API key（也可用环境变量 IMAGE_API_KEY 或 PINAIC_API_KEY）

选填:
  --base <url>           中转站地址，默认 https://api.pinaic.com
                         也可用环境变量 IMAGE_API_BASE
  --model <name>         要测试的模型，可重复或逗号分隔，例如:
                           --model gpt-image-2.5-flare,gemini-3.1-flash-image
                         不传时自动扫描 /v1/models 里所有图像模型
  --protocol <mode>      auto | openai | gemini，默认 auto
                         auto 规则：gemini-* 走 Gemini 原生接口，其余走 OpenAI images
  --prompt <text>        测试提示词，默认「一张科技感产品海报，蓝白配色，干净高级」
  --size <WxH>           OpenAI images 的尺寸，默认 1024x1024
  --aspect <ratio>       Gemini 的比例，默认 1:1（可选 3:2 / 2:3）
  --timeout <seconds>    单个请求超时，默认 300
  --out <dir>            图片保存目录，默认 tools/output
  --list                 只列出模型和图像模型，不生图
  -h, --help             显示本帮助

示例:
  node tools/test-image-api.mjs --key sk-xxx
  node tools/test-image-api.mjs --key sk-xxx --model gpt-image-2.5-flare
  node tools/test-image-api.mjs --key sk-xxx --model gemini-3.1-flash-image --aspect 3:2
  node tools/test-image-api.mjs --key sk-xxx --list

退出码: 全部成功为 0；有失败为 1；参数或连接错误为 2。
`;

class CliError extends Error {}

function parseArgs(argv) {
  const opts = { models: [], protocol: "auto", prompt: "一张科技感产品海报，蓝白配色，干净高级", size: "1024x1024", aspect: "1:1", timeout: 300, out: path.join(HERE, "output"), list: false, help: false };
  const flags = new Set(["--list", "-h", "--help"]);
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith("-")) throw new CliError(`无法识别的参数: ${raw}`);
    const eq = raw.indexOf("=");
    const name = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? undefined : raw.slice(eq + 1);
    if (flags.has(name)) {
      if (inline !== undefined) throw new CliError(`${name} 不接受值`);
      if (name === "--list") opts.list = true;
      else opts.help = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new CliError(`参数 ${name} 缺少值`);
    switch (name) {
      case "--key": opts.key = value; break;
      case "--base": opts.base = value; break;
      case "--model": opts.models.push(...value.split(",").map((s) => s.trim()).filter(Boolean)); break;
      case "--protocol":
        if (!["auto", "openai", "gemini"].includes(value)) throw new CliError("--protocol 只能是 auto / openai / gemini");
        opts.protocol = value; break;
      case "--prompt": opts.prompt = value; break;
      case "--size": opts.size = value; break;
      case "--aspect": opts.aspect = value; break;
      case "--timeout": {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds <= 0) throw new CliError("--timeout 必须是正数（秒）");
        opts.timeout = seconds; break;
      }
      case "--out": opts.out = value; break;
      default: throw new CliError(`未知参数: ${name}`);
    }
  }
  return opts;
}

/** Models this relay can plausibly render images with. */
const IMAGE_MODEL = /image|imagen|dall-e|seedream|flux/i;

async function readJson(url, init, timeoutMs) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error page */ }
  return { res, text, json };
}

function errorText(result) {
  const error = result.json?.error;
  if (typeof error === "string") return error;
  if (error?.message) return `${error.type ? `${error.type}: ` : ""}${error.message}`;
  if (result.json?.message) return String(result.json.message);
  return result.text.slice(0, 300).replace(/\s+/g, " ").trim() || `HTTP ${result.res.status}`;
}

async function listModels(base, key, timeoutMs) {
  let result;
  try {
    result = await readJson(`${base}/v1/models`, { headers: { Authorization: `Bearer ${key}` } }, timeoutMs);
  } catch (error) {
    throw new CliError(`无法连接 ${base}: ${error?.cause?.code ?? error?.message ?? error}`);
  }
  if (!result.res.ok) throw new CliError(`GET /v1/models 失败（HTTP ${result.res.status}）: ${errorText(result)}`);
  const items = Array.isArray(result.json?.data) ? result.json.data : Array.isArray(result.json?.models) ? result.json.models : [];
  return items.map((item) => item?.id ?? item?.name).filter(Boolean);
}

function protocolFor(model, configured) {
  if (configured !== "auto") return configured;
  return /^gemini/i.test(model) ? "gemini" : "openai";
}

async function generate(base, key, model, protocol, opts) {
  const timeoutMs = opts.timeout * 1000;
  if (protocol === "openai") {
    const result = await readJson(`${base}/v1/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: opts.prompt, size: opts.size, response_format: "b64_json", stream: false }),
    }, timeoutMs);
    if (!result.res.ok) return { ok: false, status: result.res.status, error: errorText(result) };
    const item = result.json?.data?.[0];
    let data = item?.b64_json ? Buffer.from(item.b64_json, "base64") : null;
    let mime = result.json?.output_format ? `image/${result.json.output_format}` : undefined;
    if (!data && item?.url) {
      const download = await fetch(item.url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!download.ok) return { ok: false, status: download.status, error: `下载 data[0].url 失败: HTTP ${download.status}` };
      data = Buffer.from(await download.arrayBuffer());
      mime = download.headers.get("content-type") ?? mime;
    }
    if (!data) return { ok: false, status: result.res.status, error: "响应中没有 data[0].b64_json 或 data[0].url" };
    return { ok: true, data, mime, usage: result.json?.usage };
  }

  const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const result = await readJson(url, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: opts.aspect } },
    }),
  }, timeoutMs);
  if (!result.res.ok) return { ok: false, status: result.res.status, error: errorText(result) };
  const parts = result.json?.candidates?.[0]?.content?.parts ?? [];
  const inline = parts.find((part) => part.inlineData || part.inline_data);
  const image = inline?.inlineData ?? inline?.inline_data;
  if (!image?.data) {
    const said = parts.map((part) => part.text).filter(Boolean).join(" ");
    return { ok: false, status: result.res.status, error: `响应中没有 inlineData${said ? `；文本回复: ${said.slice(0, 200)}` : ""}` };
  }
  return { ok: true, data: Buffer.from(image.data, "base64"), mime: image.mimeType ?? image.mime_type ?? "image/png", usage: result.json?.usageMetadata };
}

/** Read pixel size straight from PNG/JPEG/WebP headers, no libraries. */
function imageSize(data) {
  if (data.length > 24 && data.readUInt32BE(0) === 0x89504e47) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), format: "png" };
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    for (let i = 2; i + 9 < data.length; i++) {
      if (data[i] !== 0xff) continue;
      const marker = data[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: data.readUInt16BE(i + 7), height: data.readUInt16BE(i + 5), format: "jpeg" };
      }
    }
    return { format: "jpeg" };
  }
  if (data.length > 30 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") {
    const chunk = data.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3), format: "webp" };
    if (chunk === "VP8 ") return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff, format: "webp" };
    if (chunk === "VP8L") {
      const bits = data.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: "webp" };
    }
    return { format: "webp" };
  }
  return {};
}

function extensionFor(image) {
  const byMime = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[image.mime?.toLowerCase()];
  return byMime ?? imageSize(image.data).format ?? "bin";
}

function stamp() {
  const now = new Date();
  const pad = (n, size = 2) => String(n).padStart(size, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

function usageLine(usage) {
  if (!usage) return "";
  const pairs = [];
  if (usage.input_tokens !== undefined) pairs.push(`in=${usage.input_tokens}`);
  if (usage.output_tokens !== undefined) pairs.push(`out=${usage.output_tokens}`);
  if (usage.promptTokenCount !== undefined) pairs.push(`prompt=${usage.promptTokenCount}`);
  if (usage.candidatesTokenCount !== undefined) pairs.push(`image=${usage.candidatesTokenCount}`);
  return pairs.length ? `  tokens ${pairs.join(" ")}` : "";
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return 0; }

  const base = (opts.base ?? process.env.IMAGE_API_BASE ?? "https://api.pinaic.com").replace(/\/+$/, "");
  const key = opts.key ?? process.env.IMAGE_API_KEY ?? process.env.PINAIC_API_KEY;
  if (!key) throw new CliError("缺少 API key：请用 --key <key> 或设置环境变量 IMAGE_API_KEY");

  console.log(`中转站: ${base}`);
  let available = [];
  try {
    available = await listModels(base, key, opts.timeout * 1000);
    const images = available.filter((model) => IMAGE_MODEL.test(model));
    console.log(`模型列表: 共 ${available.length} 个，其中图像模型 ${images.length} 个`);
    for (const model of available) console.log(`  ${images.includes(model) ? "★" : " "} ${model}`);
    if (!images.length) {
      console.log("\n✘ 当前 key 所属分组没有图像模型。生图接口大概率不可用，请检查中转站的分组 / 图像权限。");
    }
  } catch (error) {
    console.warn(`! 无法读取模型列表: ${error instanceof Error ? error.message : error}`);
    console.warn("  将只测试 --model 指定的模型。");
  }

  if (opts.list) return 0;

  const models = opts.models.length ? opts.models : available.filter((model) => IMAGE_MODEL.test(model));
  if (!models.length) throw new CliError("没有可测试的图像模型：请用 --model 指定，或确认分组已开启图像权限");

  const outDir = path.resolve(opts.out);
  await fs.mkdir(outDir, { recursive: true });
  console.log(`\n开始测试 ${models.length} 个模型（协议 ${opts.protocol}，超时 ${opts.timeout}s）`);
  console.log(`提示词: ${opts.prompt}`);
  console.log(`输出目录: ${outDir}\n`);

  const report = [];
  for (const [index, model] of models.entries()) {
    const protocol = protocolFor(model, opts.protocol);
    const label = `[${index + 1}/${models.length}] ${model} (${protocol})`;
    process.stdout.write(`${label} ... `);
    const started = Date.now();
    try {
      const result = await generate(base, key, model, protocol, opts);
      const elapsed = Date.now() - started;
      if (!result.ok) {
        console.log(`✘ ${result.status ? `HTTP ${result.status} ` : ""}${seconds(elapsed)}\n    ${result.error}`);
        report.push({ model, ok: false, elapsed, error: result.error });
        continue;
      }
      const size = imageSize(result.data);
      const extension = extensionFor(result);
      const file = path.join(outDir, `${stamp()}-${model.replace(/[^a-z0-9._-]+/gi, "-")}.${extension}`);
      await fs.writeFile(file, result.data);
      const dimensions = size.width && size.height ? ` ${size.width}x${size.height}` : "";
      console.log(`✔ ${seconds(elapsed)}${dimensions} ${megabytes(result.data.length)}${usageLine(result.usage)}`);
      console.log(`    保存: ${file}`);
      report.push({ model, ok: true, elapsed, dimensions: size.width && size.height ? `${size.width}x${size.height}` : "", file });
    } catch (error) {
      const elapsed = Date.now() - started;
      const reason = error?.name === "TimeoutError" ? `超过 ${opts.timeout}s 未响应` : error?.cause?.code ?? error?.message ?? String(error);
      console.log(`✘ ${seconds(elapsed)}\n    ${reason}`);
      report.push({ model, ok: false, elapsed, error: String(reason) });
    }
  }

  console.log("\n汇总:");
  for (const item of report) {
    const mark = item.ok ? "✔" : "✘";
    const detail = item.ok ? `${seconds(item.elapsed)}${item.dimensions ? `  ${item.dimensions}` : ""}` : `${seconds(item.elapsed)}  ${item.error}`;
    console.log(`  ${mark} ${item.model}  ${detail}`);
  }
  const failed = report.filter((item) => !item.ok);
  console.log(`\n${report.length - failed.length}/${report.length} 个模型可用`);
  return failed.length ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`\n错误: ${error instanceof CliError ? error.message : error?.stack ?? error}`);
    process.exitCode = 2;
  });
