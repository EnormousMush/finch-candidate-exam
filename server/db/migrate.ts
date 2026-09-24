import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTx, type Db } from './pool.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** 按文件名顺序执行尚未执行过的 .sql 迁移，每个文件一个事务。 */
export async function migrate(db: Db, log: (msg: string) => void = () => {}): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await readFile(path.join(dir, file), 'utf8');
    await withTx(db, async (tx) => {
      // 锁表防止两个进程同时迁移
      await tx.query('LOCK TABLE schema_migrations IN EXCLUSIVE MODE');
      const { rowCount } = await tx.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (rowCount) return;
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
      log(`applied ${file}`);
    });
  }
}
