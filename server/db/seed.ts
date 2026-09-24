import { withTx, type Db } from './pool.js';
import { hashPassword } from '../services/auth.js';
import { applyPoints } from '../services/points.js';

export const TASKS = [
  { id: 'daily_checkin', title: '每日签到', description: '每天来打个卡', reward: 10, kind: 'daily' },
  { id: 'daily_read', title: '阅读今日推荐', description: '浏览一篇今日推荐文章', reward: 15, kind: 'daily' },
  { id: 'daily_share', title: '分享给好友', description: '把应用分享给一位朋友', reward: 20, kind: 'daily' },
  { id: 'once_profile', title: '完善个人资料', description: '补充头像与简介（演示：点击即完成）', reward: 30, kind: 'once' },
  { id: 'once_guide', title: '阅读新手指南', description: '了解积分如何获取与使用', reward: 20, kind: 'once' },
  { id: 'once_follow', title: '关注官方账号', description: '第一时间获取活动消息', reward: 20, kind: 'once' },
] as const;

export const PRODUCTS = [
  { id: 'ebook', name: '数字手册', description: '一本电子手册的兑换码', price: 100, fulfillment: 'external', external: 'ebook' },
  { id: 'theme', name: '主题包', description: '一套界面主题的兑换码', price: 150, fulfillment: 'external', external: 'theme' },
  { id: 'course', name: '课程权限', description: '一门在线课程的访问兑换码', price: 300, fulfillment: 'external', external: 'course' },
  { id: 'avatar_frame', name: '头像框 · 极光', description: '站内权益，兑换后立即生效', price: 60, fulfillment: 'internal', external: null },
  { id: 'name_color', name: '昵称高亮', description: '站内权益，兑换后立即生效', price: 40, fulfillment: 'internal', external: null },
] as const;

export const SEED_USERS = [
  { username: 'alice', password: 'alice123', grant: 300 },
  { username: 'bob', password: 'bob123', grant: 60 },
] as const;

/** 可重复执行：任务/商品按 id upsert；测试账户已存在则跳过。 */
export async function seed(db: Db, log: (msg: string) => void = () => {}): Promise<void> {
  await withTx(db, async (tx) => {
    for (const [i, t] of TASKS.entries()) {
      await tx.query(
        `INSERT INTO tasks (id, title, description, reward, kind, sort_order) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET title=$2, description=$3, reward=$4, kind=$5, sort_order=$6`,
        [t.id, t.title, t.description, t.reward, t.kind, i],
      );
    }
    for (const [i, p] of PRODUCTS.entries()) {
      await tx.query(
        `INSERT INTO products (id, name, description, price, fulfillment, external_product_id, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET name=$2, description=$3, price=$4, fulfillment=$5, external_product_id=$6, sort_order=$7`,
        [p.id, p.name, p.description, p.price, p.fulfillment, p.external, i],
      );
    }
    for (const u of SEED_USERS) {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO users (username, password_hash) VALUES ($1, $2) ON CONFLICT (username) DO NOTHING RETURNING id`,
        [u.username, await hashPassword(u.password)],
      );
      if (rows[0]) {
        await applyPoints(tx, { userId: rows[0].id, delta: u.grant, kind: 'seed_grant', description: '测试账户初始积分' });
        log(`created user ${u.username} / ${u.password} (${u.grant} 分)`);
      }
    }
  });
}
