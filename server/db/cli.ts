import { config } from '../config.js';
import { createDb, ensureDatabase } from './pool.js';
import { migrate } from './migrate.js';
import { seed } from './seed.js';

const commands = process.argv.slice(2);
const url = config.databaseUrl();
await ensureDatabase(url);
const db = createDb(url);
try {
  if (commands.includes('migrate')) await migrate(db, console.log);
  if (commands.includes('seed')) await seed(db, console.log);
  console.log('done');
} finally {
  await db.end();
}
