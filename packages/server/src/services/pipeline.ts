import { mkdir } from 'node:fs/promises';
import { loadSettings } from '../config';
import { store } from '../store';
import type { ConvertOptions, JobEvent, StageName, StageStatus } from '../types';
import { countWords, denoise, normalizeHeadings, safeFileName, tidyBlankLines } from '../utils/text';
import { writeArtifacts } from './archive';
import {
  BrowserSession,
  TILE_OVERLAP_PX,
  VIEWPORT_HEIGHT,
} from './browser';
import { extractFromHtml } from './extractor';
import { fetchHtml } from './fetcher';
import { localizeImages } from './images';
import { refineMarkdown } from './llm';
import { htmlToMarkdown } from './markdown';
import { recognizeTiles } from './ocr';

const ALL_STAGES: StageName[] = [
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

export async function runConversion(jobId: string): Promise<void> {
  const job = store.get(jobId);
  if (!job) return;

  const emit = (event: Omit<JobEvent, 't'>): void => {
    store.addEvent(jobId, { ...event, t: Date.now() });
  };
  const stage = (name: StageName, status: StageStatus, message?: string): void => {
    const current = store.get(jobId);
    if (current) {
      store.update(jobId, { stages: { ...current.stages, [name]: status } });
    }
    emit({ type: 'stage', stage: name, status, message });
  };
  const log = (message: string): void => emit({ type: 'log', message });

  const settings = loadSettings();
  const options: ConvertOptions = job.options;

  store.update(jobId, { status: 'running' });

  let finalUrl = job.url;
  let title = '未命名网页';
  let mode: 'dom' | 'ocr' = 'dom';
  let ocrTiles = 0;
  let llmUsed = false;
  let bodyMarkdown = '';

  const markFailure = (message: string): void => {
    const current = store.get(jobId);
    if (current) {
      for (const name of ALL_STAGES) {
        if (current.stages[name] === 'running') {
          stage(name, 'failed', message);
        }
      }
    }
    store.update(jobId, { status: 'failed', error: message });
    emit({ type: 'error', message });
  };

  try {
    // 1. 抓取 HTML ----------------------------------------------------------
    stage('fetch', 'running', '正在抓取网页…');
    const fetched = await fetchHtml(job.url);
    finalUrl = fetched.url;
    store.update(jobId, { finalUrl });
    stage('fetch', 'done', `抓取成功（${(fetched.html.length / 1024).toFixed(1)} KB）`);

    // 2. DOM 提取 -----------------------------------------------------------
    stage('extract', 'running', '正在解析 DOM 结构、提取正文…');
    let extracted = extractFromHtml(fetched.html, finalUrl);
    title = extracted.title || title;
    stage(
      'extract',
      'done',
      extracted.lowQuality
        ? `正文质量不足（约 ${extracted.textLength} 字），将尝试动态渲染`
        : `正文提取成功（约 ${extracted.textLength} 字，${extracted.paragraphCount} 个段落）`,
    );

    // 3. 动态渲染（按需）+ 截图 OCR -----------------------------------------
    const forceOcr = options.ocrMode === 'force';
    const ocrAllowed = options.ocrMode !== 'off' && settings.ocr.enabled;
    // 提取质量低时即便未启用 OCR 也尝试渲染：渲染后的 DOM 重解析本身可能成功
    const needsRender = forceOcr || extracted.lowQuality;

    if (needsRender) {
      let session: BrowserSession | undefined;
      try {
        stage('render', 'running', '启动无头浏览器，渲染动态内容…');
        session = new BrowserSession();
        await session.launch();
        const rendered = await session.render(finalUrl);
        stage('render', 'done', '动态渲染完成，重新解析正文');

        const reExtracted = extractFromHtml(rendered.html, finalUrl);
        if (reExtracted.textLength > extracted.textLength) {
          extracted = reExtracted;
        }
        // 微信等页面的标题在 <title> / #activity-name，提取器取不到时用浏览器标题兜底
        title = extracted.title || rendered.title || title;

        const shouldOcr =
          forceOcr || (extracted.lowQuality && ocrAllowed);

        if (shouldOcr) {
          if (!settings.ocr.enabled) {
            log('截图 OCR 未在设置中启用，跳过截图识别');
          } else if (
            settings.ocr.provider === 'aistudio' &&
            !settings.ocr.token
          ) {
            log('未配置 PaddleOCR-VL Token，跳过截图识别');
            stage('screenshot', 'skipped', '未配置 OCR Token');
            stage('ocr', 'skipped', '未配置 OCR Token');
          } else if (settings.ocr.provider === 'custom' && !settings.ocr.endpoint) {
            log('未配置自建 OCR 服务地址，跳过截图识别');
            stage('screenshot', 'skipped', '未配置 OCR 服务地址');
            stage('ocr', 'skipped', '未配置 OCR 服务地址');
          } else {
            stage('screenshot', 'running', '正在对整页分屏截图…');
            const shot = await session.screenshotTiles();
            const tiles = shot.tiles;
            ocrTiles = tiles.length;
            stage(
              'screenshot',
              'done',
              shot.truncated
                ? `页面过长，仅识别前 ${tiles.length} 屏（覆盖约 ${Math.round(
                    ((tiles.length - 1) * (VIEWPORT_HEIGHT - TILE_OVERLAP_PX) +
                      VIEWPORT_HEIGHT) /
                      shot.pageHeight *
                      100,
                  )}% 页面长度）`
                : `截图完成，共 ${tiles.length} 屏`,
            );
            if (shot.truncated) {
              log(
                `页面高 ${shot.pageHeight}px，超过 ${tiles.length} 屏上限，文末内容未参与 OCR`,
              );
            }

            stage('ocr', 'running', `PaddleOCR-VL 识别中（${tiles.length} 个异步任务，单任务最长 5 分钟）…`);
            const ocrResult = await recognizeTiles(
              tiles,
              settings.ocr,
              (done, total) => {
                log(`OCR 完成 ${done}/${total}`);
              },
              (tileIndex, phase) => {
                const n = tileIndex + 1;
                if (phase === 'pending') {
                  log(`第 ${n} 屏已提交，云端排队中…`);
                } else if (phase.startsWith('queue-wait')) {
                  log(`第 ${n} 屏提交遇到云端队列已满，10s 后重试…`);
                } else if (phase.startsWith('running')) {
                  const pages = phase.split(':')[1];
                  log(pages ? `第 ${n} 屏识别中（${pages} 页）…` : `第 ${n} 屏识别中…`);
                }
              },
            );
            if (ocrResult.failedTiles >= tiles.length) {
              // 全部识别失败（如密钥错误、队列已满）→ 不采用 OCR 文本，回退 DOM 结果
              const reason = ocrResult.firstError ?? '未知原因';
              stage('ocr', 'skipped', `所有分屏识别失败，回退 DOM：${reason}`);
              log(`OCR 全部失败，已回退。原因：${reason}`);
            } else {
              if (ocrResult.failedTiles > 0) {
                log(`${ocrResult.failedTiles} 屏识别失败，其余结果继续使用`);
              }
              mode = 'ocr';
              // OCR 结果可能自带页标题（H1），统一走标题归一化，避免重复 H1
              bodyMarkdown = tidyBlankLines(
                normalizeHeadings(denoise(ocrResult.text), title),
              );
              stage('ocr', 'done', `OCR 完成，识别约 ${countWords(ocrResult.text)} 字`);
            }
          }
        }
      } catch (err) {
        // 浏览器/OCR 属于增强通道：失败时降级使用已有 DOM 结果，不阻断转换
        log(`动态渲染失败：${(err as Error).message}，使用已有提取结果继续`);
        const current = store.get(jobId);
        for (const name of ['render', 'screenshot', 'ocr'] as StageName[]) {
          if (current?.stages[name] === 'running') stage(name, 'skipped', (err as Error).message);
        }
      } finally {
        await session?.close();
      }
    }

    // 4. HTML → Markdown（DOM 通道） ---------------------------------------
    if (!bodyMarkdown) {
      if (!extracted.html.trim()) {
        throw new Error(
          '无法从该页面提取到正文内容（可能是纯动态页面），可在转换选项中开启「强制截图 OCR」后重试',
        );
      }
      stage('convert', 'running', '正在转换为 Markdown（标题/表格/代码块/图片）…');
      const raw = htmlToMarkdown(extracted.html, finalUrl);
      bodyMarkdown = tidyBlankLines(normalizeHeadings(denoise(raw), title));
      stage('convert', 'done', 'Markdown 转换完成');
    } else {
      stage('convert', 'skipped', 'OCR 文本模式，直接使用识别文本');
    }

    // 5. 大模型精炼（可选，任何失败自动回退规则化结果） ---------------------
    if (options.useLlm) {
      if (!settings.llm.enabled) {
        stage('llm', 'skipped', '未在设置中启用大模型');
      } else {
        stage('llm', 'running', '大模型正在理解内容、去噪与推断标题…');
        try {
          const llmOutput = tidyBlankLines(
            await refineMarkdown(bodyMarkdown, title, finalUrl, settings.llm),
          );
          // 从 LLM 输出首行解析 # 标题，回填 job.title；
          // 用 LLM 推断的标题优先于 DOM/渲染层兜底拿到的 URL / 未命名网页
          const firstH1Match = /^#\s+(.+?)\s*$/m.exec(llmOutput);
          const inferred = firstH1Match?.[1]?.trim() ?? '';
          const isNoise =
            !inferred ||
            inferred.length < 2 ||
            inferred.length > 120 ||
            /^(未命名网页|https?:\/\/)/i.test(inferred);
          if (!isNoise) {
            if (inferred !== title) {
              title = inferred;
              store.update(jobId, { title });
              log(`标题由大模型识别：${title}`);
            }
          } else if (!title || /^(未命名网页|https?:\/\/)/i.test(title)) {
            log('大模型未能识别出可靠标题，保留原标题占位');
          }
          bodyMarkdown = llmOutput;
          llmUsed = true;
          stage('llm', 'done', '大模型精炼完成（去噪 + 标题推断）');
        } catch (err) {
          log((err as Error).message);
          stage('llm', 'skipped', (err as Error).message);
        }
      }
    } else {
      stage('llm', 'skipped', '本次转换未勾选大模型精炼');
    }

    // 来源引用放在 AI 处理之后插入，避免被模型删改
    if (options.includeSource) {
      const sourceLine = `> 来源：[${title.replace(/\n/g, ' ')}](${finalUrl})`;
      const lines = bodyMarkdown.split('\n');
      bodyMarkdown =
        lines[0]?.startsWith('# ')
          ? tidyBlankLines([lines[0], '', sourceLine, '', ...lines.slice(1)].join('\n'))
          : tidyBlankLines(`${sourceLine}\n\n${bodyMarkdown}`);
    }

    // 6. 下载图片并重写为本地相对路径 ---------------------------------------
    stage('images', 'running', '正在下载正文图片…');
    const jobDir = store.artifactDir(jobId);
    await mkdir(jobDir, { recursive: true });
    const localized = await localizeImages(bodyMarkdown, jobDir, finalUrl, (done, total, ok, failed) => {
      log(`图片下载 ${done}/${total}（成功 ${ok}${failed ? `，失败 ${failed}` : ''}）`);
    });
    bodyMarkdown = localized.markdown;
    stage(
      'images',
      'done',
      `图片处理完成：成功 ${localized.downloaded} 张` +
        (localized.failed ? `，失败 ${localized.failed} 张（保留原图链接）` : ''),
    );

    // 7. 打包 ZIP -----------------------------------------------------------
    stage('package', 'running', '正在打包 Markdown 与图片…');
    const archive = writeArtifacts(jobDir, safeFileName(title), bodyMarkdown);
    stage('package', 'done', `打包完成（${(archive.zipSize / 1024).toFixed(1)} KB）`);

    // 8. 完成 ---------------------------------------------------------------
    store.update(jobId, {
      status: 'done',
      title,
      finalUrl,
      markdown: bodyMarkdown,
      markdownName: archive.markdownName,
      zipName: archive.zipName,
      stats: {
        mode,
        words: countWords(bodyMarkdown),
        images: localized.downloaded,
        imagesFailed: localized.failed,
        ocrTiles,
        llmUsed,
        zipSize: archive.zipSize,
      },
    });
    emit({ type: 'done', message: `转换完成：${title}` });
  } catch (err) {
    markFailure((err as Error).message || String(err));
  }
}
