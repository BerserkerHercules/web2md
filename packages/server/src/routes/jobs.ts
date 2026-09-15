import { createReadStream, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { store } from '../store';
import type { Job } from '../types';

/** 列表接口不回传 Markdown 全文；详情接口带 markdown 供预览 */
function toSummary(job: Job, withMarkdown = false): Job | Omit<Job, 'markdown'> {
  if (withMarkdown) return job;
  const { markdown: _markdown, ...rest } = job;
  return rest;
}

function contentDisposition(filename: string): string {
  return `attachment; filename="download${filename.endsWith('.zip') ? '.zip' : '.md'}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export default async function jobRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/jobs', async () => {
    return { jobs: store.list().map((j) => toSummary(j)) };
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const job = store.get(req.params.id);
    if (!job) return reply.code(404).send({ error: '任务不存在' });
    return toSummary(job, true);
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id/events', (req, reply) => {
    const job = store.get(req.params.id);
    if (!job) {
      return reply.code(404).send({ error: '任务不存在' });
    }
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: unknown): void => {
      raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = store.subscribe(req.params.id, send);
    const ping = setInterval(() => raw.write(': ping\n\n'), 15_000);
    const cleanup = (): void => {
      clearInterval(ping);
      unsubscribe();
      raw.end();
    };
    raw.on('close', cleanup);
    raw.on('error', cleanup);
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id/download', (req, reply) => {
    const job = store.get(req.params.id);
    if (!job || !job.zipName) {
      return reply.code(404).send({ error: '产物不存在或任务尚未完成' });
    }
    const filePath = join(store.artifactDir(job.id), job.zipName);
    if (!existsSync(filePath)) {
      return reply.code(404).send({ error: 'ZIP 文件已被删除' });
    }
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', contentDisposition(job.zipName));
    return reply.send(createReadStream(filePath));
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id/markdown', (req, reply) => {
    const job = store.get(req.params.id);
    if (!job || !job.markdownName) {
      return reply.code(404).send({ error: '产物不存在或任务尚未完成' });
    }
    const filePath = join(store.artifactDir(job.id), job.markdownName);
    if (!existsSync(filePath)) {
      return reply.code(404).send({ error: 'Markdown 文件已被删除' });
    }
    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    reply.header('Content-Disposition', contentDisposition(job.markdownName));
    return reply.send(createReadStream(filePath));
  });

  app.delete<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const job = store.get(req.params.id);
    if (!job) return reply.code(404).send({ error: '任务不存在' });
    store.remove(req.params.id);
    await rm(store.artifactDir(req.params.id), { recursive: true, force: true }).catch(() => {});
    return { ok: true };
  });
}
