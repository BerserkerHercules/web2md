import { UA } from './fetcher';

export interface RenderResult {
  html: string;
  title: string;
}

export interface ScreenshotTile {
  index: number;
  buffer: Buffer;
}

export const VIEWPORT_WIDTH = 1280;
export const VIEWPORT_HEIGHT = 900;
/**
 * 相邻分屏重叠像素。无重叠切片会把跨边界的段落 / 整屏文字图切坏，
 * 导致 OCR 文本在接缝处断句、丢句；重叠区域由文本拼接层做去重。
 */
export const TILE_OVERLAP_PX = 180;
/** 长页面截图 OCR 的最大分屏数，防止超长页面无限调用 OCR */
export const MAX_TILES = 20;

type PlaywrightModule = typeof import('playwright');

let modulePromise: Promise<PlaywrightModule> | undefined;

/** 懒加载 Playwright，浏览器未安装时给出可操作的错误提示 */
async function loadPlaywright(): Promise<PlaywrightModule> {
  if (!modulePromise) {
    modulePromise = import('playwright').catch(() => {
      throw new Error(
        '动态渲染组件未安装，请在项目根目录执行：npx playwright install chromium',
      );
    }) as Promise<PlaywrightModule>;
  }
  return modulePromise;
}

export class BrowserSession {
  private browser: import('playwright').Browser | undefined;
  private page: import('playwright').Page | undefined;

  async launch(): Promise<void> {
    const pw = await loadPlaywright();
    try {
      this.browser = await pw.chromium.launch({ headless: true });
    } catch (err) {
      throw new Error(
        `Chromium 启动失败，请先执行 npx playwright install chromium。原因：${
          (err as Error).message
        }`,
      );
    }
    this.page = await this.browser.newPage({
      viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
      userAgent: UA,
      locale: 'zh-CN',
    });
    this.page.setDefaultNavigationTimeout(30_000);
  }

  /** 打开页面、滚动触发懒加载，返回渲染后的完整 HTML */
  async render(url: string): Promise<RenderResult> {
    if (!this.page) throw new Error('浏览器会话未初始化');
    const page = this.page;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // 等待网络空闲（失败不阻塞，部分站点持续轮询）
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});

    // 按视口逐屏渐进滚动，触发图片 / 列表懒加载。
    // 不能直接跳到底部：浏览器懒加载只在元素接近视口时触发，跳转会漏掉中段图片。
    await page.evaluate(
      async ([viewportH, maxSteps]) => {
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        let stable = 0;
        let lastHeight = -1;
        for (let i = 0; i < maxSteps; i++) {
          window.scrollBy(0, Math.round(viewportH * 0.8));
          await sleep(300);
          const h = Math.max(
            document.body.scrollHeight,
            document.documentElement.scrollHeight,
          );
          // 已到底且高度连续两轮不再增长 → 加载完成
          if (window.scrollY + viewportH >= h - 4 && h === lastHeight) {
            stable += 1;
            if (stable >= 2) break;
          } else {
            stable = 0;
          }
          lastHeight = h;
        }
        window.scrollTo(0, 0);
      },
      [VIEWPORT_HEIGHT, 80],
    );
    await page.waitForTimeout(600);

    return {
      html: await page.content(),
      title: await page.title(),
    };
  }

  /**
   * 按视口高度自上而下无重叠分屏截图（避免引入图像裁剪依赖）。
   * 调用前页面已处于目标地址。
   * 页面超过 MAX_TILES 屏时只截前若干屏，truncated=true 告知调用方告警。
   */
  async screenshotTiles(): Promise<{
    tiles: ScreenshotTile[];
    pageHeight: number;
    truncated: boolean;
  }> {
    if (!this.page) throw new Error('浏览器会话未初始化');
    const page = this.page;

    const metrics = await page.evaluate(
      ([w, h]) => {
        const height = Math.max(
          document.body.scrollHeight,
          document.documentElement.scrollHeight,
        );
        return { width: w, height, viewportH: h };
      },
      [VIEWPORT_WIDTH, VIEWPORT_HEIGHT],
    );

    const tiles: ScreenshotTile[] = [];
    const stride = metrics.viewportH - TILE_OVERLAP_PX;
    const totalTiles = Math.max(
      1,
      Math.ceil((metrics.height - metrics.viewportH) / stride) + 1,
    );
    const count = Math.min(totalTiles, MAX_TILES);
    for (let i = 0; i < count; i++) {
      const y = i * stride;
      const clipHeight = Math.min(metrics.viewportH, metrics.height - y);
      await page.evaluate((top) => window.scrollTo(0, top), y);
      await page.waitForTimeout(350);
      const buffer = await page.screenshot({
        type: 'png',
        clip: { x: 0, y: 0, width: metrics.width, height: clipHeight },
      });
      tiles.push({ index: i, buffer: Buffer.from(buffer) });
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    return {
      tiles,
      pageHeight: metrics.height,
      truncated: totalTiles > MAX_TILES,
    };
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = undefined;
    this.page = undefined;
  }
}
