import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * 本地假的数字商品 API，行为与真实 API 文档一致（同 requestId 幂等、409、404……），
 * 另外可以按请求注入故障。测试和 `pnpm dev:fake` 共用它，避免消耗真实 API 的额度。
 */

export interface RequestInfo {
  method: 'POST' | 'GET';
  requestId: string;
  productId?: string;
  /** 该 requestId 第几次被请求（从 1 开始） */
  nth: number;
}

export interface Plan {
  delayMs?: number;
  /** 是否真的生成/保留兑换码。默认 true；设为 false 表示「请求在生成码之前就失败了」 */
  commit?: boolean;
  /** 最终返回的状态码，默认 200。commit=true 且 status≠200 表示「码已生成但响应丢了」 */
  status?: number;
  retryAfter?: string;
  /** 返回一个格式不对的 200 */
  malformed?: boolean;
}

export type Behavior = (req: RequestInfo) => Plan | undefined;

const ERROR_CODES: Record<number, string> = {
  400: 'INVALID_REQUEST', 401: 'UNAUTHORIZED', 404: 'NOT_FOUND', 409: 'INVALID_REQUEST',
  413: 'INVALID_REQUEST', 422: 'PRODUCT_UNAVAILABLE', 429: 'RATE_LIMITED', 500: 'SERVER_ERROR', 503: 'SERVER_ERROR',
};

export interface FakeGoods {
  url: string;
  apiKey: string;
  /** 已生成的兑换码（requestId → 记录）；测试用它断言「不重复发码、不丢码」 */
  deliveries: Map<string, { productId: string; code: string; createdAt: string }>;
  requests: RequestInfo[];
  setBehavior(b: Behavior): void;
  close(): Promise<void>;
}

export async function startFakeGoods(opts: { port?: number; apiKey?: string; behavior?: Behavior } = {}): Promise<FakeGoods> {
  const apiKey = opts.apiKey ?? 'test-key';
  let behavior: Behavior = opts.behavior ?? (() => undefined);
  const deliveries: FakeGoods['deliveries'] = new Map();
  const requests: RequestInfo[] = [];
  const counts = new Map<string, number>();
  let seq = 0;

  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    const fail = (status: number, headers?: Record<string, string>) =>
      send(status, { error: { code: ERROR_CODES[status] ?? 'SERVER_ERROR', message: `fake ${status}` } }, headers);

    try {
      if (req.headers.authorization !== `Bearer ${apiKey}`) return fail(401);
      const url = new URL(req.url ?? '/', 'http://x');
      let info: RequestInfo;
      if (req.method === 'POST' && url.pathname === '/api/v1/deliveries') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw || '{}') as { requestId?: string; productId?: string };
        if (!body.requestId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(body.requestId) || !body.productId) return fail(400);
        info = { method: 'POST', requestId: body.requestId, productId: body.productId, nth: 0 };
      } else if (req.method === 'GET' && url.pathname.startsWith('/api/v1/deliveries/')) {
        info = { method: 'GET', requestId: decodeURIComponent(url.pathname.split('/').pop()!), nth: 0 };
      } else {
        return fail(404);
      }
      info.nth = (counts.get(info.requestId) ?? 0) + 1;
      counts.set(info.requestId, info.nth);
      requests.push(info);

      const plan = { commit: true, status: 200, ...behavior(info) };
      if (plan.delayMs) await new Promise((r) => setTimeout(r, plan.delayMs));

      const existing = deliveries.get(info.requestId);
      if (info.method === 'POST') {
        if (existing && existing.productId !== info.productId) return fail(409);
        if (plan.commit && !existing) {
          deliveries.set(info.requestId, {
            productId: info.productId!,
            code: `FAKE-${(++seq).toString().padStart(4, '0')}-${info.requestId.slice(-4).toUpperCase()}`,
            createdAt: new Date().toISOString(),
          });
        }
      }
      if (plan.status !== 200) return fail(plan.status, plan.retryAfter ? { 'Retry-After': plan.retryAfter } : {});
      if (plan.malformed) return send(200, { ok: true });

      const record = deliveries.get(info.requestId);
      if (!record) return fail(404);
      return send(200, { requestId: info.requestId, status: 'delivered', ...record });
    } catch {
      if (!res.headersSent) fail(500);
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    apiKey,
    deliveries,
    requests,
    setBehavior: (b) => { behavior = b; },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
