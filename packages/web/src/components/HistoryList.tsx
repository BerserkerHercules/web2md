import {
  AlertCircle,
  CheckCircle2,
  Download,
  Eye,
  Loader2,
  RotateCw,
  Trash2,
} from 'lucide-react';
import { downloadUrl } from '../api';
import type { Job } from '../types';

interface Props {
  jobs: Job[];
  currentId?: string;
  onView: (id: string) => void;
  onDelete: (id: string) => void;
  onRetry: (job: Job) => void;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function StatusBadge({ status }: { status: Job['status'] }) {
  if (status === 'done') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
        <CheckCircle2 className="h-3.5 w-3.5" />
        成功
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-red-500">
        <AlertCircle className="h-3.5 w-3.5" />
        失败
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-indigo-500">
      <Loader2 className="h-3.5 w-3.5 animate-spin-slow" />
      进行中
    </span>
  );
}

export default function HistoryList({
  jobs,
  currentId,
  onView,
  onDelete,
  onRetry,
}: Props) {
  if (jobs.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 p-8 text-center text-sm text-slate-400">
        暂无转换记录，输入网址开始第一次转换吧
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-3.5">
        <h3 className="text-sm font-semibold text-slate-800">
          转换历史
          <span className="ml-2 text-xs font-normal text-slate-400">
            （最近 {jobs.length} 条）
          </span>
        </h3>
      </div>
      <ul className="divide-y divide-slate-100">
        {jobs.map((job) => (
          <li
            key={job.id}
            className={`flex flex-wrap items-center gap-3 px-5 py-3.5 ${
              job.id === currentId ? 'bg-indigo-50/50' : ''
            }`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <StatusBadge status={job.status} />
                <span className="truncate text-sm font-medium text-slate-800">
                  {job.title === job.url ? (
                    <span className="text-slate-500">{job.url}</span>
                  ) : (
                    job.title
                  )}
                </span>
              </div>
              <p className="mt-0.5 truncate text-xs text-slate-400">{job.url}</p>
              {job.error && (
                <p className="mt-0.5 truncate text-xs text-red-400">{job.error}</p>
              )}
            </div>
            <div className="hidden shrink-0 text-xs text-slate-400 sm:block">
              {formatTime(job.createdAt)}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {job.status === 'done' && (
                <>
                  <button
                    onClick={() => onView(job.id)}
                    title="查看结果"
                    className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-indigo-600"
                  >
                    <Eye className="h-4 w-4" />
                  </button>
                  <a
                    href={downloadUrl(job.id)}
                    title="下载 ZIP"
                    className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-indigo-600"
                  >
                    <Download className="h-4 w-4" />
                  </a>
                </>
              )}
              {job.status === 'failed' && (
                <button
                  onClick={() => onRetry(job)}
                  title="重试"
                  className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-indigo-600"
                >
                  <RotateCw className="h-4 w-4" />
                </button>
              )}
              <button
                onClick={() => onDelete(job.id)}
                title="删除记录"
                className="rounded-lg p-2 text-slate-400 transition hover:bg-red-50 hover:text-red-500"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
