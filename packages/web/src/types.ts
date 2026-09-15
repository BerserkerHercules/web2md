export type OcrProvider = 'aistudio' | 'custom';

export interface OcrSettings {
  enabled: boolean;
  provider: OcrProvider;
  token: string;
  model: string;
  endpoint: string;
  useDocOrientationClassify: boolean;
  useDocUnwarping: boolean;
  useChartRecognition: boolean;
}

export type LlmProvider = 'zhipu' | 'deepseek' | 'custom';

export interface LlmSettings {
  enabled: boolean;
  provider: LlmProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface AppSettings {
  ocr: OcrSettings;
  llm: LlmSettings;
}

export interface LlmPreset {
  label: string;
  baseUrl: string;
  model: string;
}

export type ConvertOptions = {
  useLlm: boolean;
  ocrMode: 'auto' | 'force' | 'off';
  includeSource: boolean;
};

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
  events?: JobEvent[];
  stages: Partial<Record<StageName, StageStatus>>;
  stats?: JobStats;
  markdown?: string;
  markdownName?: string;
  zipName?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}
