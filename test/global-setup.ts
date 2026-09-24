import { createDb, ensureDatabase } from '../server/db/pool.js';
import { migrate } from '../server/db/migrate.js';
import { testDatabaseUrl } from './env.js';

/** 每次跑测试前：确保测试库存在，并从空库重新执行全部迁移。 */
export default async function setup() {
  const url = testDatabaseUrl();
  await ensureDatabase(url);
  const db = createDb(url);
  try {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
  } finally {
    await db.end();
  }
}
