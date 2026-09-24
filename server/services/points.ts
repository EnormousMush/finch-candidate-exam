import type { Tx } from '../db/pool.js';

export type LedgerKind = 'signup_bonus' | 'seed_grant' | 'task_reward' | 'redeem' | 'refund';

/**
 * 所有积分变动的唯一入口：更新余额 + 追加一条流水，必须在调用方的事务里执行。
 * 余额更新是原子的 `balance = balance + delta`，扣成负数会被 CHECK 约束拒绝。
 */
export async function applyPoints(
  tx: Tx,
  entry: {
    userId: string;
    delta: number;
    kind: LedgerKind;
    description: string;
    orderId?: string;
    taskCompletionId?: string;
  },
): Promise<number> {
  const { rows } = await tx.query<{ balance: number }>(
    'UPDATE users SET balance = balance + $2 WHERE id = $1 RETURNING balance',
    [entry.userId, entry.delta],
  );
  const balance = rows[0]?.balance;
  if (balance === undefined) throw new Error(`user ${entry.userId} not found`);
  await tx.query(
    `INSERT INTO point_ledger (user_id, delta, balance_after, kind, description, order_id, task_completion_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [entry.userId, entry.delta, balance, entry.kind, entry.description, entry.orderId ?? null, entry.taskCompletionId ?? null],
  );
  return balance;
}
