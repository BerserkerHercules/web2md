/** 全局共享类型定义 */

export type OcrProvider = 'aistudio' | 'custom';

export interface OcrSettings {
  enabled: boolean;
  provider: OcrProvider;
  /** AIStudio PaddleOCR-VL：bearer token */
  token: string;
  /** 模型名，如 PaddleOCR-VL-1.6 */
  model: string;
  /** aistudio 模式：异步 jobs 地址；custom 模式：自建 OCR HTTP 服务地址 */
  endpoint: string;
  /** optionalPayload 识别选项 */
  useDocOrientationClassify: boolean;
  useDocUnwarping: boolean;
  useChartRecognition: boolean;
}

export type LlmProvider = 'zhipu' | 'deepseek' | 'custom';

export interface LlmSettings {
  enabled: boolean;
  provider: LlmProvider;
  apiKey: string;
  /** OpenAI 兼容的 base url，如 https://open.bigmodel.cn/api/paas/v4 */
  baseUrl: string;
  /** 模型名，如 glm-5.3 / deepseek-v4-pro */
  model: string;
}

export interface AppSettings {
  ocr: OcrSettings;
  llm: LlmSettings;
}

export interface ConvertOptions {
  /** 启用大模型排版精炼 */
  useLlm: boolean;
  /**
   * OCR 模式：
   * - auto（默认）：仅当 DOM 提取质量差、需要截图时使用
   * - force：强制对整页截图 OCR
   * - off：禁用 OCR
   */
  ocrMode: 'auto' | 'force' | 'off';
  /** 在文首附加来源链接 */
  includeSource: boolean;
}

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

export type StageName =
  | 'fetch'
  | 'extract'
  | 'render'
  | 'screenshot'
  | 'ocr'
  | 'convert'
  | 'llm'
  | 'images'
  | 'package';

export type StageStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface JobEvent {
  t: number;
  type: 'stage' | 'log' | 'done' | 'error';
  stage?: StageName;
  status?: StageStatus;
  message?: string;
}

export interface JobStats {
  mode: 'dom' | 'ocr';
  words: number;
  images: number;
  imagesFailed: number;
  ocrTiles: number;
  llmUsed: boolean;
  zipSize: number;
}

export interface Job {
  id: string;
  url: string;
  finalUrl?: string;
  title: string;
  options: ConvertOptions;
  status: JobStatus;
  events: JobEvent[];
  stages: Partial<Record<StageName, StageStatus>>;
  stats?: JobStats;
  markdown?: string;
  markdownName?: string;
  zipName?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}
