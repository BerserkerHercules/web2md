import { existsSync } from 'node:fs';
import cors from '@fastify/cors';
import fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { ensureDirs, HOST, PORT, WEB_DIST } from './config';
import convertRoutes from './routes/convert';
import jobRoutes from './routes/jobs';
import settingsRoutes from './routes/settings';

async function main(): Promise<void> {
  ensureDirs();

  const app = fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cors, { origin: true });

  app.get('/api/health', async () => ({ ok: true, name: 'all-web-to-md', time: Date.now() }));
  await app.register(convertRoutes);
  await app.register(jobRoutes);
  await app.register(settingsRoutes);

  app.setErrorHandler((err, _req, reply) => {
    app.log.error(err);
    const e = err as Error & { statusCode?: number };
    const code = e.statusCode && e.statusCode >= 400 ? e.statusCode : 500;
    reply.code(code).send({ error: e.message || '服务内部错误' });
  });

  // 生产模式：直接托管前端构建产物
  if (existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, { root: WEB_DIST, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: '接口不存在' });
      }
      // 静态资源请求（/assets/*、.js/.css/.png 等）找不到直接返回 404，
      // 不能 fallback 到 index.html —— 否则浏览器会把 HTML 当 JS 执行崩掉
      if (/^\/assets\//.test(req.url) || /\.[a-z0-9]+$/i.test(req.url)) {
        return reply.code(404).send({ error: '静态资源不存在' });
      }
      return reply.sendFile('index.html');
    });
    app.log.info(`前端产物目录：${WEB_DIST}`);
  } else {
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: '接口不存在' });
      }
      reply.type('text/plain').send('all-web-to-md API 正在运行（开发模式请访问 Vite 前端端口）');
    });
  }

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`服务已启动：http://${HOST}:${PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
