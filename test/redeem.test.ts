import { describe, expect, it } from 'vitest';
import { redeem } from '../server/services/orders.js';
import { assertInvariants, balanceOf, createUser, useTestEnv } from './helpers.js';

const { db, fake, deps } = await useTestEnv();
const key = () => `k_${Math.random().toString(36).slice(2, 12)}`;

describe('兑换：余额与并发', () => {
  it('外部商品正常兑换：扣分并拿到码', async () => {
    const u = await createUser(db, 250);
    const order = await redeem(deps, u, 'ebook', key());
    expect(order.status).toBe('delivered');
    expect(order.code).toBe(fake.deliveries.get(order.id)?.code);
    expect(await balanceOf(db, u)).toBe(150);
    await assertInvariants(db, fake);
  });

  it('站内商品：扣分即发放，不调用外部 API', async () => {
    const u = await createUser(db, 100);
    const order = await redeem(deps, u, 'avatar_frame', key());
    expect(order).toMatchObject({ status: 'delivered', code: null });
    expect(fake.requests).toHaveLength(0);
    expect(await balanceOf(db, u)).toBe(40);
    await assertInvariants(db, fake);
  });

  it('积分不足：拒绝，不建单、不扣分、不调外部', async () => {
    const u = await createUser(db, 99);
    await expect(redeem(deps, u, 'ebook', key())).rejects.toMatchObject({ code: 'INSUFFICIENT_POINTS' });
    expect(await balanceOf(db, u)).toBe(99);
    expect(fake.requests).toHaveLength(0);
    const { rowCount } = await db.query('SELECT 1 FROM orders');
    expect(rowCount).toBe(0);
  });

  it('积分恰好够：可以兑换，余额归零', async () => {
    const u = await createUser(db, 100);
    await redeem(deps, u, 'ebook', key());
    expect(await balanceOf(db, u)).toBe(0);
  });

  it('并发 10 个兑换、余额只够 3 个：恰好成功 3 个，不超扣', async () => {
    const u = await createUser(db, 350);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => redeem(deps, u, 'ebook', key())));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(3);
    expect(rejected.every((r) => r.reason.code === 'INSUFFICIENT_POINTS')).toBe(true);
    expect(await balanceOf(db, u)).toBe(50);
    expect(fake.deliveries.size).toBe(3);
    await assertInvariants(db, fake);
  });

  it('同一幂等键并发提交 5 次（双击/重发）：只生成一个订单、只扣一次', async () => {
    const u = await createUser(db, 500);
    const k = key();
    const results = await Promise.all(Array.from({ length: 5 }, () => redeem(deps, u, 'ebook', k)));
    expect(new Set(results.map((o) => o.id)).size).toBe(1);
    expect(await balanceOf(db, u)).toBe(400);
    expect(fake.deliveries.size).toBe(1);
    await assertInvariants(db, fake);
  });

  it('同一幂等键换商品：拒绝', async () => {
    const u = await createUser(db, 500);
    const k = key();
    await redeem(deps, u, 'ebook', k);
    await expect(redeem(deps, u, 'theme', k)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await balanceOf(db, u)).toBe(400);
  });

  it('不存在的商品：404', async () => {
    const u = await createUser(db, 500);
    await expect(redeem(deps, u, 'nope', key())).rejects.toMatchObject({ status: 404 });
  });
});
