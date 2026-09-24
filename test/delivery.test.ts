import { describe, expect, it } from 'vitest';
import { attemptDelivery, MAX_POST_ATTEMPTS, processDueOrders, redeem, type Deps } from '../server/services/orders.js';
import { assertInvariants, balanceOf, createUser, makeDue, useTestEnv } from './helpers.js';

const env = await useTestEnv();
const { db, fake } = env;
// 缩短超时，模拟「外部很慢」时不必真的等 8 秒
const deps: Deps = { ...env.deps, timeouts: { sync: 150, worker: 150 } };
const key = () => `k_${Math.random().toString(36).slice(2, 12)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function orderRow(id: string) {
  const { rows } = await db.query('SELECT status, code, attempts, last_error, failure_reason, next_attempt_at FROM orders WHERE id = $1', [id]);
  return rows[0];
}

/** 反复让订单到期并跑后台补发，直到不再是 processing（或达到轮数上限）。 */
async function drain(rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    await makeDue(db);
    if ((await processDueOrders(deps)) === 0) return;
  }
}

describe('外部 API 异常时的一致性', () => {
  it('422 商品不可用：订单失败并全额退款，外部没有码', async () => {
    fake.setBehavior(() => ({ commit: false, status: 422 }));
    const u = await createUser(db, 100);
    const order = await redeem(deps, u, 'ebook', key());
    expect(order).toMatchObject({ status: 'failed', failureReason: 'PRODUCT_UNAVAILABLE', code: null });
    expect(await balanceOf(db, u)).toBe(100);
    await assertInvariants(db, fake);
  });

  it('503（未生成码）：先显示处理中、不退款，后台重试成功后发码', async () => {
    fake.setBehavior((r) => (r.nth === 1 ? { commit: false, status: 503 } : undefined));
    const u = await createUser(db, 100);
    const order = await redeem(deps, u, 'ebook', key());
    expect(order).toMatchObject({ status: 'processing', lastError: 'HTTP_503' });
    expect(await balanceOf(db, u)).toBe(0); // 处理中：分已扣，不退
    await assertInvariants(db, fake);

    await drain();
    expect(await orderRow(order.id)).toMatchObject({ status: 'delivered', code: fake.deliveries.get(order.id)!.code });
    await assertInvariants(db, fake);
  });

  it('码已生成但响应丢失（500）：重试拿回同一个码，不重复发码', async () => {
    fake.setBehavior((r) => (r.nth === 1 ? { commit: true, status: 500 } : undefined));
    const u = await createUser(db, 100);
    const order = await redeem(deps, u, 'ebook', key());
    expect(order.status).toBe('processing');
    const codeGenerated = fake.deliveries.get(order.id)!.code;

    await drain();
    expect((await orderRow(order.id))!.code).toBe(codeGenerated);
    expect(fake.deliveries.size).toBe(1);
    expect(fake.requests.filter((r) => r.method === 'POST')).toHaveLength(2);
    await assertInvariants(db, fake);
  });

  it('响应超时（外部其实已生成码）：不退款，重试拿回同一个码', async () => {
    fake.setBehavior((r) => (r.nth === 1 ? { delayMs: 400 } : undefined));
    const u = await createUser(db, 100);
    const order = await redeem(deps, u, 'ebook', key());
    expect(order).toMatchObject({ status: 'processing', lastError: 'TIMEOUT' });
    await sleep(500); // 等外部把那次慢请求处理完
    expect(fake.deliveries.has(order.id)).toBe(true);

    await drain();
    expect(await orderRow(order.id)).toMatchObject({ status: 'delivered', code: fake.deliveries.get(order.id)!.code });
    expect(fake.deliveries.size).toBe(1);
    await assertInvariants(db, fake);
  });

  it('200 但响应体异常：不当作成功，也不退款', async () => {
    fake.setBehavior((r) => (r.nth === 1 ? { malformed: true } : undefined));
    const u = await createUser(db, 100);
    const order = await redeem(deps, u, 'ebook', key());
    expect(order).toMatchObject({ status: 'processing', lastError: 'BAD_RESPONSE' });
    await drain();
    expect((await orderRow(order.id))!.status).toBe('delivered');
    await assertInvariants(db, fake);
  });

  it('429：按 Retry-After 推迟重试，并暂停本轮后台补发', async () => {
    fake.setBehavior(() => ({ commit: false, status: 429, retryAfter: '120' }));
    const u = await createUser(db, 500);
    const o1 = await redeem(deps, u, 'ebook', key());
    const o2 = await redeem(deps, u, 'ebook', key());
    const row = await orderRow(o1.id);
    const waitMs = new Date(row!.next_attempt_at).getTime() - Date.now();
    expect(waitMs).toBeGreaterThan(110_000);

    fake.requests.length = 0;
    await makeDue(db);
    await processDueOrders(deps);
    expect(fake.requests).toHaveLength(1); // 第一个就被限流，第二个本轮不再请求
    expect([(await orderRow(o1.id))!.status, (await orderRow(o2.id))!.status]).toEqual(['processing', 'processing']);
    await assertInvariants(db, fake);
  });

  it('401 Key 失效：挂起不退款；Key 恢复后自动补发', async () => {
    fake.setBehavior(() => ({ commit: false, status: 401 }));
    const u = await createUser(db, 100);
    const order = await redeem(deps, u, 'ebook', key());
    expect(order).toMatchObject({ status: 'processing', lastError: 'UNAUTHORIZED' });
    await makeDue(db);
    await processDueOrders(deps);
    expect((await orderRow(order.id))!.status).toBe('processing');
    expect(await balanceOf(db, u)).toBe(0);

    fake.setBehavior(() => undefined); // 换了新 Key
    await drain();
    expect((await orderRow(order.id))!.status).toBe('delivered');
    await assertInvariants(db, fake);
  });

  it('一直失败到重试上限：GET 确认外部没有这笔后才退款', async () => {
    fake.setBehavior((r) => (r.method === 'POST' ? { commit: false, status: 503 } : undefined));
    const u = await createUser(db, 100);
    const order = await redeem(deps, u, 'ebook', key());
    await drain(MAX_POST_ATTEMPTS + 2);

    expect(await orderRow(order.id)).toMatchObject({ status: 'failed', failure_reason: 'GAVE_UP_NOT_FOUND' });
    expect(fake.requests.filter((r) => r.method === 'POST')).toHaveLength(MAX_POST_ATTEMPTS);
    expect(fake.requests.filter((r) => r.method === 'GET')).toHaveLength(1);
    expect(await balanceOf(db, u)).toBe(100);
    await assertInvariants(db, fake);
  });

  it('一直失败到重试上限，但外部其实已发码：GET 查到后补记为已发放，不退款', async () => {
    fake.setBehavior((r) => (r.method === 'POST' ? { commit: true, status: 500 } : undefined));
    const u = await createUser(db, 100);
    const order = await redeem(deps, u, 'ebook', key());
    await drain(MAX_POST_ATTEMPTS + 2);

    expect(await orderRow(order.id)).toMatchObject({ status: 'delivered', code: fake.deliveries.get(order.id)!.code });
    expect(await balanceOf(db, u)).toBe(0);
    await assertInvariants(db, fake);
  });

  it('到达上限后 GET 也失败：继续挂起，绝不在未知状态下退款', async () => {
    fake.setBehavior(() => ({ commit: false, status: 503 }));
    const u = await createUser(db, 100);
    const order = await redeem(deps, u, 'ebook', key());
    await drain(MAX_POST_ATTEMPTS + 5);

    expect((await orderRow(order.id))!.status).toBe('processing');
    expect(await balanceOf(db, u)).toBe(0);
    await assertInvariants(db, fake);
  });

  it('租约：同一订单被同时处理时，只有一方会调用外部 API', async () => {
    fake.setBehavior((r) => (r.nth === 1 ? { commit: false, status: 503 } : { delayMs: 50 }));
    const u = await createUser(db, 100);
    const order = await redeem(deps, u, 'ebook', key());
    fake.requests.length = 0;
    await makeDue(db);
    const results = await Promise.all(Array.from({ length: 5 }, () => attemptDelivery(deps, order.id, 1000)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(fake.requests).toHaveLength(1);
    await assertInvariants(db, fake);
  });

  it('混合压力：多用户并发兑换 + 随机故障，最终账目全部对得上', async () => {
    const plans = [undefined, { commit: false, status: 503 }, { commit: true, status: 500 }, { commit: false, status: 422 }];
    fake.setBehavior((r) => (r.method === 'POST' && r.nth === 1 ? plans[Math.floor(Math.random() * plans.length)] : undefined));
    const users = await Promise.all(Array.from({ length: 4 }, () => createUser(db, 400)));
    await Promise.allSettled(users.flatMap((u) => Array.from({ length: 5 }, () => redeem(deps, u, 'ebook', key()))));
    await assertInvariants(db, fake);
    await drain();
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM orders WHERE status = 'processing'`);
    expect(rows[0].n).toBe(0);
    await assertInvariants(db, fake);
  });
});
