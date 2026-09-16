import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppSettings, LlmProvider } from './types';

/** 运行时数据目录（历史记录、产物、配置），位于仓库根目录 data/ 下 */
export const DATA_DIR = join(__dirname, '..', '..', '..', 'data');
export const SETTINGS_PATH = join(DATA_DIR, 'settings.json');
export const JOBS_PATH = join(DATA_DIR, 'jobs.json');
export const ARTIFACTS_DIR = join(DATA_DIR, 'artifacts');

export const PORT = Number(process.env.PORT ?? 8787);
export const HOST = process.env.HOST ?? '127.0.0.1';

/** 前端构建产物目录（生产模式下由后端直接托管） */
export const WEB_DIST = join(__dirname, '..', '..', 'web', 'dist');

export const LLM_PRESETS: Record<
  LlmProvider,
  { label: string; baseUrl: string; model: string }
> = {
  zhipu: {
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.3',
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
  },
  custom: { label: '自定义（OpenAI 兼容）', baseUrl: '', model: '' },
};

export const ZHIPU_OCR_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
export const ZHIPU_OCR_MODEL = 'glm-ocr';

export const DEFAULT_SETTINGS: AppSettings = {
  ocr: {
    enabled: false,
    provider: 'zhipu',
    token: '',
    model: ZHIPU_OCR_MODEL,
    endpoint: ZHIPU_OCR_BASE_URL,
  },
  llm: {
    enabled: false,
    provider: 'zhipu',
    apiKey: '',
    baseUrl: LLM_PRESETS.zhipu.baseUrl,
    model: LLM_PRESETS.zhipu.model,
  },
};

function cloneDefaults(): AppSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as AppSettings;
}

/** 合并旧配置，保证新增字段有默认值 */
function mergeSettings(raw: unknown): AppSettings {
  const base = cloneDefaults();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  const ocr = (r.ocr ?? {}) as Partial<AppSettings['ocr']>;
  const llm = (r.llm ?? {}) as Partial<AppSettings['llm']>;
  return {
    ocr: { ...base.ocr, ...ocr },
    llm: { ...base.llm, ...llm },
  };
}

export function ensureDirs(): void {
  for (const dir of [DATA_DIR, ARTIFACTS_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

export function loadSettings(): AppSettings {
  try {
    if (!existsSync(SETTINGS_PATH)) return cloneDefaults();
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    return mergeSettings(raw);
  } catch {
    return cloneDefaults();
  }
}

export function saveSettings(settings: AppSettings): void {
  ensureDirs();
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
}

/** 历史记录最多保留条数 */
export const MAX_JOBS = 100;
