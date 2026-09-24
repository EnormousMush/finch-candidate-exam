import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { withTx, type Db } from '../db/pool.js';
import { AppError } from '../errors.js';
import { applyPoints } from './points.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const SIGNUP_BONUS = 20;
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

export interface SessionUser {
  id: string;
  username: string;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, saltHex, keyHex] = stored.split('$');
  if (!saltHex || !keyHex) return false;
  const key = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  return timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}

function validateCredentials(username: string, password: string) {
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    throw new AppError(400, 'INVALID_USERNAME', '用户名需为 3–20 位字母、数字或下划线');
  }
  if (password.length < 6 || password.length > 72) {
    throw new AppError(400, 'INVALID_PASSWORD', '密码长度需为 6–72 位');
  }
}

/** 注册：建用户 + 发放新人积分，同一事务。 */
export async function register(db: Db, username: string, password: string): Promise<SessionUser> {
  validateCredentials(username, password);
  const hash = await hashPassword(password);
  try {
    return await withTx(db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
        [username, hash],
      );
      const id = rows[0]!.id;
      await applyPoints(tx, { userId: id, delta: SIGNUP_BONUS, kind: 'signup_bonus', description: '新用户注册奖励' });
      return { id, username };
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new AppError(409, 'USERNAME_TAKEN', '用户名已被占用');
    throw err;
  }
}

// 用户名不存在时也跑一次同样代价的哈希，让两种失败的响应时间一致，无法借此探测用户名
const DUMMY_HASH = `scrypt$${'00'.repeat(16)}$${'00'.repeat(64)}`;

export async function login(db: Db, username: string, password: string): Promise<SessionUser> {
  const { rows } = await db.query<{ id: string; username: string; password_hash: string }>(
    'SELECT id, username, password_hash FROM users WHERE username = $1',
    [username],
  );
  const user = rows[0];
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) throw new AppError(401, 'INVALID_CREDENTIALS', '用户名或密码错误');
  return { id: user.id, username: user.username };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function createSession(db: Db, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
    sha256(token), userId, expiresAt,
  ]);
  // 顺手清掉过期会话，表不会无限增长
  await db.query('DELETE FROM sessions WHERE expires_at < now()');
  return { token, expiresAt };
}

export async function findSessionUser(db: Db, token: string): Promise<SessionUser | null> {
  const { rows } = await db.query<SessionUser>(
    `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  return rows[0] ?? null;
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}
