import type { OcrSettings } from '../types';
import { ZHIPU_OCR_BASE_URL, ZHIPU_OCR_MODEL } from '../config';
import { mapLimit, stitchOcrParts } from '../utils/text';

/**
 * 调用智谱 GLM-OCR（走 chat/completions 多模态接口，base64 PNG 直接传入）。
 * 同步秒级响应，无需排队/轮询。
 */
async function recognizeZhipu(
  image: Buffer,
  settings: OcrSettings,
  onProgress?: (phase: string) => void,
): Promise<string> {
  if (!settings.token) throw new Error('未配置智谱 API Key');
  onProgress?.('识别中');

  const model = settings.model || ZHIPU_OCR_MODEL;
  const baseUrl = (settings.endpoint || ZHIPU_OCR_BASE_URL).replace(/\/+$/, '');
  const dataUri = `data:image/png;base64,${image.toString('base64')}`;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.token}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content:
            '你是专业的 OCR 文档解析引擎。请严格识别图片中的所有文字内容，按原始版面结构输出 Markdown。不要添加任何解释性文字，只输出识别结果。',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: '请识别这张网页截图中的所有文字，按版面输出 Markdown：' },
            { type: 'image_url', image_url: { url: dataUri } },
          ],
        },
      ],
      temperature: 0.1,
      stream: false,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`智谱 GLM-OCR 返回 HTTP ${res.status}：${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error(`智谱 GLM-OCR 返回异常：${data.error?.message ?? '内容为空'}`);
  }
  return stripCodeFence(content).trim();
}

/**
 * 自建 OCR HTTP 服务适配。
 * 约定：POST {endpoint}，body 为图片二进制，返回 JSON { text: string } 或 { results: [{text}] }
 */
async function recognizeCustom(image: Buffer, settings: OcrSettings): Promise<string> {
  if (!settings.endpoint) throw new Error('未配置自建 OCR 服务地址');
  const res = await fetch(settings.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: new Uint8Array(image),
  });
  if (!res.ok) throw new Error(`自建 OCR 服务返回 HTTP ${res.status}`);
  const data = (await res.json()) as {
    text?: string;
    results?: Array<{ text?: string }>;
  };
  if (typeof data.text === 'string') return data.text;
  if (Array.isArray(data.results)) {
    return data.results.map((r) => r.text ?? '').filter(Boolean).join('\n');
  }
  throw new Error('自建 OCR 服务返回格式无法识别（期望 text 或 results 字段）');
}

function stripCodeFence(text: string): string {
  const m = /^```(?:markdown)?\s*\n([\s\S]*?)\n```\s*$/.exec(text.trim());
  return m ? m[1] : text.trim();
}

export async function recognize(image: Buffer, settings: OcrSettings): Promise<string> {
  return settings.provider === 'zhipu'
    ? recognizeZhipu(image, settings)
    : recognizeCustom(image, settings);
}

/** 批量识别分屏截图，按原始顺序拼接；单屏失败不中断整体 */
export async function recognizeTiles(
  tiles: Array<{ index: number; buffer: Buffer }>,
  settings: OcrSettings,
  onProgress?: (done: number, total: number) => void,
  onPhase?: (tileIndex: number, phase: string) => void,
): Promise<{ text: string; failedTiles: number; firstError?: string }> {
  let failed = 0;
  let done = 0;
  let firstError = '';
  const lastPhase = new Map<number, string>();

  // 智谱 OCR 是同步秒级接口，可安全并发；自建服务保守串行
  const concurrency = settings.provider === 'zhipu' ? 3 : 1;

  const parts = await mapLimit(tiles, concurrency, async (tile) => {
    try {
      const text = await (settings.provider === 'zhipu'
        ? recognizeZhipu(tile.buffer, settings, (phase) => {
            if (lastPhase.get(tile.index) !== phase) {
              lastPhase.set(tile.index, phase);
              onPhase?.(tile.index, phase);
            }
          })
        : recognizeCustom(tile.buffer, settings));
      return { index: tile.index, text, ok: true };
    } catch (err) {
      failed += 1;
      if (!firstError) firstError = (err as Error).message;
      return {
        index: tile.index,
        text: `> OCR 第 ${tile.index + 1} 屏识别失败：${(err as Error).message}`,
        ok: false,
      };
    } finally {
      done += 1;
      onProgress?.(done, tiles.length);
    }
  });
  parts.sort((a, b) => a.index - b.index);
  return {
    // 相邻分屏有重叠截图，拼接时做接缝去重，消除重复行 / 断句
    text: stitchOcrParts(parts.map((p) => p.text)),
    failedTiles: failed,
    firstError,
  };
}

/**
 * 智谱 GLM-OCR 连通性校验：发送一次极简对话。
 */
export async function validateZhipuKey(settings: OcrSettings): Promise<void> {
  if (!settings.token) throw new Error('请填写智谱 API Key');
  const baseUrl = (settings.endpoint || ZHIPU_OCR_BASE_URL).replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.token}`,
    },
    body: JSON.stringify({
      model: settings.model || ZHIPU_OCR_MODEL,
      messages: [{ role: 'user', content: '请只回复"ok"两个字' }],
      temperature: 0,
      stream: false,
    }),
    signal: AbortSignal.timeout(20_000),
  }).catch((err: Error) => {
    throw new Error(`无法访问智谱 AI 服务：${err.message}`);
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('API Key 无效或已过期（服务返回 401/403）');
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`智谱服务返回 HTTP ${res.status}：${detail.slice(0, 300)}`);
  }
}
