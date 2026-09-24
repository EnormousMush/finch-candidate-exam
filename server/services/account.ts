import type { Db } from '../db/pool.js';

/** 顶部概览：余额 + 几个由流水聚合出来的数字（都按当前用户过滤）。 */
export async function getSummary(db: Db, userId: string) {
  const { rows } = await db.query<{
    balance: number; earnedToday: number; totalEarned: number; totalSpent: number; processing: number;
  }>(
    `SELECT u.balance,
       COALESCE((SELECT SUM(delta) FROM point_ledger WHERE user_id = u.id AND kind = 'task_reward'
                 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0)::int AS "earnedToday",
       COALESCE((SELECT SUM(delta) FROM point_ledger WHERE user_id = u.id AND kind <> 'redeem' AND kind <> 'refund'), 0)::int AS "totalEarned",
       COALESCE((SELECT -SUM(delta) FROM point_ledger WHERE user_id = u.id AND kind IN ('redeem', 'refund')), 0)::int AS "totalSpent",
       (SELECT COUNT(*) FROM orders WHERE user_id = u.id AND status = 'processing')::int AS processing
     FROM users u WHERE u.id = $1`,
    [userId],
  );
  return rows[0]!;
}

export async function listLedger(db: Db, userId: string) {
  const { rows } = await db.query(
    `SELECT id, delta, balance_after AS "balanceAfter", kind, description,
            order_id AS "orderId", created_at AS "createdAt"
     FROM point_ledger WHERE user_id = $1 ORDER BY id DESC LIMIT 200`,
    [userId],
  );
  return rows;
}

export async function listProducts(db: Db) {
  const { rows } = await db.query(
    `SELECT id, name, description, price, fulfillment FROM products WHERE active ORDER BY sort_order, id`,
  );
  return rows;
}
