import { Readability } from '@mozilla/readability';
import * as cheerio from 'cheerio';
import { JSDOM } from 'jsdom';

export interface ExtractResult {
  title: string;
  byline?: string;
  html: string;
  /** 纯文本字数（含中文按字计） */
  textLength: number;
  /** 质量评估：正文段落数 */
  paragraphCount: number;
  /** 是否疑似动态渲染 / 提取质量不足 */
  lowQuality: boolean;
  excerpt: string;
}

/** 提取前移除的明显噪声节点 */
const NOISE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'nav',
  'header.site-header',
  'footer',
  'aside',
  'form',
  'input',
  'button',
  '[role="navigation"]',
  '[role="banner"]',
  '[aria-hidden="true"]',
  '.advertisement',
  '.advertising',
  '.ads',
  '.ad-box',
  '.banner-ad',
  '.google-ad',
  '.adsbygoogle',
  '[class*="advertisement"]',
  '[id*="advertisement"]',
  '[class*="-ads-"]',
  '.related-posts',
  '.related-articles',
  '.recommend',
  '.recommended',
  '.comment-respond',
  '.comments-area',
  '#comments',
  '.cookie',
  '.popup',
  '.modal',
  '.share',
  '.social-share',
  '.back-to-top',
  '.breadcrumb',
];

function preprocess(html: string): string {
  const $ = cheerio.load(html);

  for (const sel of NOISE_SELECTORS) {
    try {
      $(sel).remove();
    } catch {
      /* 个别选择器兼容性问题忽略 */
    }
  }
  // 移除空的 div / section（自底向上，避免误删嵌套容器）
  $('div, section, span, p').each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    const hasMedia = $el.find('img,video,pre,table,iframe').length > 0;
    if (!text && !hasMedia) $el.remove();
  });
  // 移除展示性属性，保留 class（语言高亮类）、href、src、alt、colspan 等
  $('*').each((_, el) => {
    if (el.type !== 'tag') return;
    const keep = new Set([
      'href',
      'src',
      'alt',
      'title',
      'colspan',
      'rowspan',
      'class',
      'start',
      'type',
      // 懒加载图片占位属性，后续转换阶段会提升为 src
      'data-src',
      'data-original',
      'data-lazy-src',
    ]);
    for (const attr of Object.keys(el.attribs ?? {})) {
      if (!keep.has(attr)) el.attribs && delete el.attribs[attr];
    }
  });

  return $.html();
}

function scoreText(text: string): { length: number; paragraphs: number } {
  const paragraphs = text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20).length;
  return {
    length: text.replace(/\s/g, '').length,
    paragraphs,
  };
}

/** Readability 主通道 */
function readabilityExtract(html: string, url: string) {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document, {
    charThreshold: 200,
    keepClasses: true,
  });
  return reader.parse();
}

/** 启发式兜底：在常见正文容器中选文本密度最高的 */
function heuristicExtract(
  html: string,
): { title: string; content: string } | null {
  const $ = cheerio.load(html);
  const candidates = $(
    'article, main, [role="main"], .article, .post, .content, .entry-content, .markdown-body, #content, #main',
  ).toArray();

  let best: { score: number; el: unknown } | null = null;
  for (const el of candidates) {
    const $el = $(el);
    const text = $el.text();
    const linkText = $el.find('a').text().length;
    const density = text.length ? linkText / text.length : 1;
    const score = text.length * (1 - Math.min(density, 0.9));
    if (!best || score > best.score) best = { score, el };
  }

  if (!best || best.score < 400) {
    // 最后手段：整个 body
    const body = $('body');
    if (body.text().trim().length < 100) return null;
    best = { score: body.text().length, el: body[0] };
  }
  return {
    title: $('title').first().text().trim() || $('h1').first().text().trim() || '未命名网页',
    content: $.html(best.el as never),
  };
}

export function extractFromHtml(rawHtml: string, url: string): ExtractResult {
  const cleaned = preprocess(rawHtml);

  let title = '';
  let contentHtml = '';
  let byline: string | undefined;
  let excerpt = '';

  const article = readabilityExtract(cleaned, url);
  if (article?.content) {
    title = article.title || '';
    contentHtml = article.content;
    byline = article.byline ?? undefined;
    excerpt = article.excerpt ?? '';
  } else {
    const fallback = heuristicExtract(cleaned);
    if (fallback) {
      title = fallback.title;
      contentHtml = fallback.content;
    }
  }

  if (!contentHtml.trim()) {
    return {
      title: title || '未命名网页',
      html: '',
      textLength: 0,
      paragraphCount: 0,
      lowQuality: true,
      excerpt: '',
    };
  }

  const $ = cheerio.load(`<div id="__root__">${contentHtml}</div>`);
  const text = $('#__root__').text();
  const { length, paragraphs } = scoreText(text);
  if (!title) title = $('h1').first().text().trim() || '未命名网页';

  return {
    title: title.trim(),
    byline,
    html: contentHtml,
    textLength: length,
    paragraphCount: paragraphs,
    lowQuality: length < 400 || paragraphs < 3,
    excerpt: excerpt || text.slice(0, 160).trim(),
  };
}
