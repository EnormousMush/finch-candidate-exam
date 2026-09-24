import { useEffect, useState } from 'react';
import { api, type Order } from '../api';
import { useApp } from '../context';
import { CodeBox, StatusPill } from '../components';
import { explainOrder, fmtNum, fmtTime } from '../format';

const POLL_MS = 3000;

export function Orders() {
  const { refresh } = useApp();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    let lastSignature = '';
    // 有处理中的订单时每 3 秒刷新；订单状态一旦变化（发放/退款会影响余额），同步刷新顶部概览
    const load = async () => {
      const r = await api.orders().catch(() => null);
      if (!alive) return;
      if (r) {
        const signature = r.orders.map((o) => `${o.id}:${o.status}`).join(',');
        if (signature !== lastSignature) refresh();
        lastSignature = signature;
        setOrders(r.orders);
      }
      const pending = r ? r.orders.some((o) => o.status === 'processing') : true;
      timer = window.setTimeout(load, pending ? POLL_MS : POLL_MS * 5);
      tick((n) => n + 1);
    };
    load();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [refresh]);

  return (
    <>
      <div className="section-head">
        <h2>兑换记录</h2>
        <span className="hint">处理中的订单会自动刷新</span>
      </div>
      <div className="list orders">
        <div className="row head"><div>商品</div><div>状态</div><div>兑换码 / 说明</div><div style={{ textAlign: 'right' }}>积分</div></div>
        {orders?.length === 0 && <div className="empty">还没有兑换记录，去商城看看吧</div>}
        {orders?.map((o) => (
          <div key={o.id} className="row">
            <div>
              <div className="order-title">{o.productName}</div>
              <div className="order-sub num">{fmtTime(o.createdAt)} · <span className="mono">{o.id}</span></div>
            </div>
            <div><StatusPill status={o.status} /></div>
            <div className="order-detail">
              {o.code ? <CodeBox code={o.code} /> : explainOrder(o)}
            </div>
            <div className="num" style={{ textAlign: 'right' }}>
              {o.status === 'failed' ? <span className="faint" style={{ textDecoration: 'line-through' }}>−{fmtNum(o.price)}</span> : `−${fmtNum(o.price)}`}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
