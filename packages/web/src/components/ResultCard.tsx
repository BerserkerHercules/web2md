import { useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Check,
  Download,
  Eye,
  FileCode2,
  FileImage,
  FileText,
  ScanText,
  Sparkles,
} from 'lucide-react';
import { downloadUrl, markdownUrl } from '../api';
import type { Job } from '../types';

marked.setOptions({ gfm: true, breaks: false });

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 跨浏览器剪贴板写入（优先 Clipboard API，降级 textarea execCommand） */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 降级 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

interface Props {
  job: Job;
}

export default function ResultCard({ job }: Props) {
  const [tab, setTab] = useState<'preview' | 'raw'>('preview');
  const [copied, setCopied] = useState(false);

  const html = useMemo(() => {
    if (!job.markdown) return '';
    const raw = marked.parse(job.markdown, { async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [job.markdown]);

  const stats = job.stats;

  const handleCopy = async () => {
    if (!job.markdown) return;
    const ok = await copyToClipboard(job.markdown);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="rounded-2xl border border-emerald-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-5">
        <CheckCircle2 className="h-6 w-6 text-emerald-500" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold text-slate-900">
            {job.title}
          </h3>
          <a
            href={job.finalUrl ?? job.url}
            target="_blank"
            rel="noreferrer"
            className="block truncate text-xs text-slate-400 hover:text-indigo-600"
          >
            {job.finalUrl ?? job.url}
          </a>
        </div>
        <div className="flex gap-2">
          <a
            href={downloadUrl(job.id)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-indigo-700"
          >
            <Download className="h-3.5 w-3.5" />
            下载 ZIP
          </a>
          <a
            href={markdownUrl(job.id)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            <FileText className="h-3.5 w-3.5" />
            仅 .md
          </a>
        </div>
      </div>

      {stats && (
        <div className="flex flex-wrap gap-x-6 gap-y-2 border-b border-slate-100 bg-slate-50/60 px-5 py-3 text-xs text-slate-600">
          <span className="inline-flex items-center gap-1.5">
            <FileCode2 className="h-3.5 w-3.5 text-slate-400" />
            约 {stats.words.toLocaleString()} 字
          </span>
          <span className="inline-flex items-center gap-1.5">
            <FileImage className="h-3.5 w-3.5 text-slate-400" />
            图片 {stats.images} 张
            {stats.imagesFailed > 0 && (
              <span className="text-amber-600">（{stats.imagesFailed} 张保留原链接）</span>
            )}
          </span>
          <span className="inline-flex items-center gap-1.5">
            {stats.mode === 'ocr' ? (
              <>
                <ScanText className="h-3.5 w-3.5 text-indigo-500" />
                OCR 模式 · {stats.ocrTiles} 屏
              </>
            ) : (
              <>
                <FileCode2 className="h-3.5 w-3.5 text-emerald-500" />
                DOM 解析模式
              </>
            )}
          </span>
          {stats.llmUsed && (
            <span className="inline-flex items-center gap-1.5 text-indigo-600">
              <Sparkles className="h-3.5 w-3.5" />
              已通过大模型精炼
            </span>
          )}
          <span>ZIP {formatSize(stats.zipSize)}</span>
        </div>
      )}

      {stats?.imagesFailed ? (
        <div className="flex items-start gap-2 border-b border-amber-100 bg-amber-50 px-5 py-2.5 text-xs text-amber-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          部分图片因站点防盗链或超时下载失败，Markdown 中已保留其原始网络链接。
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3 px-5 pt-3">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setTab('preview')}
            className={`inline-flex items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-2 text-xs font-medium transition ${
              tab === 'preview'
                ? 'border-indigo-600 text-indigo-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <Eye className="h-3.5 w-3.5" />
            渲染预览
          </button>
          <button
            onClick={() => setTab('raw')}
            className={`inline-flex items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-2 text-xs font-medium transition ${
              tab === 'raw'
                ? 'border-indigo-600 text-indigo-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <FileCode2 className="h-3.5 w-3.5" />
            Markdown 源码
          </button>
        </div>
        <button
          onClick={handleCopy}
          disabled={!job.markdown}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
            copied
              ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
              : 'border-slate-300 text-slate-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700'
          } disabled:cursor-not-allowed disabled:opacity-50`}
          title="复制 Markdown 源码到剪贴板"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5" />
              已复制
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              复制 Markdown
            </>
          )}
        </button>
      </div>

      <div className="max-h-[560px] overflow-y-auto px-5 pb-5 pt-3">
        {tab === 'preview' ? (
          <article
            className="markdown-body"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <pre className="whitespace-pre-wrap rounded-xl bg-slate-900 p-4 font-mono text-xs leading-6 text-slate-100">
            {job.markdown}
          </pre>
        )}
      </div>
    </div>
  );
}
