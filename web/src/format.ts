import type { Order } from './api';

export const fmtNum = (n: number) => n.toLocaleString('zh-CN');

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const LAST_ERROR: Record<string, string> = {
  TIMEOUT: '外部服务响应超时',
  NETWORK: '暂时无法连接外部服务',
  RATE_LIMITED: '外部服务繁忙（限流）',
  UNAUTHORIZED: '外部服务暂不可用（鉴权失败）',
  BAD_RESPONSE: '外部服务返回了异常数据',
  CONFLICT_409: '订单编号冲突，等待核查',
};

const FAILURE: Record<string, string> = {
  PRODUCT_UNAVAILABLE: '商品暂不可用，未生成兑换码',
  INVALID_REQUEST_400: '请求被外部服务拒绝，未生成兑换码',
  INVALID_REQUEST_413: '请求被外部服务拒绝，未生成兑换码',
  GAVE_UP_NOT_FOUND: '多次重试未成功，已确认未生成兑换码',
};

export function describeLastError(code: string | null): string {
  if (!code) return '正在向外部服务请求兑换码';
  if (/^HTTP_5\d\d$/.test(code)) return '外部服务暂时故障';
  return LAST_ERROR[code] ?? `外部服务异常（${code}）`;
}

export function describeFailure(code: string | null): string {
  return (code && FAILURE[code]) ?? '兑换失败';
}

export const STATUS_LABEL: Record<Order['status'], string> = {
  processing: '处理中',
  delivered: '已发放',
  failed: '已退款',
};

export function explainOrder(o: Order): string {
  if (o.status === 'delivered') return o.fulfillment === 'internal' ? '站内权益，已生效' : '兑换码已发放';
  if (o.status === 'failed') return `${describeFailure(o.failureReason)}，${o.price} 积分已退回`;
  const next = o.nextAttemptAt ? new Date(o.nextAttemptAt).getTime() - Date.now() : 0;
  const when = next > 60_000 ? `约 ${Math.ceil(next / 60_000)} 分钟后` : next > 0 ? `${Math.ceil(next / 1000)} 秒后` : '即将';
  return o.attempts > 0
    ? `${describeLastError(o.lastError)}，${when}自动重试（已尝试 ${o.attempts} 次）。积分已暂扣，若最终确认未发码会自动退回。`
    : '正在向外部服务请求兑换码';
}
