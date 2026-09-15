import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, FileDown, Settings as SettingsIcon } from 'lucide-react';
import { api, downloadUrl, eventsUrl } from './api';
import HistoryList from './components/HistoryList';
import ProgressPanel from './components/ProgressPanel';
import ResultCard from './components/ResultCard';
import SettingsModal from './components/SettingsModal';
import UrlForm from './components/UrlForm';
import type {
  AppSettings,
  ConvertOptions,
  Job,
  JobEvent,
  StageName,
  StageStatus,
} from './types';

interface ActiveJob {
  id: string;
  url: string;
  status: 'running' | 'failed';
  stages: Partial<Record<StageName, StageStatus>>;
  events: JobEvent[];
  error?: string;
}

export default function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [active, setActive] = useState<ActiveJob | null>(null);
  const [result, setResult] = useState<Job | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [formError, setFormError] = useState('');
  const esRef = useRef<EventSource | null>(null);
  const autoDownloadId = useRef<string | null>(null);

  const refreshJobs = useCallback(async () => {
    try {
      const res = await api.listJobs();
      setJobs(res.jobs);
    } catch {
      /* 历史加载失败静默处理 */
    }
  }, []);

  useEffect(() => {
    void api
      .getSettings()
      .then((res) => setSettings(res.settings))
      .catch(() => setFormError('无法连接后端服务，请确认服务已启动'));
    void refreshJobs();
  }, [refreshJobs]);

  useEffect(() => {
    return () => esRef.current?.close();
  }, []);

  const startConversion = useCallback(
    async (url: string, options: ConvertOptions) => {
      setFormError('');
      setResult(null);
      try {
        const { jobId } = await api.convert(url, options);
        autoDownloadId.current = jobId;
        setActive({
          id: jobId,
          url,
          status: 'running',
          stages: {},
          events: [],
        });

        esRef.current?.close();
        const es = new EventSource(eventsUrl(jobId));
        esRef.current = es;

        es.onmessage = (ev) => {
          const event = JSON.parse(ev.data) as JobEvent;
          setActive((prev) => {
            if (!prev || prev.id !== jobId) return prev;
            const next: ActiveJob = {
              ...prev,
              events: [...prev.events, event],
            };
            if (event.type === 'stage' && event.stage && event.status) {
              next.stages = {
                ...prev.stages,
                [event.stage]: event.status,
              };
            }
            if (event.type === 'error') {
              next.status = 'failed';
              next.error = event.message;
            }
            return next;
          });

          if (event.type === 'done' || event.type === 'error') {
            es.close();
            void refreshJobs();
            api
              .getJob(jobId)
              .then((job) => {
                if (job.status === 'done') {
                  setResult(job);
                  setActive(null);
                  // 转换完成自动下载 ZIP
                  if (autoDownloadId.current === jobId) {
                    const a = document.createElement('a');
                    a.href = downloadUrl(jobId);
                    a.download = job.zipName ?? 'markdown.zip';
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                  }
                }
              })
              .catch(() => {});
            autoDownloadId.current = null;
          }
        };
        es.onerror = () => {
          // 浏览器会自动重连；任务结束由 done/error 关闭连接
        };
      } catch (err) {
        setFormError((err as Error).message);
        setActive(null);
      }
    },
    [refreshJobs],
  );

  const handleView = useCallback(async (id: string) => {
    try {
      const job = await api.getJob(id);
      autoDownloadId.current = null;
      setResult(job);
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    } catch (err) {
      setFormError((err as Error).message);
    }
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      await api.deleteJob(id).catch(() => {});
      if (result?.id === id) setResult(null);
      if (active?.id === id) {
        esRef.current?.close();
        setActive(null);
      }
      void refreshJobs();
    },
    [active?.id, result?.id, refreshJobs],
  );

  const llmConfigured = Boolean(settings?.llm.enabled && settings.llm.apiKey);

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600 text-lg font-bold text-white shadow-sm">
              M↓
            </div>
            <div>
              <h1 className="text-lg font-bold text-slate-900">
                网页转 Markdown 工具
              </h1>
              <p className="text-xs text-slate-400">
                DOM 智能提取 · 截图 OCR · 大模型排版优化
              </p>
            </div>
          </div>
          <button
            onClick={() => setSettingsOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 px-3.5 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
          >
            <SettingsIcon className="h-4 w-4" />
            接口配置
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-5 px-4 py-6 sm:px-6">
        <UrlForm
          running={active?.status === 'running'}
          llmConfigured={llmConfigured}
          onConvert={startConversion}
        />

        {formError && (
          <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            {formError}
          </div>
        )}

        {active && (
          <>
            <ProgressPanel stages={active.stages} events={active.events} />
            {active.status === 'failed' && (
              <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-medium">转换失败</p>
                  <p className="mt-0.5 text-red-500">{active.error}</p>
                </div>
              </div>
            )}
          </>
        )}

        {result && (
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-xs text-slate-400">
              <FileDown className="h-3.5 w-3.5" />
              完成后已自动下载 ZIP；若浏览器拦截了下载，可点击卡片中的按钮重新下载
            </div>
            <ResultCard job={result} />
          </div>
        )}

        <HistoryList
          jobs={jobs}
          currentId={active?.id}
          onView={handleView}
          onDelete={handleDelete}
          onRetry={(job) => void startConversion(job.url, job.options)}
        />
      </main>

      <footer className="pb-8 pt-2 text-center text-xs text-slate-400">
        本地运行 · API Key 仅保存在本机 data/settings.json
      </footer>

      <SettingsModal
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onSaved={(s) => {
          setSettings(s);
          void refreshJobs();
        }}
      />
    </div>
  );
}
