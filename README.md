# all-web-to-md

把任意网页一键转成干净的 Markdown（含原文标题、图片本地化、可选 OCR 识别、可选大模型精炼），最终打包成 ZIP 下载。

[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![monorepo](https://img.shields.io/badge/npm-workspaces-ff69b4)](https://docs.npmjs.com/cli/v10/using-npm/workspaces)
[![ocr](https://img.shields.io/badge/ocr-GLM--OCR-3cf)](https://bigmodel.cn/)

## ✨ 核心特性

- **双通路提取**：DOM 解析（Readability + cheerio）→ 失败时 Playwright 动态渲染 + 分屏截图 OCR，两路可自动降级或强制 OCR
- **长图友好**：相邻分屏 180px 重叠 + LCS 接缝去重，避免跨屏断句丢字
- **智谱 GLM-OCR 秒级识别**：OpenAI 兼容 chat/completions 多模态接口，同步返回 Markdown，无队列、无轮询
- **可选大模型精炼**：OpenAI 兼容接口，内置智谱 GLM / DeepSeek 预设
- **图片本地化**：正文图片自动下载到 `images/`，ZIP 一并打包
- **实时进度**：SSE 推送，浏览器端 9 阶段可视化

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
         ├─ 智谱 GLM-OCR (chat/completions 多模态，同步秒级)
         ├─ Playwright Chromium (分屏截图)
         └─ Readability + Turndown (HTML→Markdown)
```

### 技术栈

| 层 | 技术 |
|----|----|
| 后端框架 | Fastify 5 + TypeScript 5 |
| DOM 提取 | Readability (Mozilla) + cheerio + jsdom + jschardet + iconv-lite（支持 GBK 页面） |
| 截图 OCR | Playwright 1.49 + 智谱 GLM-OCR（chat/completions 多模态接口） |
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

### OCR API 协议（智谱 GLM-OCR）

智谱 GLM-OCR 走 OpenAI 兼容的 `chat/completions` 多模态接口，同步秒级响应：

```
POST https://open.bigmodel.cn/api/paas/v4/chat/completions
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

```json
{
  "model": "glm-ocr",
  "messages": [
    {
      "role": "system",
      "content": "你是专业的 OCR 文档解析引擎。请严格识别图片中的所有文字内容，按原始版面结构输出 Markdown。"
    },
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "请识别这张网页截图中的所有文字，按版面输出 Markdown：" },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,<截图 base64>" } }
      ]
    }
  ],
  "temperature": 0.1,
  "stream": false
}
```

返回 `choices[0].message.content` 即识别结果 Markdown，支持直接返回排版后的表格、代码块等结构。

### 流水线降级策略

| 条件 | 动作 |
|------|------|
| Readability 提取 < 300 字 | 自动 Playwright 渲染重试 |
| `ocrMode=force` 或低质量 + OCR 启用 | 强制分屏截图 OCR（智谱 OCR 接口并发 3 路） |
| OCR 全部分屏失败 | 回退 DOM 结果，错误原因写入事件流 |

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

### 智谱 GLM-OCR（推荐，秒级同步响应）

1. 访问 [智谱开放平台](https://bigmodel.cn/) 注册 / 登录
2. 在 [API Keys 管理页](https://bigmodel.cn/usercenter/proj-mgmt/apikeys) 创建 API Key（形如 `sk-...`）
3. 在项目里配置：

#### 方式 A：前端设置弹窗（最简单）

打开应用 → 右上角 **设置** → **OCR 设置** → 选择 `智谱 GLM-OCR（秒级同步响应，推荐）` → 填入 API Key → 点击 **测试连接** → **保存**

其他字段保持默认即可：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| API Key | （必填） | 智谱开放平台 API Key |
| Base URL | `https://open.bigmodel.cn/api/paas/v4` | 一般不需要改 |
| 模型名称 | `glm-ocr` | 智谱专用 OCR 模型 |

#### 方式 B：直接调 REST API

```bash
curl -X PUT http://127.0.0.1:8787/api/settings \
  -H "Content-Type: application/json" \
  -d '{
    "ocr": {
      "enabled": true,
      "provider": "zhipu",
      "token": "YOUR_API_KEY",
      "model": "glm-ocr",
      "endpoint": "https://open.bigmodel.cn/api/paas/v4"
    },
    "llm": { "enabled": false, "provider": "zhipu" }
  }'
```

### 大模型精炼（可选）

当前端勾选"启用大模型精炼"时才需要配置。内置智谱、DeepSeek 预设，自定义任何 OpenAI 兼容端点均可：

| 提供商 | baseUrl | 获取 Key |
|--------|---------|---------|
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | https://bigmodel.cn/usercenter/proj-mgmt/apikeys |
| DeepSeek | `https://api.deepseek.com` | https://platform.deepseek.com/api_keys |
| 自定义 | （任意 OpenAI 兼容端点） | — |

### Token 安全

- 所有敏感配置明文保存在 `data/settings.json`（项目运行时自动创建，已在 `.gitignore` 中排除）
- 后端进程内不打印 Token、不写入日志
- 配置接口仅监听 `127.0.0.1`（生产部署到公网时务必加反向代理鉴权）

### 自建 OCR 服务（可选）

若自建服务，选择 `自建 OCR HTTP 服务`，约定：`POST {endpoint}` body 为图片二进制 → 返回 `{ text }` 或 `{ results: [{ text }] }`

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
  proxy_read_timeout 120s;   # 智谱 GLM-OCR 秒级响应，120s 足够

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
  -e ZHIPU_API_KEY=YOUR_KEY \
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
- **磁盘空间**：`data/artifacts/` 存放每次转换的 ZIP 和 Markdown，默认自动保留最近 100 条，定期清理
- **Playwright 浏览器**：容器内首次运行需安装 Debian 依赖 + Chromium（约 150MB）
- **长任务**：智谱 GLM-OCR 秒级响应，单页通常 <5s；长文章（9 屏）也能在 30s 内完成，nginx `proxy_read_timeout` 建议 ≥ 120s

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
│   │   │   │   ├── ocr.ts      # 智谱 GLM-OCR chat/completions 多模态
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

1. **MAX_TILES=20**：单页超过 20 屏（约 18000px）时只截前 20 屏，文末内容不参与 OCR；`shot.truncated=true` 会在面板和日志中告警
2. **图片为整屏截图**：GLM-OCR 会把识别为文本的区域直接转成 Markdown，保留为图片的通常是图表 / 装饰性底图；若文章正文本身就是一整张图，OCR 文本质量会非常好
3. **UTF-8 优先**：GBK 编码页面已通过 jschardet + iconv-lite 自动识别；其他冷门编码可能需要手动补充映射

---

## 📜 License

MIT
