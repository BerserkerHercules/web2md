import type { StageName } from '../types';

export const STAGE_ORDER: StageName[] = [
  'fetch',
  'extract',
  'render',
  'screenshot',
  'ocr',
  'convert',
  'llm',
  'images',
  'package',
];

export const STAGE_LABELS: Record<StageName, string> = {
  fetch: '抓取网页',
  extract: 'DOM 正文解析',
  render: '动态渲染',
  screenshot: '页面截图',
  ocr: 'PaddleOCR-VL 识别',
  convert: 'Markdown 转换',
  llm: '大模型精炼',
  images: '下载图片',
  package: '打包产物',
};
