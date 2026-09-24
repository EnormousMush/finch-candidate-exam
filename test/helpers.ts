import { afterAll, beforeEach, expect } from 'vitest';
import { createDb, withTx, type Db } from '../server/db/pool.js';
import { seed } from '../server/db/seed.js';
import { createDigitalGoodsClient } from '../server/external/digitalGoods.js';
import { register } from '../server/services/auth.js';
import { applyPoints } from '../server/services/points.js';
import { startFakeGoods, type FakeGoods } from '../scripts/fakeGoodsServer.js';
import type { Deps } from '../server/services/orders.js';
import { testDatabaseUrl } from './env.js';

/** 每个测试文件一套：真实 Postgres 测试库 + 本地假外部 API；每个用例前清空业务数据。 */
export async function useTestEnv() {
  const db = createDb(testDatabaseUrl());
  const fake = await startFakeGoods();
  const goods = createDigitalGoodsClient(fake.url, fake.apiKey);
  const deps: Deps = { db, goods };

  beforeEach(async () => {
    await db.query('TRUNCATE users, sessions, task_completions, orders, point_ledger RESTART IDENTITY CASCADE');
    fake.deliveries.clear();
    fake.requests.length = 0;
    fake.setBehavior(() => undefined);
    await seed(db);
  });
  afterAll(async () => {
    await fake.close();
    await db.end();
  });
  return { db, fake, goods, deps };
}

let userSeq = 0;
/** 新建一个用户，并把余额精确调整为 points（注册奖励 + 补足差额）。 */
export async function createUser(db: Db, points: number): Promise<string> {
  const user = await register(db, `u${Date.now().toString(36)}${userSeq++}`, 'password');
  const { rows } = await db.query<{ balance: number }>('SELECT balance FROM users WHERE id = $1', [user.id]);
  const diff = points - rows[0]!.balance;
  if (diff > 0) {
    await withTx(db, (tx) => applyPoints(tx, { userId: user.id, delta: diff, kind: 'seed_grant', description: 'test' }));
  } else if (diff < 0) {
    throw new Error('points must be >= signup bonus');
  }
  return user.id;
}

export async function balanceOf(db: Db, userId: string): Promise<number> {
  const { rows } = await db.query<{ balance: number }>('SELECT balance FROM users WHERE id = $1', [userId]);
  return rows[0]!.balance;
}

/** 让订单立即到期，便于在测试中触发后台补发，而不用真的等退避时间。 */
export async function makeDue(db: Db, orderId?: string) {
  await db.query(
    `UPDATE orders SET next_attempt_at = now() - interval '1 second', lease_until = NULL
     WHERE status = 'processing' AND ($1::text IS NULL OR id = $1)`,
    [orderId ?? null],
  );
}

/**
 * 核心不变量：无论中间发生过什么，最终账都必须对得上。
 * 每个测试结束时调用。
 */
export async function assertInvariants(db: Db, fake?: FakeGoods) {
  // 1. 余额 = 流水之和
  const { rows: drift } = await db.query(
    `SELECT u.id, u.balance, COALESCE(SUM(l.delta), 0)::int AS sum
     FROM users u LEFT JOIN point_ledger l ON l.user_id = u.id
     GROUP BY u.id HAVING u.balance <> COALESCE(SUM(l.delta), 0)`,
  );
  expect(drift, '余额与流水之和不一致').toEqual([]);

  // 2. 每个订单恰好扣一次分；失败订单恰好退一次，其余订单不退
  const { rows: orders } = await db.query<{
    id: string; status: string; price: number; code: string | null; fulfillment: string;
    redeemed: number; refunded: number; redeem_count: number; refund_count: number;
  }>(
    `SELECT o.id, o.status, o.price, o.code, p.fulfillment,
            COALESCE(SUM(-l.delta) FILTER (WHERE l.kind = 'redeem'), 0)::int AS redeemed,
            COALESCE(SUM(l.delta) FILTER (WHERE l.kind = 'refund'), 0)::int AS refunded,
            COUNT(*) FILTER (WHERE l.kind = 'redeem')::int AS redeem_count,
            COUNT(*) FILTER (WHERE l.kind = 'refund')::int AS refund_count
     FROM orders o JOIN products p ON p.id = o.product_id
     LEFT JOIN point_ledger l ON l.order_id = o.id
     GROUP BY o.id, p.fulfillment`,
  );
  for (const o of orders) {
    expect(o.redeem_count, `订单 ${o.id} 扣分次数`).toBe(1);
    expect(o.redeemed, `订单 ${o.id} 扣分金额`).toBe(o.price);
    expect(o.refund_count, `订单 ${o.id} 退款次数`).toBe(o.status === 'failed' ? 1 : 0);
    if (o.status === 'failed') expect(o.refunded).toBe(o.price);
  }

  // 3. 与外部世界对账：外部生成的每个码都在我们这里（不丢码），失败退款的订单外部一定没有码
  if (fake) {
    const external = orders.filter((o) => o.fulfillment === 'external');
    for (const o of external) {
      const remote = fake.deliveries.get(o.id);
      if (o.status === 'delivered') expect(o.code, `订单 ${o.id} 的码`).toBe(remote?.code);
      if (o.status === 'failed') expect(remote, `订单 ${o.id} 已退款但外部有码`).toBeUndefined();
    }
    const ours = new Set(external.map((o) => o.id));
    for (const requestId of fake.deliveries.keys()) expect(ours.has(requestId), `外部码 ${requestId} 无对应订单`).toBe(true);
  }
}
