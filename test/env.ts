import 'dotenv/config';

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('请在 .env 中设置 TEST_DATABASE_URL');
  // 防呆：测试会清空整个库，只允许名字以 _test 结尾的库
  if (!new URL(url).pathname.endsWith('_test')) throw new Error('TEST_DATABASE_URL 的库名必须以 _test 结尾');
  return url;
}
