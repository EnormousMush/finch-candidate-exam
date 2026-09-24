import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import type { Db } from './db/pool.js';
import type { DigitalGoodsClient } from './external/digitalGoods.js';
import { AppError } from './errors.js';
import * as auth from './services/auth.js';
import { getSummary, listLedger, listProducts } from './services/account.js';
import { completeTask, listTasks } from './services/tasks.js';
import { getOrder, listOrders, redeem } from './services/orders.js';

const COOKIE = 'sid';

declare module 'fastify' {
  interface FastifyRequest {
    user: auth.SessionUser;
  }
}

export interface AppOptions {
  db: Db;
  goods: DigitalGoodsClient;
  cookieSecure?: boolean;
  logger?: boolean;
}

export async function buildApp({ db, goods, cookieSecure = false, logger = false }: AppOptions) {
  const app = Fastify({ logger });
  await app.register(cookie);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    }
    const e = err as { validation?: unknown; statusCode?: number; message?: string };
    if (e.validation) {
      return reply.status(400).send({ error: { code: 'INVALID_REQUEST', message: e.message } });
    }
    // Fastify 自己产生的 4xx（JSON 解析失败、请求体过大等）原样返回，别当成 500 让前端误以为「可以重试」
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: 'INVALID_REQUEST', message: e.message } });
    }
    app.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: '服务器内部错误' } });
  });

  const setSession = async (reply: FastifyReply, userId: string) => {
    const { token, expiresAt } = await auth.createSession(db, userId);
    reply.setCookie(COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: cookieSecure, expires: expiresAt });
  };

  const requireUser = async (req: FastifyRequest) => {
    const token = req.cookies[COOKIE];
    const user = token ? await auth.findSessionUser(db, token) : null;
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');
    req.user = user;
  };

  const credentials = {
    body: {
      type: 'object',
      required: ['username', 'password'],
      properties: { username: { type: 'string' }, password: { type: 'string' } },
    },
  } as const;

  // ---------- 认证 ----------
  app.post<{ Body: { username: string; password: string } }>('/api/auth/register', { schema: credentials }, async (req, reply) => {
    const user = await auth.register(db, req.body.username.trim(), req.body.password);
    await setSession(reply, user.id);
    return { user };
  });

  app.post<{ Body: { username: string; password: string } }>('/api/auth/login', { schema: credentials }, async (req, reply) => {
    const user = await auth.login(db, req.body.username.trim(), req.body.password);
    await setSession(reply, user.id);
    return { user };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) await auth.deleteSession(db, token);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  // ---------- 以下都需要登录，数据一律按 req.user.id 过滤 ----------
  app.register(async (priv) => {
    priv.addHook('preHandler', requireUser);

    priv.get('/api/me', async (req) => ({ user: req.user, summary: await getSummary(db, req.user.id) }));

    priv.get('/api/ledger', async (req) => ({ entries: await listLedger(db, req.user.id) }));

    priv.get('/api/tasks', async (req) => ({ tasks: await listTasks(db, req.user.id) }));

    priv.post<{ Params: { id: string } }>('/api/tasks/:id/complete', async (req) => completeTask(db, req.user.id, req.params.id));

    priv.get('/api/products', async () => ({ products: await listProducts(db) }));

    priv.get('/api/orders', async (req) => ({ orders: await listOrders(db, req.user.id) }));

    priv.get<{ Params: { id: string } }>('/api/orders/:id', async (req) => {
      const order = await getOrder(db, req.user.id, req.params.id);
      if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
      return { order };
    });

    priv.post<{ Body: { productId: string; idempotencyKey: string } }>('/api/orders', {
      schema: {
        body: {
          type: 'object',
          required: ['productId', 'idempotencyKey'],
          properties: { productId: { type: 'string' }, idempotencyKey: { type: 'string' } },
        },
      },
    }, async (req) => {
      return { order: await redeem({ db, goods }, req.user.id, req.body.productId, req.body.idempotencyKey) };
    });
  });

  return app;
}
