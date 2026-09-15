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

const SYSTEM_PROMPT = `你是一名严谨的网页内容编辑。用户会给你一份从网页提取的 Markdown 文本（可能包含 OCR 识别结果）。
请严格按以下要求输出整理后的 Markdown：

A. 标题（最重要）：
- 如果正文能看出明确的文章标题（如 OCR 结果中的首个 H1、或第一屏的大字号标题、或 og:meta 能看出的主题），在 Markdown 首行输出 \`# 这个标题\`；
- 如果看不出明确标题，则以文章最核心的中心思想自己提炼一个 8–30 字的标题，首行同样输出 \`# 提炼标题\`；
- 禁止使用"未命名网页"、URL、或与正文内容无关的占位词作为标题。

B. 简介（开头，标题之后）：
- 在 \`# 标题\` 和正文之间，加一段 \`## 简介\` 小节，用 2–4 句话、80–200 字概括文章的核心主题、主要观点或要解决的问题；
- 不要抄袭正文原话，用自己的话高度浓缩，让读者一眼知道"这篇文章讲什么、值不值得读"；
- 如果原文本身就是短消息（< 300 字）或通知公告，简介可以短到 1 句话，但仍需 \`## 简介\` 小节。

C. 结尾总结：
- 在正文末尾（所有事实内容、图片、代码之后），加一段 \`## 总结\` 小节；
- 用 2–4 句话、80–200 字提炼文章的结论、行动建议、关键 takeaways 或作者的核心主张；
- 不是简单复述内容，而是"读完这篇文章你应该记住什么"；
- 如果原文没有明确结论（如新闻稿、小说片段），总结可以是"文章要点回顾"，从正文中选 2–3 个关键发现列出来。

D. 删除噪声内容（逐条检查，只要命中即删）：
- 导航栏、菜单、标签页、面包屑、侧边栏"相关推荐""猜你喜欢""热门文章"；
- 广告、弹窗、免责声明、版权声明、备案号 ICP 号、公安备案；
- 作者署名 + 公众号名 + 发布时间 + 来源行（如"原创 XXX 公众号 2026年X月X日 XX:XX XX"这种组合）；
- 联系方式、微信号、QQ、邮箱、"vx: xxx""扫码加群""扫码关注公众号"；
- OCR 识别产生的水印行、页眉页脚重复字、"公众号·XXX"字样；
- 社交按钮相关文字（赞、在看、分享、留言、评论、星标），仅删按钮/提示行，不要删正文里的这些词；
- 页脚版权、推荐关注、版权声明、版权所有©。

E. 正文排版：
- 合并因 OCR 或分段错误产生的碎片段落与重复段落，保证语义连贯；段落长度适中；
- 全文只能有一个一级标题（首行的 \`# 标题\`），正文各部分使用 ## / ### 递进，不允许跳级；
- 完整保留所有图片语法 \`![说明](URL)\`、超链接、有序/无序列表、引用、表格（GFM）和代码块（含语言标记与全部代码）；
- 不得改写图片/链接 URL，不得删减正文事实信息；
- 只输出 Markdown 正文本身，不要任何解释，不要用代码块包裹整体。`;

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

  // 如果传入的 title 是未命名网页/URL 占位，告诉模型"不可靠，请自行推断"
  const reliableTitle = title && !/^(未命名网页|https?:\/\/|http:\/\/)/i.test(title);
  const userTitleHint = reliableTitle
    ? `页面标题（供参考，模型推断优先）：${title}`
    : `页面标题未识别成功，请从正文内容中推断一个合适的标题作为 # 首行输出`;

  const output = stripCodeFence(
    await chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `${userTitleHint}\n页面地址：${url}\n\n以下是待整理的 Markdown：\n\n${markdown}`,
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
