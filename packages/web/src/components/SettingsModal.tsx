import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, PlugZap, X } from 'lucide-react';
import { api } from '../api';
import type { AppSettings, LlmProvider, OcrProvider } from '../types';

interface Props {
  open: boolean;
  settings: AppSettings | null;
  onClose: () => void;
  onSaved: (settings: AppSettings) => void;
}

type TestState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok' }
  | { kind: 'error'; message: string };

const inputCls =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100';

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <div>
        <span className="text-sm font-medium text-slate-800">{label}</span>
        {hint && <p className="mt-0.5 text-xs text-slate-400">{hint}</p>}
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition ${
          checked ? 'bg-indigo-600' : 'bg-slate-300'
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
            checked ? 'left-[22px]' : 'left-0.5'
          }`}
        />
      </button>
    </label>
  );
}

function TestButton({
  state,
  onClick,
}: {
  state: TestState;
  onClick: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={state.kind === 'running'}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
      >
        {state.kind === 'running' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin-slow" />
        ) : (
          <PlugZap className="h-3.5 w-3.5" />
        )}
        测试连接
      </button>
      {state.kind === 'ok' && (
        <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
          <CheckCircle2 className="h-3.5 w-3.5" />
          连接正常
        </span>
      )}
      {state.kind === 'error' && (
        <span className="text-xs text-red-500">{state.message}</span>
      )}
    </div>
  );
}

export default function SettingsModal({
  open,
  settings,
  onClose,
  onSaved,
}: Props) {
  const [draft, setDraft] = useState<AppSettings | null>(settings);
  const [saving, setSaving] = useState(false);
  const [savedTip, setSavedTip] = useState(false);
  const [ocrTest, setOcrTest] = useState<TestState>({ kind: 'idle' });
  const [llmTest, setLlmTest] = useState<TestState>({ kind: 'idle' });

  useEffect(() => {
    setDraft(settings);
    setOcrTest({ kind: 'idle' });
    setLlmTest({ kind: 'idle' });
    setSavedTip(false);
  }, [settings, open]);

  if (!open || !draft) return null;

  const patchOcr = (p: Partial<AppSettings['ocr']>) =>
    setDraft({ ...draft, ocr: { ...draft.ocr, ...p } });
  const patchLlm = (p: Partial<AppSettings['llm']>) =>
    setDraft({ ...draft, llm: { ...draft.llm, ...p } });

  const selectProvider = (provider: LlmProvider) => {
    if (provider === 'zhipu') {
      patchLlm({
        provider,
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        model: 'glm-5.3',
      });
    } else if (provider === 'deepseek') {
      patchLlm({
        provider,
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-pro',
      });
    } else {
      patchLlm({ provider, baseUrl: '', model: '' });
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.saveSettings(draft);
      onSaved(res.settings);
      setSavedTip(true);
      setTimeout(onClose, 600);
    } catch (err) {
      alert(`保存失败：${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const runTest = async (kind: 'ocr' | 'llm') => {
    const setter = kind === 'ocr' ? setOcrTest : setLlmTest;
    setter({ kind: 'running' });
    try {
      if (kind === 'ocr') await api.testOcr(draft);
      else await api.testLlm(draft);
      setter({ kind: 'ok' });
    } catch (err) {
      setter({ kind: 'error', message: (err as Error).message });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:p-10">
      <div className="w-full max-w-2xl rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
          <h2 className="text-base font-semibold text-slate-900">
            接口配置
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-6 overflow-y-auto px-6 py-5">
          {/* Paddle OCR */}
          <section className="space-y-3 rounded-xl border border-slate-200 p-4">
            <Toggle
              checked={draft.ocr.enabled}
              onChange={(v) => patchOcr({ enabled: v })}
              label="启用 PaddleOCR-VL 截图识别"
              hint="DOM 提取失败或强制 OCR 时，对页面截图提交 AIStudio 异步识别任务，直接返回排版后的 Markdown"
            />
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">
                服务类型
              </label>
              <select
                value={draft.ocr.provider}
                onChange={(e) =>
                  patchOcr({ provider: e.target.value as OcrProvider })
                }
                className={inputCls}
              >
                <option value="aistudio">AIStudio PaddleOCR-VL 官方云服务（异步 Jobs API）</option>
                <option value="custom">自建 PaddleOCR HTTP 服务</option>
              </select>
            </div>
            {draft.ocr.provider === 'aistudio' ? (
              <>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-500">
                    Token（Bearer）
                  </label>
                  <input
                    type="password"
                    value={draft.ocr.token}
                    onChange={(e) => patchOcr({ token: e.target.value })}
                    placeholder="AIStudio PaddleOCR-VL 服务的访问 Token"
                    className={inputCls}
                  />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-500">
                      模型名称
                    </label>
                    <input
                      type="text"
                      value={draft.ocr.model}
                      onChange={(e) => patchOcr({ model: e.target.value })}
                      placeholder="PaddleOCR-VL-1.6"
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-500">
                      Jobs API 地址
                    </label>
                    <input
                      type="url"
                      value={draft.ocr.endpoint}
                      onChange={(e) => patchOcr({ endpoint: e.target.value })}
                      placeholder="https://paddleocr.aistudio-app.com/api/v2/ocr/jobs"
                      className={inputCls}
                    />
                  </div>
                </div>
                <div className="space-y-1.5 rounded-lg bg-slate-50 p-3">
                  <span className="text-xs font-medium text-slate-500">识别选项（optionalPayload）</span>
                  {([
                    ['useDocOrientationClassify', '文档方向分类'],
                    ['useDocUnwarping', '文档扭曲矫正'],
                    ['useChartRecognition', '图表识别'],
                  ] as const).map(([key, label]) => (
                    <label key={key} className="flex cursor-pointer items-center gap-2 text-xs text-slate-600">
                      <input
                        type="checkbox"
                        checked={draft.ocr[key]}
                        onChange={(e) => patchOcr({ [key]: e.target.checked })}
                        className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-400"
                      />
                      {label}
                    </label>
                  ))}
                </div>
                <p className="text-xs text-slate-400">
                  Token 仅保存在本机 data/settings.json，不会上传到任何第三方。
                </p>
              </>
            ) : (
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-500">
                  服务地址（Endpoint）
                </label>
                <input
                  type="url"
                  value={draft.ocr.endpoint}
                  onChange={(e) => patchOcr({ endpoint: e.target.value })}
                  placeholder="http://127.0.0.1:8866/predict/ocr_system"
                  className={inputCls}
                />
                <p className="mt-1 text-xs text-slate-400">
                  约定 POST 图片二进制，返回 {'{ "text": "识别结果" }'}。
                </p>
              </div>
            )}
            <TestButton state={ocrTest} onClick={() => runTest('ocr')} />
          </section>

          {/* LLM */}
          <section className="space-y-3 rounded-xl border border-slate-200 p-4">
            <Toggle
              checked={draft.llm.enabled}
              onChange={(v) => patchLlm({ enabled: v })}
              label="启用大模型智能排版"
              hint="去广告去重、语义重组、标题层级修正；失败时自动回退规则化结果"
            />
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">
                模型提供方
              </label>
              <select
                value={draft.llm.provider}
                onChange={(e) => selectProvider(e.target.value as LlmProvider)}
                className={inputCls}
              >
                <option value="zhipu">智谱 GLM（GLM-5.3）</option>
                <option value="deepseek">DeepSeek（DeepSeek-V4-Pro）</option>
                <option value="custom">自定义 OpenAI 兼容接口</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">
                API Key
              </label>
              <input
                type="password"
                value={draft.llm.apiKey}
                onChange={(e) => patchLlm({ apiKey: e.target.value })}
                placeholder="sk-..."
                className={inputCls}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-500">
                  Base URL
                </label>
                <input
                  type="url"
                  value={draft.llm.baseUrl}
                  onChange={(e) => patchLlm({ baseUrl: e.target.value })}
                  placeholder="https://api.example.com/v1"
                  className={inputCls}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-500">
                  模型名称
                </label>
                <input
                  type="text"
                  value={draft.llm.model}
                  onChange={(e) => patchLlm({ model: e.target.value })}
                  placeholder="glm-5.3"
                  className={inputCls}
                />
              </div>
            </div>
            <TestButton state={llmTest} onClick={() => runTest('llm')} />
          </section>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-slate-100 px-6 py-4">
          {savedTip && (
            <span className="text-xs text-emerald-600">已保存</span>
          )}
          <button
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
          >
            取消
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-60"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin-slow" />}
            保存配置
          </button>
        </div>
      </div>
    </div>
  );
}
