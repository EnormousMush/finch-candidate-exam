import { useEffect, useState } from 'react';
import { api, type LedgerEntry } from '../api';
import { fmtNum, fmtTime } from '../format';

export function Ledger() {
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  useEffect(() => { api.ledger().then((r) => setEntries(r.entries)); }, []);

  return (
    <>
      <div className="section-head"><h2>积分明细</h2><span className="hint">每一次积分变动都有记录，余额 = 所有记录之和</span></div>
      <div className="list ledger">
        <div className="row head"><div>时间</div><div>说明</div><div className="amt">变动</div><div className="bal">余额</div></div>
        {entries?.length === 0 && <div className="empty">暂无记录</div>}
        {entries?.map((e) => (
          <div key={e.id} className="row">
            <div className="faint num">{fmtTime(e.createdAt)}</div>
            <div>{e.description}</div>
            <div className={`amt num ${e.delta > 0 ? 'plus' : 'minus'}`}>{e.delta > 0 ? '+' : '−'}{fmtNum(Math.abs(e.delta))}</div>
            <div className="bal num muted">{fmtNum(e.balanceAfter)}</div>
          </div>
        ))}
      </div>
    </>
  );
}
