import { describe, expect, it } from 'vitest';
import { completeTask, listTasks } from '../server/services/tasks.js';
import { assertInvariants, balanceOf, createUser, useTestEnv } from './helpers.js';

const { db } = await useTestEnv();

describe('任务领取', () => {
  it('一次性任务只能领一次', async () => {
    const u = await createUser(db, 20);
    await completeTask(db, u, 'once_profile');
    await expect(completeTask(db, u, 'once_profile')).rejects.toMatchObject({ code: 'TASK_ALREADY_COMPLETED' });
    expect(await balanceOf(db, u)).toBe(50);
    await assertInvariants(db);
  });

  it('每日任务每个 UTC 日可领一次，次日可再领', async () => {
    const u = await createUser(db, 20);
    const day1 = new Date('2026-09-24T23:59:00Z');
    const day2 = new Date('2026-09-25T00:01:00Z');
    await completeTask(db, u, 'daily_checkin', day1);
    await expect(completeTask(db, u, 'daily_checkin', day1)).rejects.toMatchObject({ code: 'TASK_ALREADY_COMPLETED' });
    expect((await listTasks(db, u, day1)).find((t) => t.id === 'daily_checkin')?.completed).toBe(true);
    expect((await listTasks(db, u, day2)).find((t) => t.id === 'daily_checkin')?.completed).toBe(false);
    await completeTask(db, u, 'daily_checkin', day2);
    expect(await balanceOf(db, u)).toBe(40);
    await assertInvariants(db);
  });

  it('并发点击同一任务只发一次奖励', async () => {
    const u = await createUser(db, 20);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => completeTask(db, u, 'once_guide')));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await balanceOf(db, u)).toBe(40);
    await assertInvariants(db);
  });

  it('不同用户的任务互不影响', async () => {
    const a = await createUser(db, 20);
    const b = await createUser(db, 20);
    await completeTask(db, a, 'once_follow');
    await completeTask(db, b, 'once_follow');
    expect(await balanceOf(db, a)).toBe(40);
    expect(await balanceOf(db, b)).toBe(40);
  });

  it('不存在的任务返回 404', async () => {
    const u = await createUser(db, 20);
    await expect(completeTask(db, u, 'nope')).rejects.toMatchObject({ status: 404 });
  });
});
