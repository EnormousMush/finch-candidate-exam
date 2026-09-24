import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../server/app.js';
import { SIGNUP_BONUS } from '../server/services/auth.js';
import { useTestEnv } from './helpers.js';

const { db, goods } = await useTestEnv();
const app = await buildApp({ db, goods });
afterAll(() => app.close());

async function loginAs(username: string, password: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  expect(res.statusCode).toBe(200);
  return { cookie: res.headers['set-cookie'] as string };
}

describe('HTTP 接口：认证与数据隔离', () => {
  it('未登录访问受保护接口返回 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(401);
  });

  it('注册后自动登录并获得新人积分', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'carol', password: 'secret1' } });
    expect(res.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: res.headers['set-cookie'] as string } });
    expect(me.json()).toMatchObject({ user: { username: 'carol' }, summary: { balance: SIGNUP_BONUS } });
  });

  it('重复用户名 409，错误密码 401', async () => {
    const dup = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'alice', password: 'whatever' } });
    expect(dup.statusCode).toBe(409);
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'wrong!!' } });
    expect(bad.statusCode).toBe(401);
  });

  it('用户只能看到自己的订单和流水', async () => {
    const alice = await loginAs('alice', 'alice123');
    const bob = await loginAs('bob', 'bob123');

    const created = await app.inject({
      method: 'POST', url: '/api/orders', headers: alice,
      payload: { productId: 'name_color', idempotencyKey: 'alice-key-0001' },
    });
    expect(created.statusCode).toBe(200);
    const orderId = created.json().order.id;

    const peek = await app.inject({ method: 'GET', url: `/api/orders/${orderId}`, headers: bob });
    expect(peek.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/orders', headers: bob })).json().orders).toEqual([]);
    const bobLedger = (await app.inject({ method: 'GET', url: '/api/ledger', headers: bob })).json().entries;
    expect(bobLedger.every((e: { orderId: string | null }) => e.orderId !== orderId)).toBe(true);
  });

  it('积分不足返回 422 和可读的错误信息', async () => {
    const bob = await loginAs('bob', 'bob123');
    const res = await app.inject({
      method: 'POST', url: '/api/orders', headers: bob,
      payload: { productId: 'course', idempotencyKey: 'bob-key-00001' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INSUFFICIENT_POINTS');
  });

  it('请求体不是合法 JSON：返回 4xx 而不是 500', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: '{bad',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_REQUEST');
  });

  it('退出登录后 session 失效', async () => {
    const alice = await loginAs('alice', 'alice123');
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: alice });
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: alice })).statusCode).toBe(401);
  });
});
