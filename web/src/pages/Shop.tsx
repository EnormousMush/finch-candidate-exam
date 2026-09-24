import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, newIdempotencyKey, type Order, type Product } from '../api';
import { useApp } from '../context';
import { CodeBox, StatusPill } from '../components';
import { explainOrder, fmtNum } from '../format';

export function Shop() {
  const { summary } = useApp();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [selected, setSelected] = useState<Product | null>(null);

  useEffect(() => { api.products().then((r) => setProducts(r.products)); }, []);

  return (
    <>
      <div className="section-head"><h2>可兑换商品</h2><span className="hint">每次兑换一件，不限购</span></div>
      <div className="grid">
        {products?.map((p) => {
          const short = p.price - summary.balance;
          return (
            <div key={p.id} className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <h3>{p.name}</h3>
                <span className={`tag${p.fulfillment === 'external' ? ' accent' : ''}`}>
                  {p.fulfillment === 'external' ? '兑换码' : '站内权益'}
                </span>
              </div>
              <p>{p.description}</p>
              <div className="card-foot">
                <span className="price num">{fmtNum(p.price)}<small>积分</small></span>
                <button className="btn" disabled={short > 0} onClick={() => setSelected(p)}>
                  {short > 0 ? `还差 ${fmtNum(short)}` : '兑换'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {selected && <RedeemDialog product={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

/**
 * 幂等键在打开弹窗时生成：同一次「确认」无论双击还是网络失败后点重试，都复用同一个键，
 * 服务端只会生成一个订单。关闭弹窗再打开才算新的一次兑换。
 */
function RedeemDialog({ product, onClose }: { product: Product; onClose: () => void }) {
  const { refresh } = useApp();
  const [key] = useState(newIdempotencyKey);
  const [state, setState] = useState<'confirm' | 'submitting' | 'done' | 'error'>('confirm');
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<{ msg: string; retryable: boolean } | null>(null);

  const submit = async () => {
    setState('submitting');
    setError(null);
    try {
      const r = await api.redeem(product.id, key);
      setOrder(r.order);
      setState('done');
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) {
        setError({ msg: err.message, retryable: false });
      } else {
        // 网络错误或 5xx：不知道服务端是否已建单，用同一个幂等键重试是安全的
        setError({ msg: '网络异常，无法确认结果。可以放心重试，不会重复扣分。', retryable: true });
      }
      setState('error');
    } finally {
      refresh();
    }
  };

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && state !== 'submitting' && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true">
        <h3>兑换 {product.name}</h3>
        <div className="muted" style={{ fontSize: 14 }}>
          将消耗 <span className="num" style={{ color: 'var(--text)' }}>{fmtNum(product.price)}</span> 积分
          {product.fulfillment === 'external' ? '，兑换码由外部服务发放。' : '，站内权益兑换后立即生效。'}
        </div>

        {state === 'submitting' && (
          <div className="result"><span className="spinner" />正在兑换，外部服务可能需要几秒…</div>
        )}

        {state === 'done' && order && (
          <div className="result">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <StatusPill status={order.status} />
              <span className="faint mono" style={{ fontSize: 12 }}>{order.id}</span>
            </div>
            {order.code && <div style={{ marginBottom: 8 }}><CodeBox code={order.code} /></div>}
            <div className="muted" style={{ fontSize: 13 }}>
              {order.status === 'processing'
                ? '外部服务暂未返回结果，系统会在后台自动重试。你可以关闭此窗口，在「兑换记录」中查看进度。'
                : explainOrder(order)}
            </div>
          </div>
        )}

        {state === 'error' && error && (
          <div className="result" style={{ color: 'var(--bad)' }}>{error.msg}</div>
        )}

        <div className="actions">
          {state === 'confirm' && (
            <>
              <button className="btn ghost" onClick={onClose}>取消</button>
              <button className="btn primary" onClick={submit}>确认兑换</button>
            </>
          )}
          {state === 'error' && (
            <>
              <button className="btn ghost" onClick={onClose}>关闭</button>
              {error?.retryable && <button className="btn primary" onClick={submit}>重试</button>}
            </>
          )}
          {state === 'done' && (
            <>
              <Link className="btn ghost" to="/orders" onClick={onClose} style={{ textDecoration: 'none' }}>查看兑换记录</Link>
              <button className="btn primary" onClick={onClose}>完成</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
