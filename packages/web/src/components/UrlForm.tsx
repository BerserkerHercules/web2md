import { useState } from 'react';
import { ArrowRight, Loader2, Sparkles, Wand2 } from 'lucide-react';
import type { ConvertOptions } from '../types';

interface Props {
  running: boolean;
  llmConfigured: boolean;
  onConvert: (url: string, options: ConvertOptions) => void;
}

export default function UrlForm({ running, llmConfigured, onConvert }: Props) {
  const [url, setUrl] = useState('');
  const [useLlm, setUseLlm] = useState(false);
  const [ocrMode, setOcrMode] = useState<ConvertOptions['ocrMode']>('auto');
  const [includeSource, setIncludeSource] = useState(true);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed || running) return;
    onConvert(trimmed, { useLlm, ocrMode, includeSource });
  };

  return (
    <form
      onSubmit={submit}
      className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <label className="mb-2 block text-sm font-medium text-slate-700">
        目标网页地址
      </label>
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/article"
          className="flex-1 rounded-xl border border-slate-300 px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          disabled={running}
        />
        <button
          type="submit"
          disabled={running || !url.trim()}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {running ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin-slow" />
              转换中…
            </>
          ) : (
            <>
              开始转换
              <ArrowRight className="h-4 w-4" />
            </>
          )}
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2.5 text-sm text-slate-600">
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={useLlm}
            onChange={(e) => setUseLlm(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-400"
          />
          <Sparkles className="h-4 w-4 text-indigo-500" />
          大模型智能排版
          {!llmConfigured && (
            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-600">
              需先配置
            </span>
          )}
        </label>

        <label className="inline-flex cursor-pointer items-center gap-2">
          <Wand2 className="h-4 w-4 text-indigo-500" />
          截图 OCR：
          <select
            value={ocrMode}
            onChange={(e) =>
              setOcrMode(e.target.value as ConvertOptions['ocrMode'])
            }
            className="rounded-lg border border-slate-300 px-2 py-1 text-xs outline-none focus:border-indigo-400"
          >
            <option value="auto">自动（提取失败时触发）</option>
            <option value="force">强制整页 OCR</option>
            <option value="off">关闭</option>
          </select>
        </label>

        <label className="inline-flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={includeSource}
            onChange={(e) => setIncludeSource(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-400"
          />
          附带来源链接
        </label>
      </div>
    </form>
  );
}
