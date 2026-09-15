import type {
  AppSettings,
  ConvertOptions,
  Job,
  LlmPreset,
} from './types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.body != null) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    ...init,
    headers: { ...headers, ...init?.headers },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(data.error || `请求失败（HTTP ${res.status}）`);
  }
  return data as T;
}

export const api = {
  getSettings: () =>
    request<{ settings: AppSettings; presets: Record<string, LlmPreset> }>(
      '/api/settings',
    ),
  saveSettings: (settings: AppSettings) =>
    request<{ ok: true; settings: AppSettings }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  testLlm: (settings: AppSettings) =>
    request<{ ok: true }>('/api/settings/test-llm', {
      method: 'POST',
      body: JSON.stringify(settings),
    }),
  testOcr: (settings: AppSettings) =>
    request<{ ok: true }>('/api/settings/test-ocr', {
      method: 'POST',
      body: JSON.stringify(settings),
    }),
  convert: (url: string, options: ConvertOptions) =>
    request<{ jobId: string }>('/api/convert', {
      method: 'POST',
      body: JSON.stringify({ url, ...options }),
    }),
  listJobs: () => request<{ jobs: Job[] }>('/api/jobs'),
  getJob: (id: string) => request<Job>(`/api/jobs/${id}`),
  deleteJob: (id: string) =>
    request<{ ok: true }>(`/api/jobs/${id}`, { method: 'DELETE' }),
};

export const eventsUrl = (id: string): string => `/api/jobs/${id}/events`;
export const downloadUrl = (id: string): string => `/api/jobs/${id}/download`;
export const markdownUrl = (id: string): string => `/api/jobs/${id}/markdown`;
