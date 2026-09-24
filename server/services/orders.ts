import { randomBytes } from 'node:crypto';
import { withTx, type Db } from '../db/pool.js';
import { AppError } from '../errors.js';
import type { DeliveryResult, DigitalGoodsClient } from '../external/digitalGoods.js';
import { applyPoints } from './points.js';

/**
 * 兑换流程（外部商品）：
 *
 *   ① 事务：锁用户行 → 查幂等键 → 校验余额 → 建单(processing) + 扣分
 *   ② 事务外：用订单号作 requestId 调外部 API（同步最多等 SYNC_TIMEOUT_MS）
 *   ③ 按结果落库：
 *        delivered → 存码，完成
 *        rejected  → 外部明确没发码 → 标记失败 + 退款（同一事务）
 *        unknown   → 不知道发没发 → 保持 processing，交给后台按退避重试（同一个 requestId，不会重复发码）
 *   ④ 重试到上限后改用 GET 确认：查到码就补记发放；确认 404 才退款；GET 也失败就继续等。
 *
 * 扣分先于外部调用，所以「码发了但分没扣」不可能出现；
 * 未知状态永不退款，所以「分退了但码其实发了」也不可能出现。
 */

export const SYNC_TIMEOUT_MS = 8_000;
export const WORKER_TIMEOUT_MS = 10_000;
const LEASE_MS = 30_000;
export const MAX_POST_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 10 * 60_000;

export interface Deps {
  db: Db;
  goods: DigitalGoodsClient;
  /** 可覆盖超时（测试里用很短的超时模拟「外部很慢」） */
  timeouts?: { sync: number; worker: number };
}

export interface OrderView {
  id: string;
  productId: string;
  productName: string;
  fulfillment: 'external' | 'internal';
  price: number;
  status: 'processing' | 'delivered' | 'failed';
  code: string | null;
  failureReason: string | null;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface OrderRow {
  id: string;
  user_id: string;
  product_id: string;
  price: number;
  status: OrderView['status'];
  attempts: number;
  external_product_id: string | null;
}

const ORDER_VIEW_SQL = `
  SELECT o.id, o.product_id AS "productId", p.name AS "productName", p.fulfillment,
         o.price, o.status, o.code, o.failure_reason AS "failureReason", o.attempts,
         o.last_error AS "lastError", o.next_attempt_at AS "nextAttemptAt",
         o.created_at AS "createdAt", o.completed_at AS "completedAt"
  FROM orders o JOIN products p ON p.id = o.product_id`;

export function newOrderId(): string {
  // 满足外部 requestId 规则：字母数字开头，仅含字母数字下划线连字符
  return `ord_${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;
}

export async function redeem(
  deps: Deps,
  userId: string,
  productId: string,
  idempotencyKey: string,
): Promise<OrderView> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(idempotencyKey)) {
    throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', '缺少合法的幂等键');
  }

  const { orderId, needsDelivery } = await withTx(deps.db, async (tx) => {
    // 锁住用户行：同一用户的兑换请求在这里排队，后面的「查幂等键 + 查余额 + 扣分」不会交错
    const { rows: users } = await tx.query<{ balance: number }>(
      'SELECT balance FROM users WHERE id = $1 FOR UPDATE',
      [userId],
    );
    const balance = users[0]?.balance ?? 0;

    const { rows: existing } = await tx.query<{ id: string; product_id: string }>(
      'SELECT id, product_id FROM orders WHERE user_id = $1 AND idempotency_key = $2',
      [userId, idempotencyKey],
    );
    if (existing[0]) {
      if (existing[0].product_id !== productId) {
        throw new AppError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于其他商品');
      }
      return { orderId: existing[0].id, needsDelivery: false }; // 重复提交：返回原订单，不再扣分
    }

    const { rows: products } = await tx.query<{ name: string; price: number; fulfillment: string }>(
      'SELECT name, price, fulfillment FROM products WHERE id = $1 AND active',
      [productId],
    );
    const product = products[0];
    if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', '商品不存在或已下架');
    if (balance < product.price) {
      throw new AppError(422, 'INSUFFICIENT_POINTS', `积分不足：需要 ${product.price}，当前 ${balance}`);
    }

    const id = newOrderId();
    const internal = product.fulfillment === 'internal';
    await tx.query(
      `INSERT INTO orders (id, user_id, product_id, price, idempotency_key, status, completed_at, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id, userId, productId, product.price, idempotencyKey,
        internal ? 'delivered' : 'processing',
        internal ? new Date() : null,
        // 外部商品：给同步调用留出时间窗，窗口内后台不会插手；进程若在调用前崩溃，窗口过后后台接手
        internal ? null : new Date(Date.now() + LEASE_MS),
      ],
    );
    await applyPoints(tx, {
      userId, delta: -product.price, kind: 'redeem', orderId: id, description: `兑换：${product.name}`,
    });
    return { orderId: id, needsDelivery: !internal };
  });

  if (needsDelivery) await attemptDelivery(deps, orderId, deps.timeouts?.sync ?? SYNC_TIMEOUT_MS);
  return (await getOrder(deps.db, userId, orderId))!;
}

/**
 * 对一笔 processing 订单做一次发货尝试。先用「租约」认领订单：
 * 条件 UPDATE 只有一个调用者能成功，因此同步请求和后台 worker 不会同时调外部 API。
 * 认领后在事务外调用外部 API，不会长时间占着数据库连接和行锁。
 */
export async function attemptDelivery(deps: Deps, orderId: string, timeoutMs: number): Promise<DeliveryResult | null> {
  const { rows } = await deps.db.query<OrderRow>(
    `UPDATE orders o SET lease_until = now() + ($2 || ' milliseconds')::interval,
                         attempts = attempts + 1, updated_at = now()
     FROM products p
     WHERE o.id = $1 AND p.id = o.product_id AND o.status = 'processing'
       AND (o.lease_until IS NULL OR o.lease_until < now())
     RETURNING o.id, o.user_id, o.product_id, o.price, o.status, o.attempts, p.external_product_id`,
    [orderId, LEASE_MS],
  );
  const order = rows[0];
  if (!order) return null; // 已完成，或别人正在处理

  if (order.attempts <= MAX_POST_ATTEMPTS) {
    const result = await deps.goods.createDelivery(order.id, order.external_product_id!, timeoutMs);
    if (result.kind === 'delivered') await markDelivered(deps.db, order.id, result.code);
    else if (result.kind === 'rejected') await failAndRefund(deps.db, order.id, result.reason);
    else await scheduleRetry(deps.db, order, result.kind === 'unknown' ? result : { reason: 'UNEXPECTED' });
    return result;
  }

  // 重试已达上限：不再 POST，改为 GET 确认外部最终状态。
  // 距上一次 POST 至少隔了一个退避周期，此时的 404 才能可信地表示「没有生成过码」。
  const result = await deps.goods.getDelivery(order.id, timeoutMs);
  if (result.kind === 'delivered') await markDelivered(deps.db, order.id, result.code);
  else if (result.kind === 'not_found') await failAndRefund(deps.db, order.id, 'GAVE_UP_NOT_FOUND');
  else await scheduleRetry(deps.db, order, result.kind === 'unknown' ? result : { reason: 'UNEXPECTED' });
  return result;
}

async function markDelivered(db: Db, orderId: string, code: string) {
  await db.query(
    `UPDATE orders SET status = 'delivered', code = $2, completed_at = now(), updated_at = now(),
                       lease_until = NULL, next_attempt_at = NULL, last_error = NULL
     WHERE id = $1 AND status = 'processing'`,
    [orderId, code],
  );
}

/** 标记失败与退款必须在同一事务：不存在「失败了但没退分」的中间态。 */
export async function failAndRefund(db: Db, orderId: string, reason: string) {
  await withTx(db, async (tx) => {
    const { rows } = await tx.query<{ user_id: string; price: number; name: string }>(
      `SELECT o.user_id, o.price, p.name FROM orders o JOIN products p ON p.id = o.product_id
       WHERE o.id = $1 AND o.status = 'processing' FOR UPDATE OF o`,
      [orderId],
    );
    const order = rows[0];
    if (!order) return; // 已被别人处理完
    await tx.query(
      `UPDATE orders SET status = 'failed', failure_reason = $2, completed_at = now(), updated_at = now(),
                         lease_until = NULL, next_attempt_at = NULL
       WHERE id = $1`,
      [orderId, reason],
    );
    await applyPoints(tx, {
      userId: order.user_id, delta: order.price, kind: 'refund', orderId, description: `兑换失败退款：${order.name}`,
    });
  });
}

export function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

async function scheduleRetry(db: Db, order: OrderRow, result: { reason: string; retryAfterMs?: number }) {
  const delay = Math.max(backoffMs(order.attempts), result.retryAfterMs ?? 0);
  await db.query(
    `UPDATE orders SET last_error = $2, next_attempt_at = now() + ($3 || ' milliseconds')::interval,
                       lease_until = NULL, updated_at = now()
     WHERE id = $1 AND status = 'processing'`,
    [order.id, result.reason, delay],
  );
}

/** 后台补发：取到期的 processing 订单逐个尝试。串行执行，天然控制对外部 API 的请求频率。 */
export async function processDueOrders(deps: Deps, limit = 5): Promise<number> {
  const { rows } = await deps.db.query<{ id: string }>(
    `SELECT id FROM orders
     WHERE status = 'processing' AND next_attempt_at <= now()
       AND (lease_until IS NULL OR lease_until < now())
     ORDER BY next_attempt_at LIMIT $1`,
    [limit],
  );
  let processed = 0;
  for (const { id } of rows) {
    const result = await attemptDelivery(deps, id, deps.timeouts?.worker ?? WORKER_TIMEOUT_MS);
    if (result) processed++;
    // 被限流时本轮不再继续打外部 API
    if (result?.kind === 'unknown' && result.reason === 'RATE_LIMITED') break;
  }
  return processed;
}

export function startWorker(deps: Deps, intervalMs = 3_000, log: (e: unknown) => void = console.error) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await processDueOrders(deps);
    } catch (err) {
      log(err);
    } finally {
      running = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

export async function listOrders(db: Db, userId: string): Promise<OrderView[]> {
  const { rows } = await db.query<OrderView>(
    `${ORDER_VIEW_SQL} WHERE o.user_id = $1 ORDER BY o.created_at DESC LIMIT 100`,
    [userId],
  );
  return rows;
}

/** 查询永远带 user_id 条件：别人的订单等同于不存在。 */
export async function getOrder(db: Db, userId: string, orderId: string): Promise<OrderView | null> {
  const { rows } = await db.query<OrderView>(`${ORDER_VIEW_SQL} WHERE o.user_id = $1 AND o.id = $2`, [userId, orderId]);
  return rows[0] ?? null;
}
