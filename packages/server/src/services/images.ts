import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { UA } from './fetcher';
import { extractImageUrls } from './markdown';
import { hash8, mapLimit } from '../utils/text';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'image/avif': '.avif',
};

function extFromUrl(url: string, contentType: string | null): string {
  if (contentType && MIME_EXT[contentType.split(';')[0].trim().toLowerCase()]) {
    return MIME_EXT[contentType.split(';')[0].trim().toLowerCase()];
  }
  const pathname = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return '';
    }
  })();
  const m = /\.(jpe?g|png|gif|webp|bmp|svg|ico|avif)(?:$|[?#])/i.exec(pathname);
  if (m) return `.${m[1].toLowerCase().replace('jpeg', 'jpg')}`;
  return '.jpg';
}

interface DownloadedImage {
  url: string;
  localPath: string; // 形如 images/xx-hash.png
  ok: boolean;
  error?: string;
}

async function downloadImage(
  url: string,
  index: number,
  imagesDir: string,
  referer: string,
): Promise<DownloadedImage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const origin = new URL(referer).origin;
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Referer: referer,
        Origin: origin,
        Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ext = extFromUrl(url, res.headers.get('content-type'));
    const name = `${String(index + 1).padStart(2, '0')}-${hash8(url)}${ext}`;
    const localPath = join(imagesDir, name);

    // SVG / 小图直接写；其余流式落盘并限制大小
    const reader = res.body?.getReader();
    if (!reader) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_IMAGE_BYTES) throw new Error('图片超过 8MB 限制');
      await writeFile(localPath, buf);
    } else {
      let size = 0;
      const fileStream = createWriteStream(localPath);
      const nodeStream = Readable.from((async function* () {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_IMAGE_BYTES) {
            await reader.cancel();
            throw new Error('图片超过 8MB 限制');
          }
          yield Buffer.from(value);
        }
      })());
      await pipeline(nodeStream, fileStream);
    }
    return { url, localPath: `images/${name}`, ok: true };
  } catch (err) {
    return {
      url,
      localPath: '',
      ok: false,
      error: (err as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 下载 Markdown 中引用的全部远程图片，并重写为本地相对路径。
 * 下载失败的图片保留原远程 URL（不丢内容）。
 */
export async function localizeImages(
  markdown: string,
  jobDir: string,
  referer: string,
  onProgress?: (done: number, total: number, ok: number, failed: number) => void,
): Promise<{ markdown: string; downloaded: number; failed: number }> {
  const urls = extractImageUrls(markdown);
  if (urls.length === 0) return { markdown, downloaded: 0, failed: 0 };

  const imagesDir = join(jobDir, 'images');
  await mkdir(imagesDir, { recursive: true });

  let okCount = 0;
  let failCount = 0;
  const results = await mapLimit(urls, 4, async (url, i) => {
    const r = await downloadImage(url, i, imagesDir, referer);
    if (r.ok) okCount += 1;
    else failCount += 1;
    onProgress?.(okCount + failCount, urls.length, okCount, failCount);
    return r;
  });

  let out = markdown;
  for (const r of results) {
    if (!r.ok) continue;
    // 同时替换带 title 和不带 title 的 Markdown 图片引用
    const escaped = r.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(
      new RegExp(`(!\\[[^\\]]*\\]\\()${escaped}(\\s+"[^"]*")?\\)`, 'g'),
      `$1${r.localPath}$2)`,
    );
  }

  return { markdown: out, downloaded: okCount, failed: failCount };
}
