import type { OcrSettings } from '../types';
import { PADDLE_DEFAULT_MODEL, PADDLE_JOBS_URL } from '../config';
import { mapLimit, stitchOcrParts } from '../utils/text';

const SUBMIT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 4_000;
/**
 * 单个分屏的最长等待。实测 PaddleOCR-VL 云端单页推理本身就要 ~110s，
 * 叠加任务排队（pending）时间，180s 会在服务端仍正常执行时误判超时，
 * 因此放宽到 300s。
 */
const MAX_WAIT_MS = 300_000;
/** 轮询期间单次 GET 失败（网络抖动）容忍次数，避免一次抖动丢掉整个任务 */
const MAX_POLL_ERRORS = 5;
/** 队列已满时的提交重试（10010 为 AIStudio 的“任务提交队列已满”） */
const SUBMIT_MAX_ATTEMPTS = 5;
const SUBMIT_RETRY_MS = 10_000;

function jobsEndpoint(settings: OcrSettings): string {
  return (settings.endpoint || PADDLE_JOBS_URL).replace(/\/+$/, '');
}

function optionalPayload(settings: OcrSettings) {
  return {
    useDocOrientationClassify: settings.useDocOrientationClassify,
    useDocUnwarping: settings.useDocUnwarping,
    useChartRecognition: settings.useChartRecognition,
  };
}

function authHeaders(settings: OcrSettings, json = false): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `bearer ${settings.token}`,
  };
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

interface JobData {
  jobId?: string;
  state?: 'pending' | 'running' | 'done' | 'failed';
  errorMsg?: string;
  resultUrl?: { jsonUrl?: string };
  extractProgress?: { totalPages?: number; extractedPages?: number };
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const json = JSON.parse(text) as { errorMsg?: string; message?: string };
    return json.errorMsg || json.message || text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

/**
 * 调用 AIStudio PaddleOCR-VL 异步 API：
 * 1. multipart/form-data 提交截图（字段名必须是 file，不能用 base64）；
 * 2. 轮询 GET {jobs}/{jobId} 等待 state=done；
 * 3. 下载 resultUrl.jsonUrl（JSONL），取 layoutParsingResults[*].markdown。
 */
async function recognizePaddle(
  image: Buffer,
  settings: OcrSettings,
  onProgress?: (phase: string) => void,
): Promise<string> {
  const endpoint = jobsEndpoint(settings);
  const model = settings.model || PADDLE_DEFAULT_MODEL;

  // 1. 提交任务（队列已满时退避重试） --------------------------------------
  onProgress?.('提交中');
  let jobId = '';
  let lastSubmitError = '';
  for (let attempt = 1; attempt <= SUBMIT_MAX_ATTEMPTS; attempt++) {
    const form = new FormData();
    form.set(
      'file',
      new Blob([new Uint8Array(image)], { type: 'image/png' }),
      'screenshot.png',
    );
    form.set('model', model);
    form.set('optionalPayload', JSON.stringify(optionalPayload(settings)));

    const submitRes = await fetch(endpoint, {
      method: 'POST',
      headers: authHeaders(settings),
      body: form,
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
    const submitBody = (await submitRes
      .json()
      .catch(() => null)) as { data?: JobData; code?: number; msg?: string } | null;

    if (submitRes.ok && submitBody?.data?.jobId) {
      jobId = submitBody.data.jobId;
      break;
    }

    lastSubmitError =
      submitBody?.msg ||
      (submitRes.ok ? '响应中缺少 jobId' : await readError(submitRes));
    const queueFull =
      submitBody?.code === 10010 ||
      submitRes.status === 429 ||
      lastSubmitError.includes('队列已满');
    if (queueFull && attempt < SUBMIT_MAX_ATTEMPTS) {
      onProgress?.(`queue-wait-${attempt}`);
      await sleep(SUBMIT_RETRY_MS);
      continue;
    }
    throw new Error(
      `PaddleOCR-VL 任务提交失败（HTTP ${submitRes.status}）：${lastSubmitError}`,
    );
  }
  if (!jobId) throw new Error(`PaddleOCR-VL 任务提交失败：${lastSubmitError}`);

  // 2. 轮询状态 -----------------------------------------------------------
  onProgress?.('pending');
  const startedAt = Date.now();
  let jsonUrl = '';
  let lastState = 'pending';
  let pollErrors = 0;
  for (;;) {
    if (Date.now() - startedAt > MAX_WAIT_MS) {
      throw new Error(
        `PaddleOCR-VL 任务 ${jobId} 等待超过 ${MAX_WAIT_MS / 1000}s（最后状态：${lastState}）。` +
          '云端任务可能仍在执行，可稍后重试；长图/多屏页面建议避开高峰时段',
      );
    }
    await sleep(POLL_INTERVAL_MS);
    const jobRes = await fetch(`${endpoint}/${jobId}`, {
      headers: authHeaders(settings),
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    }).catch(() => null);
    if (!jobRes || !jobRes.ok) {
      // 网络抖动或偶发 5xx：容忍若干次，下个轮询周期继续
      pollErrors += 1;
      if (pollErrors > MAX_POLL_ERRORS) {
        throw new Error(
          `PaddleOCR-VL 状态查询连续失败（HTTP ${jobRes?.status ?? '网络错误'}）：${
            jobRes ? await readError(jobRes) : '无法连接'
          }`,
        );
      }
      continue;
    }
    pollErrors = 0;
    const jobBody = (await jobRes.json().catch(() => null)) as {
      data?: JobData;
    } | null;
    const data = jobBody?.data;
    if (data?.state === 'done') {
      jsonUrl = data.resultUrl?.jsonUrl ?? '';
      if (!jsonUrl) throw new Error('PaddleOCR-VL 任务完成但未返回 jsonUrl');
      break;
    }
    if (data?.state === 'failed') {
      throw new Error(`PaddleOCR-VL 任务失败：${data.errorMsg || '未知原因'}`);
    }
    if (data?.state) {
      lastState = data.state;
      const p = data.extractProgress;
      onProgress?.(
        p?.totalPages
          ? `${data.state}:${p.extractedPages ?? 0}/${p.totalPages}`
          : data.state,
      );
    }
  }

  // 3. 下载并解析 JSONL ----------------------------------------------------
  onProgress?.('result');
  const jsonlRes = await fetch(jsonUrl);
  if (!jsonlRes.ok) {
    throw new Error(`OCR 结果下载失败（HTTP ${jsonlRes.status}）`);
  }
  const jsonl = await jsonlRes.text();
  return parsePaddleJsonl(jsonl);
}

/**
 * 解析 PaddleOCR-VL 结果 JSONL：
 * 每行结构 { result: { layoutParsingResults: [{ markdown: { text, images } }] } }，
 * 其中 markdown.text 的图片占位是 images 字典的 key，回填为远程 URL，
 * 便于后续图片本地化阶段统一下载到 images/ 目录。
 */
export function parsePaddleJsonl(jsonl: string): string {
  const parts: string[] = [];
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const pages =
      (parsed as { result?: { layoutParsingResults?: unknown[] } })?.result
        ?.layoutParsingResults ?? [];
    for (const page of pages) {
      const md = (
        page as {
          markdown?: { text?: string; images?: Record<string, string> };
        }
      ).markdown;
      if (!md?.text) continue;
      let text = md.text;
      for (const [imgPath, imgUrl] of Object.entries(md.images ?? {})) {
        if (imgUrl) text = text.split(imgPath).join(imgUrl);
      }
      parts.push(text);
    }
  }
  const result = parts.join('\n\n').trim();
  if (!result) throw new Error('PaddleOCR-VL 返回内容为空');
  return result;
}

/**
 * 自建 PaddleOCR HTTP 服务适配。
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

export async function recognize(image: Buffer, settings: OcrSettings): Promise<string> {
  return settings.provider === 'custom'
    ? recognizeCustom(image, settings)
    : recognizePaddle(image, settings);
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
  // 异步任务适度并发（过高并发容易触发服务端队列限制）
  const parts = await mapLimit(tiles, 2, async (tile) => {
    try {
      const text =
        settings.provider === 'custom'
          ? await recognizeCustom(tile.buffer, settings)
          : await recognizePaddle(tile.buffer, settings, (phase) => {
              // 同一分屏只在状态/页数变化时上报，避免轮询刷屏
              if (lastPhase.get(tile.index) !== phase) {
                lastPhase.set(tile.index, phase);
                onPhase?.(tile.index, phase);
              }
            });
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
 * 连通性校验：携带 token 请求 jobs 集合地址。
 * 401/403 视为 token 无效；网络错误向上抛出；其余状态码说明地址可达、鉴权通过。
 */
export async function validatePaddleToken(settings: OcrSettings): Promise<void> {
  if (!settings.token) throw new Error('请填写 PaddleOCR-VL Token');
  const res = await fetch(jobsEndpoint(settings), {
    headers: authHeaders(settings),
    signal: AbortSignal.timeout(15_000),
  }).catch((err: Error) => {
    throw new Error(`无法访问 PaddleOCR-VL 服务：${err.message}`);
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('Token 无效或已过期（服务返回 401/403）');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
