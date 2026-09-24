import { withTx, type Db } from '../db/pool.js';
import { AppError } from '../errors.js';
import { applyPoints } from './points.js';

export interface TaskView {
  id: string;
  title: string;
  description: string;
  reward: number;
  kind: 'once' | 'daily';
  completed: boolean; // 本周期（once=永久，daily=今天）是否已领取
}

/** once 任务的周期固定为 'once'；daily 任务的周期是 UTC 日期，与外部 API 的日界一致。 */
export function periodFor(kind: 'once' | 'daily', now: Date): string {
  return kind === 'once' ? 'once' : now.toISOString().slice(0, 10);
}

export async function listTasks(db: Db, userId: string, now = new Date()): Promise<TaskView[]> {
  const { rows } = await db.query<Omit<TaskView, 'completed'> & { done: boolean }>(
    `SELECT t.id, t.title, t.description, t.reward, t.kind,
            EXISTS (SELECT 1 FROM task_completions c
                    WHERE c.user_id = $1 AND c.task_id = t.id
                      AND c.period = CASE t.kind WHEN 'once' THEN 'once' ELSE $2 END) AS done
     FROM tasks t ORDER BY t.sort_order, t.id`,
    [userId, periodFor('daily', now)],
  );
  return rows.map(({ done, ...t }) => ({ ...t, completed: done }));
}

/**
 * 领取任务奖励。是否重复领取完全交给唯一约束 (user_id, task_id, period) 判断：
 * 并发的两次点击只有一个 INSERT 能成功，另一个拿到 0 行，不会发两次积分。
 */
export async function completeTask(db: Db, userId: string, taskId: string, now = new Date()) {
  return withTx(db, async (tx) => {
    const { rows: tasks } = await tx.query<{ title: string; reward: number; kind: 'once' | 'daily' }>(
      'SELECT title, reward, kind FROM tasks WHERE id = $1',
      [taskId],
    );
    const task = tasks[0];
    if (!task) throw new AppError(404, 'TASK_NOT_FOUND', '任务不存在');

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO task_completions (user_id, task_id, period, reward) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, task_id, period) DO NOTHING RETURNING id`,
      [userId, taskId, periodFor(task.kind, now), task.reward],
    );
    const completionId = rows[0]?.id;
    if (!completionId) {
      throw new AppError(409, 'TASK_ALREADY_COMPLETED', task.kind === 'daily' ? '今天已经领取过了' : '该任务已经完成过了');
    }
    const balance = await applyPoints(tx, {
      userId, delta: task.reward, kind: 'task_reward', taskCompletionId: completionId, description: `完成任务：${task.title}`,
    });
    return { reward: task.reward, balance };
  });
}
