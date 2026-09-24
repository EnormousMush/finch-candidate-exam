import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { createDb } from './db/pool.js';
import { createDigitalGoodsClient } from './external/digitalGoods.js';
import { buildApp } from './app.js';
import { startWorker } from './services/orders.js';

const db = createDb(config.databaseUrl());
const goods = createDigitalGoodsClient(config.goodsBaseUrl(), config.goodsApiKey());
const app = await buildApp({ db, goods, cookieSecure: config.cookieSecure, logger: true });

// 生产模式下由同一个进程托管前端构建产物
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '../web/dist');
if (process.env.NODE_ENV === 'production') {
  if (!existsSync(dist)) throw new Error('未找到 web/dist，请先执行 pnpm build');
  await app.register(fastifyStatic, { root: dist });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api/') ? reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } }) : reply.sendFile('index.html'),
  );
}

const stopWorker = startWorker({ db, goods }, 3_000, (e) => app.log.error(e));
app.log.info(`外部 API: ${config.goodsBaseUrl()}`);
if (config.goodsApiKey() === 'dg_xxx') {
  app.log.warn('DIGITAL_GOODS_API_KEY 仍是示例值，外部商品的兑换会一直处于「处理中」；没有 Key 时可用 pnpm dev:fake');
}
await app.listen({ port: config.port, host: '0.0.0.0' });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await stopWorker();
    await app.close();
    await db.end();
    process.exit(0);
  });
}
