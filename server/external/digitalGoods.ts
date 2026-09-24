/**
 * 外部数字商品 API 客户端。
 *
 * 这一层唯一的职责：把 HTTP 世界的各种情况（200/4xx/5xx/超时/断网/奇怪的响应体）
 * 归类成业务层能直接决策的四种结果。最关键的区分是：
 *   - rejected：外部明确「没发码」→ 业务层可以放心退款
 *   - unknown ：不知道发没发（超时、5xx、限流……）→ 绝不能退款，只能稍后用同一个 requestId 重试
 */

export type DeliveryResult =
  | { kind: 'delivered'; code: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'not_found' }
  | {
      kind: 'unknown';
      reason: string;
      retryAfterMs?: number;
      /** 外部有没有可能已经生成了码。401/429 在鉴权或限流阶段就被拒，为 false；超时、5xx 等为 true。 */
      maybeIssued: boolean;
    };

export interface DigitalGoodsClient {
  /** POST /deliveries：同一 requestId 重复调用会返回同一个码，不会重复发。 */
  createDelivery(requestId: string, productId: string, timeoutMs: number): Promise<DeliveryResult>;
  /** GET /deliveries/:id：只用于确认「外部到底有没有这笔」。productId 用于校验返回的是同一件商品。 */
  getDelivery(requestId: string, productId: string, timeoutMs: number): Promise<DeliveryResult>;
}

export function createDigitalGoodsClient(baseUrl: string, apiKey: string): DigitalGoodsClient {
  const root = baseUrl.replace(/\/+$/, '') + '/api/v1';

  async function call(
    mode: 'create' | 'get',
    requestId: string,
    productId: string,
    init: RequestInit,
    url: string,
    timeoutMs: number,
  ): Promise<DeliveryResult> {
    let res: Response;
    let body: unknown;
    try {
      res = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      body = await res.json().catch(() => undefined);
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      // 请求可能已经到达对方并生成了码，只是响应没有回来
      return { kind: 'unknown', reason: isTimeout ? 'TIMEOUT' : 'NETWORK', maybeIssued: true };
    }
    return classifyResponse(mode, requestId, productId, res.status, body, res.headers.get('retry-after'));
  }

  return {
    createDelivery(requestId, productId, timeoutMs) {
      return call('create', requestId, productId, {
        method: 'POST',
        body: JSON.stringify({ requestId, productId }),
      }, `${root}/deliveries`, timeoutMs);
    },
    getDelivery(requestId, productId, timeoutMs) {
      return call('get', requestId, productId, { method: 'GET' },
        `${root}/deliveries/${encodeURIComponent(requestId)}`, timeoutMs);
    },
  };
}

/** 纯函数，单独导出便于单元测试。 */
export function classifyResponse(
  mode: 'create' | 'get',
  requestId: string,
  productId: string,
  status: number,
  body: unknown,
  retryAfterHeader: string | null,
): DeliveryResult {
  if (status === 200) {
    const b = body as { requestId?: unknown; productId?: unknown; status?: unknown; code?: unknown } | undefined;
    // 200 但内容对不上（不是这笔、不是这件商品、没有码）：不能当成功，也不能当失败
    if (b && b.requestId === requestId && b.productId === productId && b.status === 'delivered'
      && typeof b.code === 'string' && b.code) {
      return { kind: 'delivered', code: b.code };
    }
    return { kind: 'unknown', reason: 'BAD_RESPONSE', maybeIssued: true };
  }
  if (status === 404 && mode === 'get') return { kind: 'not_found' };

  if (mode === 'create') {
    // 参数不合法 / 请求体过大：请求在校验阶段就被拒，确定没有生成码
    if (status === 400 || status === 413) return { kind: 'rejected', reason: `INVALID_REQUEST_${status}` };
    // 商品不可用：文档明确「本次未生成兑换码」
    if (status === 422) return { kind: 'rejected', reason: 'PRODUCT_UNAVAILABLE' };
    // 409 = 该 requestId 已存在且商品不同，意味着外部「有」一笔记录，不能当作没发码去退款
    if (status === 409) return { kind: 'unknown', reason: 'CONFLICT_409', maybeIssued: true };
  }
  // 401 / 429 在鉴权或限流阶段就被拒，确定没生成码；但它们是暂时的，等恢复后重试即可
  if (status === 401) return { kind: 'unknown', reason: 'UNAUTHORIZED', maybeIssued: false };
  if (status === 429) {
    return { kind: 'unknown', reason: 'RATE_LIMITED', retryAfterMs: parseRetryAfter(retryAfterHeader), maybeIssued: false };
  }
  return { kind: 'unknown', reason: `HTTP_${status}`, maybeIssued: true };
}

const MAX_RETRY_AFTER_MS = 60 * 60_000;

/** Retry-After 可能是秒数或 HTTP 日期；限制在 1 小时内，防止异常值把订单卡住或让 SQL 报错。 */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  let ms: number;
  if (Number.isFinite(seconds) && seconds >= 0) ms = seconds * 1000;
  else {
    const date = Date.parse(header);
    if (Number.isNaN(date)) return undefined;
    ms = date - Date.now();
  }
  return Math.min(Math.max(0, Math.round(ms)), MAX_RETRY_AFTER_MS);
}
