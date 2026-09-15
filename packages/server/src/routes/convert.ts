import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { runConversion } from '../services/pipeline';
import { store } from '../store';
import type { ConvertOptions, Job } from '../types';

interface ConvertBody {
  url?: string;
  useLlm?: boolean;
  ocrMode?: ConvertOptions['ocrMode'];
  includeSource?: boolean;
}

export default async function convertRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: ConvertBody }>('/api/convert', async (req, reply) => {
    const body = req.body ?? {};
    const url = (body.url ?? '').trim();
    if (!url) {
      return reply.code(400).send({ error: '请输入要转换的网址' });
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return reply.code(400).send({ error: '仅支持 http / https 协议的网址' });
      }
    } catch {
      return reply.code(400).send({ error: '网址格式不正确' });
    }

    const ocrMode: ConvertOptions['ocrMode'] =
      body.ocrMode === 'force' || body.ocrMode === 'off' ? body.ocrMode : 'auto';
    const options: ConvertOptions = {
      useLlm: Boolean(body.useLlm),
      ocrMode,
      includeSource: body.includeSource !== false,
    };

    const now = Date.now();
    const job: Job = {
      id: randomUUID().slice(0, 8) + now.toString(36).slice(-4),
      url,
      title: url,
      options,
      status: 'pending',
      events: [],
      stages: {},
      createdAt: now,
      updatedAt: now,
    };
    store.create(job);

    // 异步执行，立即返回任务 ID，进度通过 SSE 推送
    setImmediate(() => {
      void runConversion(job.id);
    });

    return reply.code(202).send({ jobId: job.id });
  });
}
