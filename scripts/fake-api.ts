/**
 * 演示用「不靠谱」的外部 API：`pnpm dev:fake` 会让应用连到这里，
 * 可以在界面上看到超时、5xx、响应丢失、商品不可用等情况下的处理，而不消耗真实额度。
 */
import 'dotenv/config';
import { startFakeGoods, type Plan } from './fakeGoodsServer.js';

const port = Number(process.env.FAKE_API_PORT ?? 4010);

function chaos(nth: number): Plan | undefined {
  if (nth > 1) return Math.random() < 0.7 ? undefined : { commit: false, status: 503 }; // 重试大多会成功
  const r = Math.random();
  if (r < 0.45) return undefined;                                   // 正常
  if (r < 0.60) return { delayMs: 12_000 };                          // 很慢：同步等待超时，码其实已生成
  if (r < 0.75) return { commit: false, status: 503 };               // 服务错误，没生成码
  if (r < 0.87) return { commit: true, status: 500 };                // 码已生成，但响应丢了
  if (r < 0.95) return { commit: false, status: 422 };               // 商品不可用 → 应退款
  return { commit: false, status: 429, retryAfter: '5' };            // 限流
}

const fake = await startFakeGoods({
  port,
  apiKey: process.env.DIGITAL_GOODS_API_KEY ?? 'test-key',
  behavior: (req) => {
    const plan = req.method === 'POST' ? chaos(req.nth) : undefined;
    console.log(`${req.method} ${req.requestId} #${req.nth} →`, plan ?? 'ok');
    return plan;
  },
});
console.log(`fake digital-goods API listening on ${fake.url}`);
