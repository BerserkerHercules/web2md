import type { LlmSettings } from '../types';

const MAX_INPUT_CHARS = 60_000;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 调用 OpenAI 兼容的 chat completions 接口（GLM / DeepSeek 等） */
export async function chat(
  messages: ChatMessage[],
  settings: LlmSettings,
  opts: { timeoutMs?: number; json?: boolean; temperature?: number } = {},
): Promise<string> {
  if (!settings.apiKey) throw new Error('未配置大模型 API Key');
  if (!settings.baseUrl) throw new Error('未配置大模型接口地址（Base URL）');
  if (!settings.model) throw new Error('未配置模型名称');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 90_000);
  try {
    const res = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        messages,
        temperature: opts.temperature ?? 0.2,
        stream: false,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`大模型接口返回 HTTP ${res.status}：${detail.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error(`大模型返回内容异常：${data.error?.message ?? '未知错误'}`);
    }
    return content;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error('大模型处理超时（90 秒），已回退到规则化排版结果');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const SYSTEM_PROMPT = `你是一名严谨的网页内容排版编辑。用户会给你一份从网页提取的 Markdown 文本（可能包含 OCR 识别结果）。
请严格按以下要求输出整理后的 Markdown：

1. 删除导航栏、菜单、广告、弹窗、相关推荐、版权声明、备案号、登录注册按钮等与正文无关的内容；
2. 合并因 OCR 或分段错误产生的碎片段落与重复段落，保证语义连贯；段落长度适中，不要出现超长或只有一两个字的段落；
3. 修正标题层级：全文只能有一个一级标题（#）；正文各部分使用 ## / ### 递进，不允许跳级；
4. 完整保留所有图片语法（形如 ![图片说明](图片地址)）、超链接、有序/无序列表、引用、表格（GFM 语法）和代码块（含语言标记与其中全部代码），不得改写 URL、不得删减正文事实信息；
5. OCR 文本中的页眉页脚、重复水印、二维码提示文字应删除；
6. 只输出 Markdown 正文本身，不要输出任何解释说明，不要用代码块包裹整体输出。`;

function stripCodeFence(text: string): string {
  const m = /^```(?:markdown)?\s*\n([\s\S]*?)\n```\s*$/.exec(text.trim());
  return m ? m[1] : text.trim();
}

function countImages(md: string): number {
  return (md.match(/!\[[^\]]*\]\(/g) ?? []).length;
}
function countCodeFences(md: string): number {
  return (md.match(/```/g) ?? []).length;
}
function countTables(md: string): number {
  return (md.match(/^\|.+\|\s*$/gm) ?? []).length;
}

/**
 * 使用大模型精炼 Markdown。
 * 任何失败都向上抛出，由调用方回退到规则化结果（不让 AI 故障阻断转换）。
 */
export async function refineMarkdown(
  markdown: string,
  title: string,
  url: string,
  settings: LlmSettings,
): Promise<string> {
  if (markdown.length > MAX_INPUT_CHARS) {
    throw new Error(
      `正文过长（${markdown.length} 字符，超过 ${MAX_INPUT_CHARS} 上限），已跳过 AI 精炼`,
    );
  }

  const beforeImages = countImages(markdown);
  const beforeFences = countCodeFences(markdown);
  const beforeTables = countTables(markdown);

  const output = stripCodeFence(
    await chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `页面标题：${title}\n页面地址：${url}\n\n以下是待整理的 Markdown：\n\n${markdown}`,
        },
      ],
      settings,
      { timeoutMs: 90_000, temperature: 0.15 },
    ),
  );

  if (output.length < Math.min(200, markdown.length * 0.3)) {
    throw new Error('AI 返回内容过短，疑似异常，已回退原结果');
  }
  // 安全护栏：图片大量丢失、代码围栏不配对或表格被破坏时拒绝采用
  if (beforeImages > 0 && countImages(output) < beforeImages * 0.7) {
    throw new Error('AI 结果丢失了过多图片引用，已回退原结果');
  }
  if (Math.abs(countCodeFences(output) - beforeFences) % 2 !== 0) {
    throw new Error('AI 结果中代码块围栏不配对，已回退原结果');
  }
  if (beforeTables >= 2 && countTables(output) < beforeTables * 0.5) {
    throw new Error('AI 结果丢失了表格内容，已回退原结果');
  }
  return output.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** 连通性测试：发送一次极简对话 */
export async function testConnection(settings: LlmSettings): Promise<void> {
  await chat(
    [
      { role: 'system', content: '请只回复两个字：正常' },
      { role: 'user', content: '连接测试' },
    ],
    settings,
    { timeoutMs: 20_000, temperature: 0 },
  );
}
