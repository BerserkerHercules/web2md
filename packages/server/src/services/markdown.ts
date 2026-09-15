import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
// 该包无官方类型定义
// eslint-disable-next-line @typescript-eslint/no-var-requires
const gfm = require('turndown-plugin-gfm') as {
  tables: TurndownService.Plugin;
  strikethrough: TurndownService.Plugin;
};

function absolutize(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

/** 从代码节点的 class 中识别语言，如 language-js / hljs python / highlight-source-go */
function detectLanguage(className?: string): string {
  if (!className) return '';
  const patterns = [
    /language-([\w#+-]+)/i,
    /lang-([\w#+-]+)/i,
    /hljs[-\s]+([\w#+-]+)/i,
    /highlight-source-([\w#+-]+)/i,
    /brush:\s*([\w#+-]+)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(className);
    if (m?.[1]) return m[1].toLowerCase();
  }
  return '';
}

/** 仅保留 http(s) 图片；data: 等内嵌图跳过（避免 Markdown 被巨长 base64 污染） */
function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export function htmlToMarkdown(html: string, baseUrl: string): string {
  const $ = cheerio.load(`<div id="__root__">${html}</div>`);

  // 相对地址全部转绝对地址，便于后续下载图片
  $('img[src]').each((_, el) => {
    const src = el.attribs?.['src'];
    if (src) el.attribs['src'] = absolutize(src.trim(), baseUrl);
  });
  $('a[href]').each((_, el) => {
    const href = el.attribs?.['href'];
    if (href && !/^(https?:|mailto:|#|\/)/i.test(href)) return;
    if (href) el.attribs['href'] = absolutize(href.trim(), baseUrl);
  });
  // 懒加载图片常见属性兜底
  $('img[data-src], img[data-original], img[data-lazy-src]').each((_, el) => {
    const lazy =
      el.attribs?.['data-src'] ||
      el.attribs?.['data-original'] ||
      el.attribs?.['data-lazy-src'];
    if (lazy && (!el.attribs?.['src'] || el.attribs['src'].startsWith('data:'))) {
      el.attribs['src'] = absolutize(lazy.trim(), baseUrl);
    }
  });

  // figure/figcaption：图注写入 data-md-caption 供 Turndown 规则读取，
  // 随后移除 figcaption，避免图注既以斜体输出又作为普通文本重复
  $('figure').each((_, figure) => {
    const $figure = $(figure);
    const img = $figure.find('img')[0];
    const caption = $figure.find('figcaption').first().text().trim();
    if (img && caption) {
      img.attribs['data-md-caption'] = caption;
    }
    $figure.find('figcaption').remove();
  });

  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    blankReplacement(_content, node) {
      // 保留代码块、表格周边必要的空行
      const name = (node as unknown as { nodeName?: string }).nodeName ?? '';
      return ['PRE', 'TABLE', 'BLOCKQUOTE', 'UL', 'OL'].includes(name)
        ? '\n\n'
        : '';
    },
  });
  td.use(gfm.tables);
  td.use(gfm.strikethrough);

  // 图片规则：仅 http(s)，输出 alt + 绝对地址；图注追加为斜体行
  td.addRule('images', {
    filter: 'img',
    replacement(_content, node) {
      const n = node as unknown as HTMLImageElement;
      const src = (n.getAttribute('src') || '').trim();
      if (!src || !isHttpUrl(src)) return '';
      const alt = (n.alt || '').replace(/[\r\n]+/g, ' ').trim();
      const title = n.getAttribute('title');
      const caption = (n.getAttribute('data-md-caption') || '').trim();
      const titlePart = title ? ` "${title.replace(/"/g, '&quot;')}"` : '';
      const md = `![${alt}](${src}${titlePart})`;
      return caption ? `${md}\n\n*${caption}*` : md;
    },
  });

  // 代码块规则：保留语言标记，去除语法高亮层的多余 DOM
  td.addRule('fencedCodeBlock', {
    filter(node) {
      return (
        node.nodeName === 'PRE' &&
        node.firstChild?.nodeName !== 'CODE'
      );
    },
    replacement(_content, node) {
      const n = node as unknown as HTMLElement;
      const lang =
        detectLanguage(n.className) ||
        detectLanguage(n.querySelector('code')?.className ?? '');
      const text = n.textContent ?? '';
      return fenceCode(text.replace(/\n$/, ''), lang);
    },
  });

  td.addRule('codeBlockWithLang', {
    filter(node) {
      return (
        node.nodeName === 'PRE' &&
        node.firstChild?.nodeName === 'CODE'
      );
    },
    replacement(_content, node) {
      const n = node as unknown as HTMLElement;
      const codeEl = n.querySelector('code');
      const lang = detectLanguage(
        codeEl?.className || n.className || '',
      );
      const text = codeEl?.textContent ?? n.textContent ?? '';
      return fenceCode(text.replace(/\n$/, ''), lang);
    },
  });

  // 移除空链接和纯锚点链接
  td.addRule('emptyLinks', {
    filter(node) {
      if (node.nodeName !== 'A') return false;
      const a = node as unknown as HTMLAnchorElement;
      const href = a.getAttribute('href') ?? '';
      return !a.textContent?.trim() || href.startsWith('javascript:');
    },
    replacement() {
      return '';
    },
  });

  const markdown = td.turndown($.html('#__root__'));
  return markdown;
}

function fenceCode(code: string, lang: string): string {
  // 代码内含 ``` 时使用四个反引号围栏，避免截断
  const fence = code.includes('```') ? '````' : '```';
  return `\n\n${fence}${lang}\n${code}\n${fence}\n\n`;
}

/** 从 Markdown 中提取所有需要下载的图片地址（去重、仅远程） */
export function extractImageUrls(markdown: string): string[] {
  const urls = new Set<string>();
  const re = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) {
    urls.add(m[1]);
  }
  return [...urls];
}

/** 统计 Markdown 中远程图片引用数量 */
export function countRemoteImages(markdown: string): number {
  return extractImageUrls(markdown).length;
}
