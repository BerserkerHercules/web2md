import { Check, ChevronRight, Loader2, X } from 'lucide-react';
import type { JobEvent, StageName, StageStatus } from '../types';
import { STAGE_LABELS, STAGE_ORDER } from './stages';

interface Props {
  stages: Partial<Record<StageName, StageStatus>>;
  events: JobEvent[];
}

function StageIcon({ status }: { status: StageStatus | undefined }) {
  if (status === 'running') {
    return <Loader2 className="h-4 w-4 animate-spin-slow text-indigo-600" />;
  }
  if (status === 'done') {
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100">
        <Check className="h-3 w-3 text-emerald-600" />
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-red-100">
        <X className="h-3 w-3 text-red-600" />
      </span>
    );
  }
  if (status === 'skipped') {
    return <span className="h-5 w-5 rounded-full bg-slate-100" />;
  }
  return <span className="h-5 w-5 rounded-full border border-slate-200" />;
}

export default function ProgressPanel({ stages, events }: Props) {
  const logs = events.filter((e) => e.type === 'log').slice(-6);
  const stageMessages = new Map<StageName, string>();
  for (const e of events) {
    if (e.type === 'stage' && e.stage && e.message) {
      stageMessages.set(e.stage, e.message);
    }
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="mb-4 text-sm font-semibold text-slate-800">转换进度</h3>
      <ol className="space-y-2.5">
        {STAGE_ORDER.map((name) => {
          const status = stages[name];
          if (!status) return null;
          return (
            <li key={name} className="flex items-start gap-3">
              <div className="mt-0.5">
                <StageIcon status={status} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm">
                  <span
                    className={
                      status === 'skipped'
                        ? 'text-slate-400'
                        : status === 'failed'
                          ? 'font-medium text-red-600'
                          : status === 'running'
                            ? 'font-medium text-indigo-700'
                            : 'text-slate-700'
                    }
                  >
                    {STAGE_LABELS[name]}
                  </span>
                  {status === 'running' && (
                    <span className="text-xs text-indigo-400">进行中…</span>
                  )}
                  {status === 'skipped' && (
                    <span className="text-xs text-slate-400">跳过</span>
                  )}
                </div>
                {stageMessages.get(name) && status !== 'pending' && (
                  <p className="mt-0.5 truncate text-xs text-slate-500">
                    {stageMessages.get(name)}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {logs.length > 0 && (
        <div className="mt-4 rounded-xl bg-slate-50 p-3">
          <ul className="space-y-1 font-mono text-xs leading-5 text-slate-500">
            {logs.map((log, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-slate-400" />
                <span>{log.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
