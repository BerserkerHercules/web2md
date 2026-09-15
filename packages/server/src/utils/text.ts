import { createHash } from 'node:crypto';

/** 清洗为 Windows / macOS / Linux 通用的安全文件名 */
export function safeFileName(name: string, fallback = 'index'): string {
  const cleaned = (name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

export function hash8(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 8);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 简单并发限制器 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/**
 * 标题层级归一化：
 * 1. 文首补唯一 H1（来自网页 title）；
 * 2. 正文标题整体平移，使最浅层级从 H2 开始；
 * 3. 相邻标题不得跳级（h2 -> h4 会被收敛为 h2 -> h3）。
 */
export function normalizeHeadings(markdown: string, title: string): string {
  const lines = markdown.split('\n');
  const parsed = lines.map((line) => {
    const m = line.match(HEADING_RE);
    return m ? { level: m[1].length, text: m[2].trim(), raw: line } : null;
  });

  const bodyHeadings = parsed.filter((h): h is NonNullable<typeof h> => !!h);
  let shift = 0;
  if (bodyHeadings.length > 0) {
    const minLevel = Math.min(...bodyHeadings.map((h) => h.level));
    shift = minLevel <= 1 ? 2 - minLevel : 0;
  }

  let currentLevel = 1;
  const out = lines.map((line, idx) => {
    const h = parsed[idx];
    if (!h) return line;
    let level = h.level + shift;
    if (level > currentLevel + 1) level = currentLevel + 1;
    level = Math.min(6, Math.max(2, level));
    currentLevel = level;
    return `${'#'.repeat(level)} ${h.text}`;
  });

  let body = out.join('\n');
  const cleanTitle = title.trim() || '未命名网页';
  const h1 = `# ${cleanTitle}`;

  // 正文首个标题若与页面标题同名（正文自带 <h1> 平移而来），删除以免重复
  const firstHeading = /^(#{2,6})\s+(.+?)\s*$/m.exec(body.trimStart());
  if (firstHeading) {
    const headingText = firstHeading[2].trim();
    const same =
      headingText === cleanTitle ||
      headingText.includes(cleanTitle) ||
      cleanTitle.includes(headingText);
    if (same && Math.abs(headingText.length - cleanTitle.length) <= 6) {
      body = body
        .trimStart()
        .replace(/^(#{2,6})\s+(.+?)\s*\n+/, '');
    }
  }

  // 若正文本身已经包含同名 H1 则不重复添加
  if (!new RegExp(`^#\\s+${escapeRegExp(cleanTitle).slice(0, 40)}`, 'm').test(body)) {
    body = `${h1}\n\n${body}`;
  }
  return body;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 规则化去噪（不依赖大模型）：
 * - 连续 3+ 空行折叠为 1 个空行；
 * - 连续重复的相同行折叠为 1 行；
 * - 全文出现 4 次以上的短行（导航菜单 / 面包屑）整体移除；
 * - 去除行尾空白。
 */
export function denoise(markdown: string): string {
  const lines = markdown.replace(/[ \t]+\n/g, '\n').split('\n');

  const freq = new Map<string, number>();
  for (const line of lines) {
    const key = line.trim();
    if (key.length > 0 && key.length <= 30 && !key.startsWith('#') && !key.includes('![')) {
      freq.set(key, (freq.get(key) ?? 0) + 1);
    }
  }
  const boilerplate = new Set<string>();
  for (const [key, count] of freq) {
    if (count >= 4 && /^[\w\u4e00-\u9fa5\s./»›>·|-]+$/.test(key)) boilerplate.add(key);
  }

  const out: string[] = [];
  let blankCount = 0;
  let lastNonEmpty = '';
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      blankCount += 1;
      if (blankCount <= 1) out.push('');
      continue;
    }
    blankCount = 0;
    const key = line.trim();
    if (boilerplate.has(key)) continue;
    if (key === lastNonEmpty) continue; // 连续重复行
    lastNonEmpty = key;
    out.push(line);
  }

  return out.join('\n').replace(/^\n+|\n+$/g, '') + '\n';
}

/** 合并 3 个以上连续换行并保证文件以单个换行结尾 */
export function tidyBlankLines(markdown: string): string {
  return markdown.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '') + '\n';
}

/**
 * 拼接带重叠区域的相邻 OCR 分屏文本：
 * 截图重叠使接缝两侧识别出相同行，这里通过“接缝附近最长公共子串”定位重复段，
 * - 删除下一屏开头到锚点（含）为止的重复内容；
 * - 若上一屏最后一行是残句（无句末标点）且其开头片段在下一屏中重现，
 *   说明该行完整版本在下一屏，删除上一屏的残行，避免断句 / 重复。
 * 找不到可靠锚点时原样拼接（宁可重复，不可丢字）。
 */
const STITCH_WINDOW = 300;
const STITCH_ANCHOR_MIN = 12;
const STITCH_NEAR = 140;

function longestCommonAnchor(a: string, b: string): { ai: number; bi: number; len: number } | null {
  // dp[j] = 以 a[i], b[j] 结尾的公共子串长度（滚动数组）
  let best: { ai: number; bi: number; len: number } | null = null;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (!best || cur[j] > best.len) {
          best = { ai: i - cur[j], bi: j - cur[j], len: cur[j] };
        }
      }
    }
    prev = cur;
  }
  if (!best || best.len < STITCH_ANCHOR_MIN) return null;
  // 锚点必须贴近两侧接缝
  if (best.ai < a.length - STITCH_NEAR - best.len) return null;
  if (best.bi > STITCH_NEAR) return null;
  return best;
}

function stitchTwo(a: string, b: string): string {
  const right = b.slice(0, STITCH_WINDOW);

  // 1) 先处理上一屏末尾的残行：无句末标点且开头片段在下一屏接缝区域重现，
  //    说明该行的完整版本在下一屏，从上一屏删掉残行（必须先于锚点查找）
  let head = a.replace(/\s+$/, '');
  const lastLine = head.split('\n').pop()?.trim() ?? '';
  if (lastLine.length >= 8 && !/[。！？!?：:…”"』」）)]$/.test(lastLine)) {
    const probe = lastLine.slice(0, Math.min(16, lastLine.length));
    if (right.includes(probe)) {
      head = head.slice(0, head.length - lastLine.length).replace(/\s+$/, '');
    }
  }

  // 2) 在新的接缝处找最长公共锚点，删除下一屏锚点（含）之前的重复内容
  const anchor = longestCommonAnchor(head.slice(-STITCH_WINDOW), right);
  const remainder = anchor
    ? right.slice(anchor.bi + anchor.len) + b.slice(STITCH_WINDOW)
    : b;

  const joined = `${head}\n\n${remainder.trimStart()}`;
  return joined.replace(/^\n+|\n+$/g, '');
}

/** 顺序拼接多分屏 OCR 文本，自动消除重叠区域的重复与接缝断句 */
export function stitchOcrParts(texts: string[]): string {
  const valid = texts.map((t) => t.trim()).filter(Boolean);
  if (valid.length <= 1) return valid.join('\n\n');
  return valid.reduce((acc, t) => stitchTwo(acc, t));
}

export function countWords(text: string): number {
  const cjk = text.match(/[\u4e00-\u9fa5]/g)?.length ?? 0;
  const words = text.replace(/[\u4e00-\u9fa5]/g, ' ').split(/\s+/).filter(Boolean).length;
  return cjk + words;
}
