# Game Asset Agent

[English](README.en.md) · 中文

[![CI](https://github.com/wangchaozhi/game-asset-style-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/wangchaozhi/game-asset-style-agent/actions/workflows/ci.yml)

上传几张风格参考图，由 Claude、DeepSeek Flash 或 GPT 担任「AI 美术总监」：先从参考图提炼可复用的**风格指南**（色板 hex、技法、线条、光影、视角、比例），再按你的需求规划素材清单、调用图像模型批量生成，**逐张看图审核**，风格跑偏就带着具体问题重画——最终得到一套看起来出自同一款游戏的素材。

![flow](https://img.shields.io/badge/flow-参考图→风格指南→规划→生成→审核→重画-e2562b)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/main-dark.png" />
  <img alt="Game Asset Agent 主界面：风格参考与风格指南、需求与 Agent 日志、素材库" src="docs/screenshots/main-light.png" />
</picture>

<sub>截图为演示模式（`AGENT_MODE=demo`），素材是离线 Mock 占位图；接入 Agent 与图像模型后为真实生成结果。</sub>

## 功能

- 🎨 **风格提炼**：Agent 视觉分析参考图，保存结构化风格指南，项目内所有后续生成都复用它
- 🧩 **10 类游戏素材**：角色、精灵表、敌人、道具图标、地图瓦片、场景物件、背景、UI、特效、头像
- 🎯 **色板一致性检测**：在 Lab 色彩空间计算素材与风格色板的色差，给出色板内像素占比与主要色板外颜色；结果附在每次生成里供 Agent 审核，查看器也可查看
- 🔁 **自审闭环**：每张图生成后 Agent 会对照参考图打一致性分（1–10），结果附带色板 / 瓦片接缝 / 帧抖动自动检测；接缝、抖动、残留背景这类问题直接用后处理工具修复（不花图像费用），其他问题带着具体意见重画（每张最多 2 次）
- 🧬 **跨素材一致性**：可把已通过的素材（如主角设定图）作为额外参考，画同一角色的动画帧 / 头像
- 📦 **引擎可用的导出**：按类型分目录的 ZIP（含多尺寸、manifest、Godot 4 SpriteFrames `.tres`），以及图集 PNG + TexturePacker JSON（Phaser / PixiJS 可直接加载）和 Phaser 动画定义
- 💰 **成本可控**：实时用量与费用估算；单次运行可设图像次数 / 费用上限，达到后 Agent 停止出图并收尾；图像接口限流自动退避重试
- 🛠️ **素材工作台**：精灵表切帧与防抖对齐、瓦片一键无缝化、去背景、游戏尺寸缩放、版本对比（滑块 / 并排）、改 prompt 直接重生成（不经过 Agent）
- 🗂️ **素材管理**：搜索与类型筛选、批量通过 / 驳回 / 按意见重画 / 导出、回收站（7 天可恢复）、风格指南历史与回滚、参考图备注、项目备份与恢复
- ⚡ 并行生成、SSE 实时日志（含思考摘要）、可随时停止、刷新页面自动续接任务、后台完成提醒、查看器快捷键
- 🔌 图像模型可插拔：OpenAI GPT Image 2.5 Flare / Sunburst（API）、Google Gemini Image、火山方舟 Doubao Seedream 5.0 Flash（最多 10 张参考图）、本地 Stable Diffusion WebUI、Codex 内置订阅生图、ChatGPT 人工接力、离线 Mock

<img alt="素材查看器：审核与按意见重画、色板一致性、精灵帧抖动检测与对齐、游戏尺寸" src="docs/screenshots/viewer.png" />

## 快速开始

```bash
npm install
cp .env.example .env   # 配置 Claude、DeepSeek 或 GPT，以及一个图像通道（见下文）
npm start              # http://localhost:5173
```

没有 Claude key 时，在 `.env` 中选择 DeepSeek：

```dotenv
AGENT_PROVIDER=deepseek
DEEPSEEK_API_KEY=你的DeepSeek密钥
DEEPSEEK_MODEL=deepseek-flash
```

无需填写 `ANTHROPIC_API_KEY`。DeepSeek 负责看图、规划和审核；实际出图可配置 Seedream 的 `ARK_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY` 或本地 `SD_WEBUI_URL`，也可用 Mock 测试流程。

当前官方视觉模型名为 `deepseek-flash`；旧的 `deepseek-v4-flash-vision-exp` 已由新版 Flash 接替，`deepseek-v4-pro` 不支持视觉。默认使用 Anthropic 兼容地址 `https://api.deepseek.com/anthropic`，可用 `DEEPSEEK_BASE_URL` 覆盖；`DEEPSEEK_EFFORT=low|high|max`（默认 `high`）。参见 [DeepSeek 视觉文档](https://api-docs.deepseek.com/guides/vision/)。切换 Agent 服务商或模型后会开启新对话，保留风格指南与素材。默认 `AGENT_PROVIDER=claude`，原有配置继续可用。

### 使用 GPT：API key 或 ChatGPT 订阅登录

两种模式都支持参考图分析、规划、工具调用和看图审核，通过 `.env` 选择：

| 配置 | API key | ChatGPT 订阅 |
|---|---|---|
| `AGENT_PROVIDER` | `gpt` | `gpt` |
| `GPT_AUTH_MODE` | `api_key`（默认） | `chatgpt` |
| `GPT_MODEL` | `gpt-6.1-sol`（默认，可修改） | 账号可用的模型，可先用 `gpt-6.1-sol` |
| 凭证 | `OPENAI_API_KEY` | 页面中 **Continue with ChatGPT** 完成授权 |
| 费用 | OpenAI Platform 按 API 用量单独计费 | 使用符合条件的 ChatGPT 订阅额度/可用 credits |

API key 模式示例：

```dotenv
AGENT_PROVIDER=gpt
GPT_AUTH_MODE=api_key
OPENAI_API_KEY=你的OpenAI平台密钥
GPT_MODEL=gpt-6.1-sol
```

在 [OpenAI Platform](https://platform.openai.com/api-keys) 创建 key 并设置 API 计费。Plus 订阅不会抵扣 API key 的调用费用。`GPT_BASE_URL` 可覆盖 API 地址，默认 `https://api.openai.com/v1`；`GPT_EFFORT=low|medium|high|xhigh|max`（默认 `medium`，模型需支持对应强度）。

ChatGPT 订阅模式示例：

```dotenv
AGENT_PROVIDER=gpt
GPT_AUTH_MODE=chatgpt
GPT_MODEL=gpt-6.1-sol
```

去掉 `AGENT_MODE=demo`，启动项目后从本机直接打开 `http://127.0.0.1:5173`，在需求面板点击 **Continue with ChatGPT**，在新窗口登录并授权订阅用量。可以添加/选择多个 ChatGPT 账号或工作区；点击「查看可用模型」获取当前账号的模型列表，将对应 id 填入 `GPT_MODEL` 后重启。

也可以在本机终端运行 `npm run chatgpt:login`，打开命令打印的登录地址完成授权；`npm run chatgpt:login -- --new` 添加账号，`-- --account oaiapp_…` 重新登录已有账号。此流程使用项目自己的官方 OAuth（PKCE、身份签名校验、令牌续期），无需提取或复制 Codex 的登录凭证。订阅模式固定使用官方 Responses API，忽略 `GPT_BASE_URL`，且不会在额度不足或授权失效时自动改用 API key。

订阅登录适用于官方支持的开源/本地运行场景，账号资格、可用模型与额度由 OpenAI 决定，并非无限使用；Plus 的用量限制会与其他使用该订阅的应用共享。参见 [官方订阅接入](https://developers.openai.com/siwc/token-sharing-open-source)、[当前限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。实际生成图片仍通过独立的 Seedream / OpenAI / Gemini / 本地 SD / Mock 通道；订阅登录令牌只用于 Agent 看图和规划，不会作为图像通道的 key。

登录凭证保存在 `DATA_DIR/auth/chatgpt.json`（默认 `data/auth/chatgpt.json`），按账号分别保存，不包含在项目备份中。保护整个数据目录，不要上传或共享该文件；Unix 下以 `0600` 权限原子写入，Windows 下须限制数据目录访问权限。退出会尝试撤销远程会话并清除本地令牌。界面登录管理仅接受本机直接请求；Docker/远程自托管时，先在本机完成登录，再按照[官方自托管指南](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)安全转移该凭证文件到服务器的 `DATA_DIR/auth/`。同一数据目录只运行一个实例，避免刷新令牌冲突。

GPT API token 费用按默认模型的标准短上下文价估算，可用 `GPT_PRICE=输入,输出,缓存写,缓存读` 覆盖（美元/百万 tokens）；长上下文等附加费用以平台账单为准。订阅模式保留 token 统计，Agent API 费用记为 0，表示未按 Platform API 计费；图像费用继续单独统计。切换服务商、模型、鉴权模式或 ChatGPT 账号会开启新对话，保留风格指南与素材。

### 使用 Codex 订阅生图或 ChatGPT 人工接力

两个通道均不需要 OpenAI API key，继续使用已配置的 Agent 来规划和审核。`IMAGE_PROVIDER` 设置默认图像通道，界面和每次 HTTP 请求的 `provider` 仍可显式选择其他已启用通道。

**Codex 内置生图**：

```dotenv
IMAGE_PROVIDER=codex_image
CODEX_IMAGE_AUTH_MODE=chatgpt
CODEX_IMAGE_VARIANT=auto
CODEX_IMAGE_TIMEOUT_MS=300000
CODEX_IMAGE_CONCURRENCY=1
CODEX_IMAGE_FALLBACK=none
```

服务所在机器需安装 Codex CLI，并以运行服务的同一系统账号执行 `codex login`，使用 ChatGPT 订阅登录。`CODEX_IMAGE_BIN` 默认 `codex`；Windows 也可指定 `codex.exe` 或官方 `codex.js` 启动器路径。可用 `CODEX_IMAGE_HOME` 指向该 CLI 的凭证目录；这是 Codex 自己的登录，与项目页面上的 Continue with ChatGPT OAuth 登录分别管理。

通道在独立任务目录中调用 `codex exec`，通过 `$imagegen` 使用内置生图，传入参考图与绘图要求，要求把实际生成图片复制为 `asset.png`。只有进程成功退出且文件通过图片校验后才入库；仅回复文字不会被当作生图成功。项目 API key 和 OAuth 令牌不会传入该进程，使用 workspace-write 沙箱，不自动提升权限。超时或停止会终止工作进程；权限不足、CLI 未登录或没有内置生图能力时会报错。首次使用建议先生成一张验证本机 CLI/订阅可用性。

**Flare / Sunburst 的选择边界**：当前本机 imagegen skill 的内置工具未暴露图像模型参数，官方 Codex 文档也没有给出订阅生图的 Flare/Sunburst 选择开关，因此 `CODEX_IMAGE_VARIANT` 仅接受 `auto`；填 `flare` 或 `sunburst` 会明确报错，不会假装已切换。`CODEX_IMAGE_AGENT_MODEL` 可指定执行任务的语言模型，不能用于指定图像模型。需要精确选择图像模型时，使用 API 通道（需要独立计费的 API key）：

```dotenv
IMAGE_PROVIDER=openai
OPENAI_API_KEY=你的API密钥
OPENAI_IMAGE_MODEL=gpt-image-2.5-flare
# 或 gpt-image-2.5-sunburst
```

内置生图的能力和额度以 Codex/账号为准，参见 [Codex 生图](https://learn.chatgpt.com/docs/image-generation)；API 模型参数参见 [官方图像生成说明](https://developers.openai.com/api/docs/guides/tools-image-generation)。默认 API 图像模型已改为 Flare，避免继续使用已停用的 `gpt-image-1`。

默认 `CODEX_IMAGE_FALLBACK=none`，生图失败就报告错误。只有显式配置 `seedream` 时才会调用方舟、消耗对应额度；配置 `chatgpt_manual` 则进入人工接力，不会自动发送付费 API 请求。真正使用的备用通道会记录在素材的 `provider` 与用量统计中。仅想让通道出现在下拉框而不设为默认，可设置 `CODEX_IMAGE_ENABLED=true`。

**人工接力**：

```dotenv
IMAGE_PROVIDER=chatgpt_manual
MANUAL_IMAGE_TIMEOUT_MS=86400000
```

1. Agent 调用生成工具后，需求面板会出现「ChatGPT 人工接力」卡片，并等待图片。
2. 下载 ZIP（包含 `prompt.txt`、参考图、manifest 和操作说明），或复制提示词。
3. 在 ChatGPT 中上传参考图、用提示词生成图片，再下载完整原图。
4. 回到接力卡片上传 PNG/JPEG/WebP（单张最大 20 MB），原 Agent 任务会继续看图、评分和审核；不通过时仍可提出意见或再次接力。

刷新页面不会丢失接力卡片。默认最多等待 24 小时，可用 `MANUAL_IMAGE_TIMEOUT_MS` 调整（100 ms–7 天）；「取消并停止本次运行」会停止该项目原任务。提示词和参考图持久保存在项目的 `handoffs/` 目录。原运行中断、超时或服务重启后，仍可上传结果，再点击「继续审核」创建新的导入/审核任务；已入库的同一接力结果不会重复入库。若 Agent 凭证不可用，图片仍保留为待审核素材；demo 下接续只入库，交给人工审核。接力资料不包含在现有项目备份 ZIP 中。

仅想在下拉框启用人工通道可设置 `MANUAL_IMAGE_ENABLED=true`。Codex 订阅生图和人工接力都计入图像次数预算，但不按 Platform API 单价估算；Codex 生图实际消耗订阅额度/credits，人工流程的使用量以 ChatGPT 页面为准。图像次数上限、停止和后处理仍沿用项目原有逻辑。

### 使用 Seedream 5.0 Flash 出图

没有 OpenAI / Gemini 图像 key 时，可以直接接入火山方舟：

```dotenv
ARK_API_KEY=你的火山方舟密钥
SEEDREAM_MODEL=doubao-seedream-5-0-flash-260915
SEEDREAM_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
SEEDREAM_SIZE=2K
SEEDREAM_WATERMARK=false
SEEDREAM_RESPONSE_FORMAT=b64_json
```

保留你的 `AGENT_PROVIDER=deepseek` 或 `gpt` 配置，去掉 `AGENT_MODE=demo` 后重启，在「图像模型」中选择 **Doubao Seedream 5.0 Flash（火山方舟）**。如果 Seedream 是第一个已配置的图像通道，会自动选中；GPT 使用 API key 时也会启用 OpenAI 图像通道，请显式选择 Seedream。HTTP 运行或直接重生成请求传入 `"provider": "seedream"` 即可。

通道通过方舟的 JSON `/images/generations` 接口传入参考图，使用指定的 Flash 模型，默认返回 Base64 编码的 PNG；也支持 `SEEDREAM_RESPONSE_FORMAT=url`，拿到临时链接后立即下载保存，不把方舟 key 发给图片下载地址。一次请求只生成一张图，不开启图层拆分或组图；批量素材仍由 Agent 逐张规划、并行调用和审核。官方说明见 [Seedream 5.0 pro / flash 教程](https://docs.volcengine.com/docs/ark/seedream-5-0-pro?lang=zh) 和 [Image generation API](https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh)。

`SEEDREAM_SIZE` 支持 `1K` / `1.5K` / `2K`（默认）。为固定画布比例，实际请求使用以下宽高；精灵表则按帧数计算单行画布，保持每格为正方形，支持 2–16 帧。

| 档位 | 正方形 | 横图 | 竖图 |
|---|---|---|---|
| 1K | 1024×1024 | 1280×720 | 720×1280 |
| 1.5K | 1536×1536 | 1920×1080 | 1080×1920 |
| 2K | 2048×2048 | 2560×1440 | 1440×2560 |

最多发送 10 张参考图：先放 `consistency_asset_ids` 指定的已有素材，再放项目风格参考图；超限时保留前 10 张并在任务日志中提示。当前项目会将参考图压缩为 JPEG，而 Seedream 原生透明模式要求仅输入一张带透明通道的图，因此本通道为透明素材请求纯白背景，再复用本地去背景流程，保留原图以便调整容差。`SEEDREAM_WATERMARK=true` 可开启右下角的可见水印，默认关闭。

用量按 `seedream` 通道累计，可配置 `IMAGE_PRICE_SEEDREAM`（美元/张）估算费用；留空则只统计次数，费用显示未知且不计入美元预算。不要直接填人民币单价；参考图数量、分辨率等带来的实际费用以方舟账单为准。方舟 key 仅保存在服务端环境配置中，不需要在聊天或前端填写。

### 演示模式

没有任何 key 时可先体验界面：

```bash
AGENT_MODE=demo npm start
```

演示模式不调用 Agent 模型，用脚本跑一遍「风格提取 → 生成 → 入库」，图像用本地 Mock 占位图。

## 部署

### Docker

```bash
cp .env.example .env          # 填入 key
docker compose up -d --build  # http://localhost:5173
```

数据保存在名为 `asset-data` 的卷里（容器内 `/data`）。改端口：`PORT=8080 docker compose up -d`。

不用 compose 时：

```bash
docker build -t game-asset-agent .
docker run -d -p 5173:5173 --env-file .env -v gaa-data:/data game-asset-agent
```

镜像为多阶段构建：先把 TypeScript 编译到 `dist/`，运行层只装生产依赖，以非 root 的 `node` 用户运行，并带 `/healthz` 健康检查。

### 直接用 Node（≥ 22）

```bash
npm ci && npm run build
NODE_ENV=production npm run start:prod
```

### 上线前注意

- 公网部署务必设置 `ACCESS_TOKEN`：开启后打开页面需先输入令牌登录（会话保存在 HttpOnly Cookie，30 天），脚本可用 `Authorization: Bearer <令牌>` 调 API；`/healthz` 始终开放供健康检查。不设置时任何能访问端口的人都能用你的 API 额度。
- 生成任务记录在内存里，同一份数据目录只运行**一个实例**；重启会中断进行中的任务（已生成的素材不受影响）。
- SSE 实时日志需要反向代理关闭缓冲（Nginx：`proxy_buffering off;`）。
- 登录失败按 IP 限速（默认 10 分钟 10 次）。在反向代理后面时设置 `TRUST_PROXY=1`（或 `loopback`），否则所有请求都会被当成代理的 IP。
- 响应默认带 CSP、`nosniff`、禁止被嵌入 iframe 等安全头。

## 开发

```bash
npm run typecheck   # tsc（strict + 未使用变量/参数检查，含 test/）
npm run lint        # ESLint，检查无类型检查的前端模块 public/js
npm test            # node:test + tsx：存储、工具校验、图像通道、图像处理、图集、ZIP、计费、鉴权与 HTTP API
npm run coverage    # 测试 + 覆盖率（行 ≥ 90%、分支 ≥ 80%、函数 ≥ 85%，CI 同样要求）
npm run check       # 以上全部
```

测试使用临时 `DATA_DIR`，API 测试以演示模式在随机端口启动应用，不需要任何 API key。

## 架构

```
public/
  index.html             单页界面（原生 ES modules，无构建步骤）
  js/                    main（入口）· state · lib（DOM/HTTP 工具）· projects · refs · styleGuide
                         · assets（素材网格）· batch（批量）· run（运行与 SSE 日志）· usage（用量）· login
  js/viewer/             查看器：index（审核、版本、快捷键）· compare · sprite · tile · palette · sizes
                         · cutout · prompt —— 每个区块导出 html / load / bind
  css/                   base · layout · style-panel · run · assets · viewer · usage
src/
  server.ts              入口：读取 .env 并监听端口
  app.ts                 createApp()：组装中间件与路由（测试可直接挂载）
  config.ts              环境变量配置
  domain/assetTypes.ts   素材类型定义
  routes/                config · projects · refs · assets · export · jobs（运行/SSE）· usage
  ops/assetOps.ts        后处理（抠图、无缝化、帧对齐、切帧），HTTP 接口与 Agent 工具共用
  agent/                 Claude / DeepSeek / GPT 智能体
    tools.ts / schemas.ts  工具定义与 zod 输入校验
    prompts.ts             系统提示词与每轮开场
    loop.ts                手写 tool-use 循环（Anthropic TypeScript SDK）
    gpt.ts / prepare.ts     GPT Responses 循环 / 共用的参考图、重画与对话准备
    runTool.ts / assets.ts 工具执行、生成素材入库、精灵表切帧
    events.ts / jobs.ts    任务注册、事件广播、启动与收尾
    demo.ts / manual.ts    无 key 演示模式 / 改 prompt 直接重生成
    budget.ts              单次运行预算
  providers/             图像通道：openai · gemini · seedream · sdwebui · codexImage · chatgptManual · mock
  handoff/               人工生图接力：提示词与参考图导出、等待、上传与中断后接续
  openai/                ChatGPT OAuth 登录、账号与令牌管理、终端登录入口
  image/                 sharp 图像处理：io · background（抠图）· spriteSheet · tiles · sizes
  export/                ZIP 写入与素材包组装
  usage/                 tokens / 图像调用统计与费用估算
  store/                 文件系统存储（data/projects/<id>/）：projects · conversation · usage
```

Agent 工具：

| 工具 | 作用 |
|---|---|
| `save_style_guide` | 保存从参考图提炼的风格指南（含英文 `prompt_prefix`） |
| `generate_image` | 调用图像模型；自动附带参考图，可额外附带已有素材；结果图片和色板检测回传给 Agent 查看 |
| `review_asset` | 记录通过/驳回、一致性评分和原因 |
| `fix_tile_seams` | 瓦片接缝检测不通过时边缘融合成无缝版本（不调用图像模型） |
| `align_sprite_frames` | 精灵表帧抖动时按锚点对齐各帧（不调用图像模型） |
| `remove_background` | 换个容差重新抠背景（不调用图像模型） |
| `snap_to_palette` | 平涂 / 像素风素材出现色板外颜色时，把颜色吸附到风格色板（不调用图像模型） |

Claude 默认模型 `claude-opus-5-5`（adaptive thinking，effort 可通过 `CLAUDE_EFFORT` 调整），已开启服务端 refusal fallback（`fallbacks: "default"`）和 prompt caching。DeepSeek 通过兼容 Messages API 复用同一套工具、视觉审核、流式日志与预算限制，仅发送其支持的参数。GPT 使用官方 OpenAI SDK 的 Responses API，工具按 namespace 分组，保留加密推理上下文，支持 API key 与 ChatGPT 订阅两种鉴权。

用量面板统计所选 Agent 模型。DeepSeek Flash 按官方峰时价保守估算，可通过 `DEEPSEEK_PRICE` 覆盖（输入、输出、缓存写、缓存读，美元/百万 tokens）；实际费用以服务商账单为准。图像单价另行配置。

## 配置

见 [.env.example](.env.example)。数据保存在 `data/`（已 gitignore）。

## HTTP API

界面能做的事都可以用接口完成（批量生成、导出、审核等），见 [docs/api.md](docs/api.md)，含一个从建项目到下载图集的脚本示例。设置了 `ACCESS_TOKEN` 时用 `Authorization: Bearer <令牌>` 调用。

## License

MIT
