import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`缺少环境变量 ${name}，请参考 .env.example`);
  return v;
}

export const config = {
  databaseUrl: () => required('DATABASE_URL'),
  goodsBaseUrl: () => process.env.DIGITAL_GOODS_BASE_URL ?? 'https://digital-goods-api.vercel.app',
  goodsApiKey: () => required('DIGITAL_GOODS_API_KEY'),
  port: Number(process.env.PORT ?? 3000),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
};
