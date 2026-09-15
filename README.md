# all-web-to-md

把任意网页一键转成干净的 Markdown（含原文标题、图片本地化、可选 OCR 识别、可选大模型精炼），最终打包成 ZIP 下载。

[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![monorepo](https://img.shields.io/badge/npm-workspaces-ff69b4)](https://docs.npmjs.com/cli/v10/using-npm/workspaces)
[![ocr](https://img.shields.io/badge/ocr-PaddleOCR--VL-1.6-3cf)](https://aistudio.baidu.com/aidemo/aiocr/aiocr)

## ✨ 核心特性

- **双通路提取**：DOM 解析（Readability + cheerio）→ 失败时 Playwright 动态渲染 + 分屏截图 OCR，两路可自动降级或强制 OCR
- **长图友好**：相邻分屏 180px 重叠 + LCS 接缝去重，避免跨屏断句丢字
- **PaddleOCR-VL 异步 Jobs**：AIStudio 官方云端模型，支持表格/图表/公式，10010 队列满自动退避重试，pending/running/done 状态实时透出
- **可选大模型精炼**：OpenAI 兼容接口，内置智谱 GLM / DeepSeek 预设
- **图片本地化**：正文图片自动下载到 `images/`，ZIP 一并打包
- **实时进度**：SSE 推送，浏览器端 9 阶段可视化 + 云端排队/识别状态

---

## 🧱 技术说明

### 架构

```
┌─────────────────────────────────────────────────────────┐
│                      npm workspaces                      │
├─────────────────────────┬───────────────────────────────┤
│   packages/server        │   packages/web                │
│   Fastify + TS          │   Vite + React + TS           │
│   端口 8787              │   Tailwind CSS                 │
│   生产托管 web/dist       │   开发代理 → 8787             │
└─────────────────────────┴───────────────────────────────┘
         │                            ▲
         ▼                            │
┌─────────────────────────────────────────────────────────┐
│  九阶段流水线 (services/pipeline.ts)                       │
│  fetch → extract → render → screenshot → ocr →            │
│  convert → llm → images → package                        │
└─────────────────────────────────────────────────────────┘
         │
         ├─ AIStudio PaddleOCR-VL (POST jobs → 轮询 → JSONL)
         ├─ Playwright Chromium (分屏截图)
         └─ Readability + Turndown (HTML→Markdown)
```

### 技术栈

| 层 | 技术 |
|----|----|
| 后端框架 | Fastify 5 + TypeScript 5 |
| DOM 提取 | Readability (Mozilla) + cheerio + jsdom + jschardet + iconv-lite（支持 GBK 页面） |
| 截图 OCR | Playwright 1.49 + PaddleOCR-VL 1.6（异步 Jobs API） |
| HTML→MD | Turndown 7 + turndown-plugin-gfm 1.0（自定义图片/代码块/图注规则） |
| 图片本地化 | fetch 下载 → 内容哈希命名（SHA-1 前 7 位） |
| 打包 | adm-zip（Markdown + images/） |
| 前端 | React 18 + Vite 6 + Tailwind 4 + lucide-react |
| 通信 | REST（POST /api/convert, GET /api/jobs/:id）+ SSE（GET /api/jobs/:id/events） |
| 持久化 | 本地文件 `data/jobs.json` + `data/settings.json`（明文，生产需替换） |

### OCR 分屏与拼接

页面高度超过 900px 时分屏截图，参数：

- `VIEWPORT_WIDTH=1280, VIEWPORT_HEIGHT=900`
- `TILE_OVERLAP_PX=180`（相邻分屏重叠 180px，确保跨边界文字不会被截断）
- `MAX_TILES=20`（单页上限，防止超长页面无限调用）

`utils/text.ts` 中 `stitchOcrParts()` 通过 **LCS 接缝去重** 把多分屏 OCR 文本拼回完整正文：

1. 上一屏末尾若是残句（无句末标点）且开头片段在下一屏中重现 → 删除残行（完整版本在下一屏）
2. 定位两屏接缝附近最长公共子串（≥12 字符，必须贴近接缝）→ 下一屏丢弃锚点及之前的全部内容
3. 找不到可靠锚点时原样拼接（宁可重复，不可丢字）

### OCR API 协议（PaddleOCR-VL 异步 Jobs）

```
POST https://paddleocr.aistudio-app.com/api/v2/ocr/jobs
Authorization: bearer <TOKEN>
Content-Type: multipart/form-data

file: <截图 PNG, 字段名必须是 file>
model: PaddleOCR-VL-1.6
optionalPayload: JSON string
  { useDocOrientationClassify, useDocUnwarping, useChartRecognition }
```

提交成功返回 `{"data": {"jobId": "..."}}`，然后轮询：

```
GET https://paddleocr.aistudio-app.com/api/v2/ocr/jobs/{jobId}
→ state: pending | running | done | failed
→ extractProgress: { totalPages, extractedPages, startTime, endTime }
→ resultUrl.jsonUrl: JSONL 结果地址（签名 URL，7 天有效）
```

JSONL 每一行结构：

```json
{
  "result": {
    "layoutParsingResults": [{
      "markdown": {
        "text": "## 识别出的 Markdown 文本，图片用占位 key 引用",
        "images": { "imgs/img_xxx.jpg": "https://...?authorization=..." }
      },
      "outputImages": { ... }
    }]
  }
}
```

### 流水线降级策略

| 条件 | 动作 |
|------|------|
| Readability 提取 < 300 字 | 自动 Playwright 渲染重试 |
| `ocrMode=force` 或低质量 + OCR 启用 | 强制分屏截图 OCR |
| OCR 全部分屏失败 | 回退 DOM 结果，错误原因写入事件流 |
| 单屏 OCR 300s 未完成 | 客户端超时报错，服务端任务可能仍在执行（可稍后重试） |

---

## 🚀 启动说明

### 环境要求

- Node.js ≥ 20（推荐 22+，Windows / macOS / Linux 均可）
- npm 10+（随 Node 一起安装）
- Playwright Chromium（首次运行会自动下载，国内建议先设置镜像）

### 国内环境（Chromium 镜像）

```bash
# 首次安装 Playwright 之前设置镜像
set PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright
npm install
npx playwright install chromium
```

### 安装

```bash
git clone https://github.com/BerserkerHercules/web2md.git
cd web2md
npm install
```

### 开发模式（推荐）

同时启动后端 + 前端热更新：

```bash
npm run dev
# 后端：http://127.0.0.1:8787
# 前端：http://127.0.0.1:5173  （自动代理到后端）
```

也可以单独启动：

```bash
npm run dev:server   # 仅后端 tsx watch
npm run dev:web      # 仅前端 vite
```

### 生产模式

```bash
npm run build   # 编译 server + 构建 web 到 packages/web/dist/
npm run start   # 启动后端，自动托管 web/dist
# 访问 http://127.0.0.1:8787
```

### 类型检查

```bash
npm run typecheck
```

---

## 🔑 Key 配置说明

### PaddleOCR-VL Token（AIStudio）

1. 访问 [AIStudio OCR](https://aistudio.baidu.com/aidemo/aiocr/aiocr) 申请 / 登录
2. 在 [用户中心](https://aistudio.baidu.com/aistudio/usercenter) 查看自己的 **API Token**（形如 `2394dcde...a25ab573c514216`）
3. 在项目里配置 Token 有两种方式：

#### 方式 A：前端设置弹窗（最简单）

打开应用 → 右上角 **设置** → **OCR 设置** → 选择 `AIStudio PaddleOCR-VL 官方云服务（异步 Jobs API）` → 填入 Token → 点击 **测试连接** → **保存**

其他字段保持默认即可：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| Token | （必填） | AIStudio 个人 API Token |
| 模型 | PaddleOCR-VL-1.6 | 最新旗舰 OCR-VL 模型 |
| Jobs API 地址 | https://paddleocr.aistudio-app.com/api/v2/ocr/jobs | 一般不需要改 |
| 文档方向分类 | 关闭 | 只在识别旋转拍摄的文档时开启 |
| 文档扭曲矫正 | 关闭 | 只在扫描件有弯曲时开启 |
| 图表识别 | 关闭 | 文档含结构化表格/图表时开启 |

#### 方式 B：直接调 REST API

```bash
curl -X PUT http://127.0.0.1:8787/api/settings \
  -H "Content-Type: application/json" \
  -d '{
    "ocr": {
      "enabled": true,
      "provider": "aistudio",
      "token": "YOUR_TOKEN_HERE",
      "model": "PaddleOCR-VL-1.6",
      "endpoint": "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs",
      "useDocOrientationClassify": false,
      "useDocUnwarping": false,
      "useChartRecognition": false
    },
    "llm": { "enabled": false, "provider": "zhipu" }
  }'
```

### 大模型精炼（可选）

当前端勾选"启用大模型精炼"时才需要配置。内置智谱、DeepSeek 预设，自定义任何 OpenAI 兼容端点均可：

| 提供商 | baseUrl | 获取 Key |
|--------|---------|---------|
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | https://open.bigmodel.cn/usercenter/apikeys |
| DeepSeek | `https://api.deepseek.com` | https://platform.deepseek.com/api_keys |
| 自定义 | （任意 OpenAI 兼容端点） | — |

### Token 安全

- 所有敏感配置明文保存在 `data/settings.json`（项目运行时自动创建，已在 `.gitignore` 中排除）
- 后端进程内不打印 Token、不写入日志
- 配置接口仅监听 `127.0.0.1`（生产部署到公网时务必加反向代理鉴权）

### 自建 OCR 服务（可选）

若自建服务，选择 `自建 HTTP 服务`，约定：`POST {endpoint}` body 为图片二进制 → 返回 `{ text }` 或 `{ results: [{ text }] }`

---

## 🖥️ 使用说明

### Web UI

1. 顶部输入目标网址（例：`https://example.com`）
2. 可选：
   - **强制 OCR**：忽略 DOM 提取质量，始终走截图识别（适用于整屏都是图的文章）
   - **启用大模型精炼**：在 OCR/DOM 文本基础上再让模型整理一遍排版
   - **包含原文链接**：在 Markdown 开头写入原文 URL
3. 点击 **开始转换**，实时看到九阶段进度条
4. 完成后点击 **下载 ZIP**（含 `.md` + `images/`），或在下方卡片里预览 Markdown
5. 左侧历史列表可回看之前所有转换结果

### REST API（程序化调用）

```bash
# 提交任务（返回 jobId）
curl -X POST http://127.0.0.1:8787/api/convert \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "ocrMode": "force",       // auto | force | never
    "useLlm": false,
    "includeSource": true
  }'
# → { "jobId": "xxxxxxxxxx" }

# 轮询结果（含 markdown 内容）
curl http://127.0.0.1:8787/api/jobs/{jobId}
# → { "status": "done", "markdown": "# Example...", "stats": {...} }

# 或 SSE 订阅实时事件（浏览器 EventSource / curl -N）
curl -N http://127.0.0.1:8787/api/jobs/{jobId}/events
```

### 转换模式

| `ocrMode` | 行为 |
|-----------|------|
| `auto`（默认） | 优先 DOM 提取；正文太短时自动 OCR 兜底 |
| `force` | 不管 DOM 质量，直接分屏截图 OCR（推荐用于微信/小红书/公众号文章） |
| `never` | 只走 DOM 提取，适合新闻站点等结构清晰页面 |

---

## 🚢 部署说明

### 生产部署（单机）

```bash
npm run build          # 构建前端产物 → packages/web/dist/
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
  node packages/server/dist/index.js
```

后端同时托管前端静态资源，访问 `http://<host>:8787` 即可。

### 反向代理（Nginx 示例）

```nginx
server {
  listen 80;
  server_name md.yourdomain.com;

  client_max_body_size 20m;
  proxy_read_timeout 600s;   # OCR 任务可能耗时较长

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Server-Token $http_x_server_token;  # 前端代理鉴权用
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

### Docker 部署（示例）

```dockerfile
FROM node:22-slim
WORKDIR /app

# Playwright + Chromium 依赖（Debian 系）
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \
    libasound2 libxshmfence1 fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN npx playwright install chromium && npm run build

EXPOSE 8787
CMD ["node", "packages/server/dist/index.js"]
```

运行：

```bash
docker run -d -p 8787:8787 \
  -v $(pwd)/data:/app/data \
  -e PADDLE_TOKEN=YOUR_TOKEN \
  --name web2md \
  berserker/web2md
```

### PM2 / 守护进程

```bash
npm install -g pm2
pm2 start packages/server/dist/index.js --name web2md
pm2 save && pm2 startup
```

### 注意事项

- **公网部署必须加鉴权**：后端默认无认证，直接暴露到公网任何人都能触发 OCR 消耗额度。建议：
  - Nginx 层加 `auth_basic` 或 IP 白名单；或
  - 前端代理鉴权 Token（后端从 `X-Server-Token` / 环境变量读取并校验）
- **磁盘空间**：`data/artifacts/` 存放每次转换的 ZIP 和 Markdown，默认自动保留最近 50 条，定期清理
- **Playwright 浏览器**：容器内首次运行需安装 Debian 依赖 + Chromium（约 150MB）
- **长任务**：单页 PaddleOCR-VL 云端推理约 1–2 分钟，9 屏长文章可能跑满 10+ 分钟；nginx `proxy_read_timeout` 和进程 `MAX_WAIT_MS=300s` 都要匹配

---

## 📁 目录结构

```
all-web-to-md/
├── packages/
│   ├── server/                 # Fastify 后端
│   │   ├── src/
│   │   │   ├── config.ts       # 端口 / 默认模型 / 生产目录
│   │   │   ├── index.ts        # Fastify 启动
│   │   │   ├── types.ts        # 全局类型
│   │   │   ├── store.ts        # jobs 历史 + SSE
│   │   │   ├── routes/         # convert / jobs / settings
│   │   │   ├── services/
│   │   │   │   ├── pipeline.ts # 九阶段流水线
│   │   │   │   ├── browser.ts  # Playwright 渲染 + 重叠分屏
│   │   │   │   ├── ocr.ts      # PaddleOCR-VL 异步 Jobs API
│   │   │   │   ├── extractor.ts# Readability + 启发式兜底
│   │   │   │   ├── markdown.ts # Turndown 自定义规则
│   │   │   │   ├── images.ts   # 图片本地化
│   │   │   │   ├── llm.ts      # OpenAI 兼容代理
│   │   │   │   └── archive.ts  # adm-zip 打包
│   │   │   └── utils/text.ts  # 接缝去重 LCS + 归一化
│   │   └── package.json
│   └── web/                    # React 前端
│       ├── src/
│       │   ├── App.tsx         # 主界面
│       │   ├── api.ts          # fetch 封装
│       │   ├── components/
│       │   │   ├── UrlForm.tsx
│       │   │   ├── ProgressPanel.tsx
│       │   │   ├── ResultCard.tsx
│       │   │   ├── HistoryList.tsx
│       │   │   ├── SettingsModal.tsx
│       │   │   └── stages.ts   # 阶段名 → 中文映射
│       │   └── main.tsx
│       └── package.json
├── data/                       # 运行时数据（已 .gitignore）
│   ├── settings.json           # 用户配置（含 Token）
│   ├── jobs.json               # 任务历史
│   └── artifacts/{jobId}/      # ZIP + Markdown + images
├── .gitignore
└── package.json
```

---

## ⚠️ 已知限制

1. **AIStudio 队列（code 10010）**：高峰期提交会持续返回"任务提交队列已满"，客户端已自动退避 5 次 × 10s；建议避开工作日 10–12 / 14–18 点高峰
2. **云端单页推理耗时**：实测 PaddleOCR-VL 单页推理约 **108 秒**，叠加 pending 排队，单屏总耗时可能 2–3 分钟；本地已放宽 `MAX_WAIT_MS=300s`
3. **MAX_TILES=20**：单页超过 20 屏（约 18000px）时只截前 20 屏，文末内容不参与 OCR；`shot.truncated=true` 会在面板和日志中告警
4. **图片为整屏截图**：PaddleOCR-VL 会把识别为文本的区域直接转成 Markdown，保留为图片的通常是图表 / 装饰性底图；若文章正文本身就是一整张图，OCR 文本质量会非常好
5. **UTF-8 优先**：GBK 编码页面已通过 jschardet + iconv-lite 自动识别；其他冷门编码可能需要手动补充映射

---

## 📜 License

MIT
