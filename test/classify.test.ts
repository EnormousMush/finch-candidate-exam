import { describe, expect, it } from 'vitest';
import { classifyResponse } from '../server/external/digitalGoods.js';

const ok = { requestId: 'ord_1', productId: 'ebook', status: 'delivered', code: 'DEMO-1' };
const HOUR = 3_600_000;

describe('外部 API 响应分类', () => {
  it.each([
    ['200 正常', 'create', 200, ok, null, { kind: 'delivered', code: 'DEMO-1' }],
    ['200 但不是这笔订单', 'create', 200, { ...ok, requestId: 'other' }, null, { kind: 'unknown', reason: 'BAD_RESPONSE', maybeIssued: true }],
    ['200 但不是这件商品', 'get', 200, { ...ok, productId: 'theme' }, null, { kind: 'unknown', reason: 'BAD_RESPONSE', maybeIssued: true }],
    ['200 但没有码', 'create', 200, { ...ok, code: undefined }, null, { kind: 'unknown', reason: 'BAD_RESPONSE', maybeIssued: true }],
    ['400 参数错误 → 确定没发码', 'create', 400, undefined, null, { kind: 'rejected', reason: 'INVALID_REQUEST_400' }],
    ['413 请求体过大 → 确定没发码', 'create', 413, undefined, null, { kind: 'rejected', reason: 'INVALID_REQUEST_413' }],
    ['422 商品不可用 → 确定没发码', 'create', 422, undefined, null, { kind: 'rejected', reason: 'PRODUCT_UNAVAILABLE' }],
    ['409 编号冲突 → 外部已有记录，不能退款', 'create', 409, undefined, null, { kind: 'unknown', reason: 'CONFLICT_409', maybeIssued: true }],
    ['401 Key 失效 → 挂起，且确定没发码', 'create', 401, undefined, null, { kind: 'unknown', reason: 'UNAUTHORIZED', maybeIssued: false }],
    ['429 带 Retry-After', 'create', 429, undefined, '7', { kind: 'unknown', reason: 'RATE_LIMITED', retryAfterMs: 7000, maybeIssued: false }],
    ['429 超大 Retry-After 限制在 1 小时内', 'create', 429, undefined, '1e23', { kind: 'unknown', reason: 'RATE_LIMITED', retryAfterMs: HOUR, maybeIssued: false }],
    ['429 Retry-After 不可解析', 'create', 429, undefined, 'soon', { kind: 'unknown', reason: 'RATE_LIMITED', retryAfterMs: undefined, maybeIssued: false }],
    ['500', 'create', 500, undefined, null, { kind: 'unknown', reason: 'HTTP_500', maybeIssued: true }],
    ['503', 'create', 503, undefined, null, { kind: 'unknown', reason: 'HTTP_503', maybeIssued: true }],
    ['POST 返回 404 也视为未知', 'create', 404, undefined, null, { kind: 'unknown', reason: 'HTTP_404', maybeIssued: true }],
    ['GET 404 → 外部确实没有', 'get', 404, undefined, null, { kind: 'not_found' }],
    ['GET 422 不会被当成拒绝', 'get', 422, undefined, null, { kind: 'unknown', reason: 'HTTP_422', maybeIssued: true }],
  ] as const)('%s', (_name, mode, status, body, retryAfter, expected) => {
    expect(classifyResponse(mode, 'ord_1', 'ebook', status, body, retryAfter)).toEqual(expected);
  });
});
