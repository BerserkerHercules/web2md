import iconv from 'iconv-lite';
import jschardet from 'jschardet';

export interface FetchResult {
  url: string;
  html: string;
  status: number;
  contentType: string;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 从 Content-Type 响应头提取 charset */
function charsetFromHeader(contentType: string): string | undefined {
  const m = /charset=([^;]+)/i.exec(contentType);
  return m?.[1].trim().toLowerCase();
}

/** 从 HTML meta 中提取 charset（探测前 4KB 即可） */
function charsetFromMeta(head: string): string | undefined {
  const m =
    /<meta[^>]+charset=["']?\s*([a-z0-9_\-:.]+)/i.exec(head) ??
    /<meta[^>]+content=["'][^"']*charset=([a-z0-9_\-:.]+)/i.exec(head);
  return m?.[1].trim().toLowerCase();
}

function decode(buffer: Buffer, contentType: string): string {
  const asciiHead = buffer.subarray(0, 4096).toString('ascii');
  const charset =
    charsetFromHeader(contentType) ??
    charsetFromMeta(asciiHead) ??
    jschardet.detect(buffer.subarray(0, 8192)).encoding?.toLowerCase();

  if (!charset || charset === 'utf-8' || charset === 'utf8' || charset === 'ascii') {
    return buffer.toString('utf-8');
  }
  // 中文站点常见别名归一
  const normalized =
    charset === 'gb2312' || charset === 'gbk' ? 'gb18030' : charset;
  if (iconv.encodingExists(normalized)) {
    return iconv.decode(buffer, normalized);
  }
  return buffer.toString('utf-8');
}

/** 抓取网页原始 HTML，自动跟随重定向并处理非 UTF-8 编码 */
export async function fetchHtml(rawUrl: string): Promise<FetchResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('网址格式不正确，请输入以 http(s):// 开头的完整地址');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('仅支持 http / https 协议的网址');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
  } catch (err) {
    const e = err as Error;
    if (e.name === 'AbortError') throw new Error('抓取超时（25 秒），该网站可能响应过慢或无法访问');
    throw new Error(`无法访问目标网站：${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`目标网站返回 HTTP ${res.status} ${res.statusText}`);
  }
  const contentType = res.headers.get('content-type') ?? 'text/html';
  if (!/html|xml|text/i.test(contentType)) {
    throw new Error(`目标地址不是网页（Content-Type: ${contentType}）`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const html = decode(buffer, contentType);
  return { url: res.url || url.href, html, status: res.status, contentType };
}

export { UA };
