# HTTP API

前端用到的接口都可以直接调用，方便写脚本批量生成或集成到自己的工具链。所有请求和响应都是 JSON（上传与下载除外）。

- 基础地址：`http://localhost:5173`
- 错误响应：`{ "error": "原因" }`，状态码 400（参数不对）、401（未登录）、404（不存在）、409（冲突）、500
- id 格式：项目 `prj_…`，素材 `ast_…`，参考图 `ref_…`，任务 `job_…`

## 鉴权

设置了 `ACCESS_TOKEN` 时，除 `/healthz`、登录页和 `POST /api/login` 外都需要鉴权。脚本里直接带请求头即可：

```bash
curl -H "Authorization: Bearer $ACCESS_TOKEN" http://localhost:5173/api/projects
```

浏览器则通过登录接口拿到 HttpOnly 会话 Cookie。

### `POST /api/login`

请求 `{ "token": "…" }`。成功返回 `{ "ok": true }` 并设置 `gaa_session` Cookie（30 天），令牌错误返回 401。

### `POST /api/logout`

清除会话 Cookie。

### `GET /healthz`

存活检查，始终不需要鉴权。返回 `{ "ok": true }`。

## 配置

### `GET /api/config`

```json
{
  "providers": [{ "id": "openai", "label": "OpenAI gpt-image", "available": true }],
  "assetTypes": { "item_icon": "道具 / 装备图标" },
  "sizePresets": { "item_icon": ["16", "32", "64", "128"] },
  "demo": false,
  "agent": { "provider": "gpt", "model": "gpt-6.1-sol", "authMode": "chatgpt" },
  "auth": true,
  "budget": { "maxImages": 40, "maxUsd": null }
}
```

图像通道 id：`openai`、`gemini`、`seedream`、`sdwebui`、`mock`。素材类型：`character`、`sprite_sheet`、`enemy`、`item_icon`、`tile`、`prop`、`background`、`ui`、`vfx`、`portrait`。

Seedream 配置 `ARK_API_KEY` 后可用，默认模型 `doubao-seedream-5-0-flash-260915`；可通过 `SEEDREAM_MODEL`、`SEEDREAM_BASE_URL` 覆盖。`SEEDREAM_SIZE=1K|1.5K|2K`（默认 `2K`）按素材横竖比例或精灵帧数计算像素宽高。`SEEDREAM_RESPONSE_FORMAT=b64_json|url`（默认 `b64_json`）返回的图片均保存到项目本地，`SEEDREAM_WATERMARK=false|true`（默认 `false`）控制可见水印。最多发送 10 张参考图，已有素材参考优先，超限时日志提示。透明素材先生成纯白背景，再复用本地去背景处理。运行与直接重生成的 `provider` 均可传 `"seedream"`，不需要新增调用接口。

`agent` 返回服务器选择的 Agent 服务商与模型。通过 `.env` 设置 `AGENT_PROVIDER=claude|deepseek|gpt`（默认 `claude`）；DeepSeek 配置 `DEEPSEEK_API_KEY` 与 `DEEPSEEK_MODEL=deepseek-flash`，无需 Claude key。默认 `DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic`，思考强度 `DEEPSEEK_EFFORT=low|high|max`（默认 `high`）。GPT 默认 `GPT_MODEL=gpt-6.1-sol`，`GPT_EFFORT=low|medium|high|xhigh|max`（默认 `medium`）；`GPT_AUTH_MODE=api_key` 使用 `OPENAI_API_KEY` 按量付费，`chatgpt` 使用下述官方订阅登录。只有 GPT 返回 `agent.authMode`。API key 模式可设置 `GPT_BASE_URL`；订阅模式固定使用官方地址且不会自动切换成付费 API。

图像通道与 Agent 独立，运行请求里的 `provider` 仍只选择图像通道。切换 Agent 服务商、模型、鉴权模式或 ChatGPT 账号后，下一次运行自动开启新对话。

## ChatGPT 订阅连接

以下接口仍受 `ACCESS_TOKEN` 鉴权保护，并且只允许本机直接访问（`localhost` / `127.0.0.1` / IPv6 loopback），拒绝代理转发。POST 必须为同源 JSON 请求。回调由临时的 `127.0.0.1:<port>/auth/callback` 监听器处理，登录最多等待 10 分钟。凭证仅保存在服务器的 `DATA_DIR/auth/chatgpt.json`，不通过这些接口返回。远程自托管可先运行本机 `npm run chatgpt:login` 再安全转移凭证，见 README。

### `GET /api/chatgpt/status`

返回 `{ activeAccountId?, connected, planEnabled, accounts: [{ id, email?, label, connected, planEnabled }], attempt?: { id, status, error? } }`。账号 id 是注册的 `oaiapp_…` 客户端 id；相同邮箱的不同工作区独立列出。`attempt.status` 为 `pending` / `complete` / `error`。`connected` 表示本地保存了登录令牌；能否实际使用模型仍以服务端授权和额度为准。

### `POST /api/chatgpt/login`

请求 `{}` 添加账号；`{ "accountId": "oaiapp_…" }` 重新授权已有账号。返回 `{ url, attemptId }`，由用户打开 `url` 完成登录，随后轮询 status。URL 可能携带官方登录提示信息，不应记录到日志或转发给其他人。身份验证完成后才会切换当前账号；授权未包含订阅权限时 `planEnabled=false`，不允许执行 Agent 推理。

### `POST /api/chatgpt/account`

请求 `{ "accountId": "oaiapp_…" }` 选择已有账号，返回更新后的 status；会停止进行中的订阅 Agent 任务，防止混用账号上下文。

### `POST /api/chatgpt/cancel`

请求 `{}`，取消进行中的登录并关闭临时回调监听器，返回更新后的 status。已有登录账号保留，可重新发起登录。

### `GET /api/chatgpt/models`

用当前订阅账号查询官方可用模型，返回 `{ models: [{ id, name }] }`。将模型 id 配置到 `.env` 的 `GPT_MODEL`，重启后生效。

### `POST /api/chatgpt/logout`

请求 `{ "accountId": "oaiapp_…" }`。停止订阅 Agent 任务，尝试撤销远程会话并清除该账号本地令牌，保留账号注册用于以后重登。返回 `{ revoked, message }`；`revoked=false` 时本地令牌仍已清除，用户需要在 ChatGPT 设置中确认断开应用。

## 项目

### `GET /api/projects`

项目列表（新的在前）：`[{ id, name, createdAt, assets, cover }]`，`assets` 为素材数量。

### `POST /api/projects`

请求 `{ "name": "蘑菇森林" }`，返回完整项目对象。

### `GET /api/projects/:id`

完整项目：`{ id, name, createdAt, refs: [...], styleGuide, assets: [...] }`。

### `PATCH /api/projects/:id`

`{ "name": "新名字" }` 改名；`{ "resetStyle": true }` 清空风格指南（下次运行重新提炼）。

### `DELETE /api/projects/:id`

删除项目及其全部文件。

### `PUT /api/projects/:id/style-guide`

整体替换风格指南。字段：`summary`、`palette`（至少 3 个 `{ hex: "#RRGGBB", role }`）、`rendering`、`line_and_edges`、`lighting_and_shading`、`perspective`、`proportions`、`texture_and_detail`、`mood`、`avoid`（字符串数组）、`prompt_prefix`（≥ 20 字符）。

### `GET /api/projects/:id/style-history`

风格指南的历史版本（最多 50 个，新的在前）：`[{ index, at, source, styleGuide, changed }]`。`source` 为 `agent`、`user`、`restore`、`import`（启用历史前就存在的版本）；`changed` 列出与当前风格指南不同的字段，空数组表示与当前相同。

### `POST /api/projects/:id/style-history/:index/restore`

把某个历史版本设为当前风格指南（记为一个新的 `restore` 版本），返回更新后的项目。

### `GET /api/projects/:id/conversation`

与 Agent 的对话概况：`{ runs: [{ request, at }], bytes }`。

### `DELETE /api/projects/:id/conversation`

清空对话记忆（风格指南与素材保留）。

### `GET /api/projects/:id/files/*rel`

读取参考图或素材文件，`rel` 形如 `assets/ast_xxx.png`、`refs/ref_xxx.png`。

### `GET /api/projects/:id/thumbs/*rel`

参考图或素材的 WebP 缩略图：`?w=160|320|640`（默认 320）。首次请求时生成并缓存，源文件更新后自动重建；GIF 保持动画，像素风用最近邻缩放。

### `GET /api/projects/:id/storage`

磁盘占用：`{ bytes }`。

### `POST /api/projects/:id/cleanup`

删除不属于任何素材或参考图的文件：`{ removed, bytes }`。有任务运行时返回 409。

### `GET /api/projects/:id/backup.zip`

整个项目的备份（项目数据、对话、用量记录、全部文件）。

### `POST /api/projects/import`

`multipart/form-data`，字段 `backup` 为备份 zip。恢复为新项目：`{ project, skipped }`，`skipped` 列出因缺文件或格式无效而跳过的内容。

## 参考图

### `POST /api/projects/:id/refs`

`multipart/form-data`，字段 `images`（可多个，最多 8 张，png / jpg / webp / gif，单张 ≤ 20 MB）。返回更新后的项目。

### `PATCH /api/projects/:id/refs/:refId`

参考图备注：`{ "note": "只参考配色" }`（≤ 200 字，空字符串清除）。备注会按「Reference N」编号随每次运行发给 Agent。返回更新后的项目。

### `DELETE /api/projects/:id/refs/:refId`

删除参考图及其文件，返回更新后的项目。

## 运行

### `POST /api/projects/:id/run`

启动一次生成，立即返回 `{ "jobId": "job_…" }`；进度从事件流读取。同一项目已有任务时返回 409，并带上正在运行的 `jobId`。

```json
{
  "request": "6 个道具图标：回血蘑菇、毒蘑菇、木剑、铁盾、金币、钥匙",
  "assetTypes": ["item_icon"],
  "provider": "openai",
  "continueConversation": true,
  "budget": { "maxImages": 12, "maxUsd": 2 },
  "redraws": [{ "assetId": "ast_…", "feedback": "剑身改成蓝色" }]
}
```

除 `request` 外都可省略。`budget` 中省略的字段用服务器默认值，`0` 表示不限。`redraws` 让 Agent 按各自的意见重画这些素材（一次最多 10 个），也接受旧的单个 `redraw` 字段。

### `GET /api/jobs/:id/events`

Server-Sent Events。连接后先回放已发生的事件，再实时推送，直到 `done`。每条 `data:` 是一个 JSON：

| `type` | 字段 | 说明 |
|---|---|---|
| `status` | `text` | 进度提示（启动、重试、预算、停止等） |
| `text` | `delta` | Agent 回复的增量文字 |
| `thinking` | `text` | 思考摘要 |
| `tool` | `name`, `input` | Agent 调用了工具 |
| `style` | `styleGuide` | 风格指南已保存 |
| `asset` | `asset` | 新素材或素材状态变化 |
| `usage` | `usage` | 本次运行的最新用量（只回放最后一条） |
| `error` | `message` | 运行出错 |
| `done` | | 结束 |

```bash
curl -N http://localhost:5173/api/jobs/job_xxx/events
```

### `POST /api/projects/:id/assets/:assetId/regenerate`

用编辑后的 prompt 直接调用图像模型生成新版本（不经过 Agent，不消耗 Agent tokens）：`{ "prompt": "…", "provider": "openai", "budget": {…} }`。返回 `{ jobId }`，进度同样从事件流读取；新素材待审核，`parentId` 指向原素材。用量记录的 `mode` 为 `manual`。

### `POST /api/jobs/:id/stop`

中止任务（已生成的素材保留）。

## 素材

### `PATCH /api/projects/:id/assets/:assetId`

人工审核与编辑，字段任选：`{ "status": "approved" | "rejected" | "pending_review", "notes": "意见", "name": "新名称", "tags": ["第一关"] }`（标签最多 10 个、每个 ≤ 20 字，空数组清除）。返回更新后的素材。

### `DELETE /api/projects/:id/assets/:assetId`

把素材移到回收站（`project.trash`，带 `deletedAt`，文件保留 `TRASH_DAYS` 天，默认 7）。`?permanent=1` 立即彻底删除素材及其文件。返回更新后的项目。

### `POST /api/projects/:id/assets/batch`

`{ "action": "approve" | "reject" | "pending" | "delete" | "restore" | "purge", "ids": ["ast_…"] }`，返回 `{ affected, project }`。`delete` 移到回收站，`restore` 从回收站恢复，`purge` 彻底删除（素材库或回收站中的都可以）；`"tag"` / `"untag"` 需额外带 `"tags": ["…"]`，为所选素材添加或移除标签。

### `POST /api/projects/:id/trash/empty`

清空回收站（彻底删除其中所有素材及文件），返回 `{ affected, project }`。

### `POST /api/projects/:id/assets/:assetId/slice`

精灵表切帧：`{ "frames": 6, "fps": 10 }`（帧数省略时自动检测）。返回更新后的素材（含 `frames`、`gif`）。

### `POST /api/projects/:id/assets/:assetId/cutout`

去除背景：`{ "tolerance": 28 }`（1-120）；`{ "restore": true }` 恢复原图。

### `GET /api/projects/:id/assets/:assetId/seams`

瓦片接缝检测：`{ horizontalDiff, verticalDiff, baseline, horizontalOk, verticalOk, seamless, … }`。

### `GET /api/projects/:id/assets/:assetId/tiled.png`

`?n=3` 平铺 n×n 的预览图（2-6）。

### `POST /api/projects/:id/assets/:assetId/make-seamless`

瓦片无缝化：`{ "overlap": 0.15 }`（0.04-0.4）。生成待审核的新版本素材（`parentId` 指向原图）并返回。

### `GET /api/projects/:id/assets/:assetId/sized.png`

缩放到游戏尺寸：`?size=32` 或 `?size=1280x720`（8-4096），`&kernel=nearest|smooth`（默认按风格自动判断像素风），`&download=1` 作为附件下载。

### `GET /api/projects/:id/assets/:assetId/palette`

色板一致性：`?threshold=20`（ΔE）。返回 `{ coverage, meanDeltaE, usage, offPalette, pixels, threshold }`。

### `POST /api/projects/:id/assets/:assetId/snap-palette`

把每个像素换成最接近的风格色板颜色（Lab 色差），生成新版本：`{ "dither": "none" | "ordered" }`（有序抖动保留渐变感）。返回 `{ asset, before, after }`，后两者为吸附前后的色板检测结果。

### `GET /api/projects/:id/assets/:assetId/jitter`

精灵表帧抖动：`?mode=bottom|center`，返回 `{ horizontal, vertical }`（像素）。

### `POST /api/projects/:id/assets/:assetId/align-frames`

对齐精灵帧：`{ "mode": "bottom" | "center" }`。生成新版本，返回 `{ asset, before, after }`。

## 导出

### `GET /api/projects/:id/export.zip`

按类型分目录的素材包，附 `manifest.json`、`style-guide.json`、参考图。精灵表带切帧、GIF 与 Godot 4 `.tres`。

- 默认只含已通过素材；`?status=all` 全部；`?ids=ast_a,ast_b` 指定素材（不限状态）；`?tag=第一关` 只含带该标签的素材（可与前两者组合）
- `?sizes=1` 追加各类型常用尺寸
- `?godot=game/art` 指定 `.tres` 里的 `res://` 目录（默认 `assets`）

### `GET /api/projects/:id/export-atlas.zip`

图集：`atlas.png` + `atlas.json`（TexturePacker JSON Hash，Phaser / PixiJS 可直接加载）、`animations.json`（Phaser 3 动画）。背景图不进图集。

- `?max=256` 单个精灵最长边（16-1024），`?size=2048` 图集页尺寸（512 / 1024 / 2048 / 4096），放不下时分多页 `atlas_0`、`atlas_1`…
- `?status=all`、`?ids=`、`?tag=` 同上

## 用量

### `GET /api/projects/:id/usage`

```json
{
  "summary": { "runs": 3, "claudeRequests": 12, "tokens": { "input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0 }, "images": { "calls": 18, "failed": 1 }, "cost": { "claude": 0.84, "images": null, "total": 0.84 } },
  "runs": [{ "jobId": "job_…", "request": "…", "status": "ok", "mode": "agent", "claude": { "requests": 4, "byModel": {} }, "images": { "calls": 6, "failed": 0, "byProvider": {} }, "cost": {}, "budget": {} }]
}
```

`cost` 中为 `null` 的部分表示缺少单价（如未配置 `IMAGE_PRICE_OPENAI`），未计入合计。运行状态：`running`、`ok`、`error`、`stopped`、`interrupted`。

Seedream 的调用次数见 `images.byProvider.seedream`，可用 `IMAGE_PRICE_SEEDREAM` 设置美元/张的估算单价；留空时仍统计调用次数，图像费用为未知，不计入美元预算。方舟人民币单价需先换算，不应直接填写。实际费用以服务商账单为准。

为兼容已有客户端，`claude`、`claudeRequests`、`cost.claude` 字段名保留，均表示 Agent 模型用量（包括 DeepSeek、GPT）；实际模型见 `claude.byModel`。GPT 运行额外记录 `agent: { provider: "gpt", model, authMode: "api_key" | "chatgpt" }`。订阅模式 token 正常累计，`cost.claude=0` 表示未按 Platform API 计费；图像费用继续统计。DeepSeek Flash 内置官方峰时价保守估算，GPT 默认模型按标准短上下文价估算；可分别用 `DEEPSEEK_PRICE`、`GPT_PRICE` 覆盖（输入、输出、缓存写、缓存读，美元/百万 tokens），与 `CLAUDE_PRICE` 分开生效。

## 示例：脚本批量生成并下载图集

```bash
BASE=http://localhost:5173
AUTH="Authorization: Bearer $ACCESS_TOKEN"
P=$(curl -s -H "$AUTH" -H 'Content-Type: application/json' -d '{"name":"批量"}' $BASE/api/projects | jq -r .id)
curl -s -H "$AUTH" -F images=@ref1.png -F images=@ref2.png $BASE/api/projects/$P/refs > /dev/null
JOB=$(curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"request":"8 个 RPG 道具图标","assetTypes":["item_icon"],"budget":{"maxImages":16}}' \
  $BASE/api/projects/$P/run | jq -r .jobId)
curl -sN -H "$AUTH" $BASE/api/jobs/$JOB/events | grep -m1 '"type":"done"'
curl -s -H "$AUTH" -o atlas.zip "$BASE/api/projects/$P/export-atlas.zip?max=128"
```
