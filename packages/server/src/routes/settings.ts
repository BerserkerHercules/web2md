import type { FastifyInstance } from 'fastify';
import { LLM_PRESETS, loadSettings, saveSettings } from '../config';
import { testConnection } from '../services/llm';
import { validateZhipuKey } from '../services/ocr';
import type { AppSettings, LlmProvider, OcrProvider } from '../types';

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
function asBoolean(v: unknown): boolean {
  return v === true;
}

function sanitizeSettings(input: unknown): AppSettings {
  const current = loadSettings();
  if (!input || typeof input !== 'object') return current;
  const body = input as Record<string, Record<string, unknown>>;
  const incomingOcr = body.ocr ?? {};
  const incomingLlm = body.llm ?? {};

  const ocrProvider: OcrProvider = incomingOcr.provider === 'custom' ? 'custom' : 'zhipu';
  const llmProvider: LlmProvider =
    incomingLlm.provider === 'deepseek' || incomingLlm.provider === 'custom'
      ? incomingLlm.provider
      : 'zhipu';

  return {
    ocr: {
      enabled: asBoolean(incomingOcr.enabled),
      provider: ocrProvider,
      token: asString(incomingOcr.token),
      model: asString(incomingOcr.model) || current.ocr.model,
      endpoint: asString(incomingOcr.endpoint) || current.ocr.endpoint,
    },
    llm: {
      enabled: asBoolean(incomingLlm.enabled),
      provider: llmProvider,
      apiKey: asString(incomingLlm.apiKey),
      baseUrl: asString(incomingLlm.baseUrl) || current.llm.baseUrl,
      model: asString(incomingLlm.model) || current.llm.model,
    },
  };
}

export default async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async () => {
    return { settings: loadSettings(), presets: LLM_PRESETS };
  });

  app.put('/api/settings', async (req, reply) => {
    const settings = sanitizeSettings(req.body);
    saveSettings(settings);
    return { ok: true, settings };
  });

  app.post('/api/settings/test-llm', async (req, reply) => {
    const settings = sanitizeSettings(req.body);
    try {
      await testConnection(settings.llm);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ ok: false, error: (err as Error).message });
    }
  });

  app.post('/api/settings/test-ocr', async (req, reply) => {
    const settings = sanitizeSettings(req.body);
    if (settings.ocr.provider === 'custom') {
      if (!settings.ocr.endpoint) {
        return reply.code(400).send({ ok: false, error: '请填写自建 OCR 服务地址' });
      }
      return { ok: true };
    }
    try {
      await validateZhipuKey(settings.ocr);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ ok: false, error: (err as Error).message });
    }
  });
}
