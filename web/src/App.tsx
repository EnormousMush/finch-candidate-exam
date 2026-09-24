import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { api, ApiError, type Summary, type User } from './api';
import { Ctx } from './context';
import { fmtNum } from './format';
import { Login } from './pages/Login';
import { Tasks } from './pages/Tasks';
import { Shop } from './pages/Shop';
import { Orders } from './pages/Orders';
import { Ledger } from './pages/Ledger';

export function App() {
  const [session, setSession] = useState<{ user: User; summary: Summary } | null | undefined>(undefined);
  const [toastMsg, setToastMsg] = useState<{ msg: string; bad: boolean } | null>(null);
  const toastTimer = useRef<number>(undefined);

  // 刷新顶部概览。401 表示未登录；其他错误（网络抖动等）保留当前状态，不打断用户
  const refresh = useCallback(async () => {
    try {
      setSession(await api.me());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setSession(null);
    }
  }, []);

  useEffect(() => {
    refresh().finally(() => setSession((s) => (s === undefined ? null : s)));
  }, [refresh]);

  // 有处理中的订单时，不管在哪个页面都定时刷新概览：后台发放或退款会改变余额
  const processing = session?.summary.processing ?? 0;
  useEffect(() => {
    if (!processing) return;
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [processing, refresh]);

  const toast = useCallback((msg: string, bad = false) => {
    window.clearTimeout(toastTimer.current);
    setToastMsg({ msg, bad });
    toastTimer.current = window.setTimeout(() => setToastMsg(null), 2600);
  }, []);

  if (session === undefined) return null;
  if (session === null) return <Login onDone={refresh} />;

  const { user, summary } = session;
  const logout = async () => {
    await api.logout().catch(() => {});
    setSession(null);
  };

  return (
    <Ctx.Provider value={{ user, summary, refresh, toast }}>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand"><span className="brand-mark" />积分兑换</div>
          <nav className="nav">
            <NavLink to="/tasks">赚积分</NavLink>
            <NavLink to="/shop">兑换商城</NavLink>
            <NavLink to="/orders">兑换记录{summary.processing > 0 && <span className="dot" title="有处理中的订单" />}</NavLink>
            <NavLink to="/ledger">积分明细</NavLink>
          </nav>
          <div className="user">
            <span className="chip-balance num">{fmtNum(summary.balance)} 分</span>
            <span>{user.username}</span>
            <button className="btn ghost" onClick={logout}>退出</button>
          </div>
        </div>
      </header>

      <main className="page">
        <section className="hero">
          <div>
            <div className="label">当前积分</div>
            <div className="kpi num">{fmtNum(summary.balance)}<small>分</small></div>
          </div>
          <div className="band">
            <div><div className="label">今日任务所得</div><div className="v num">+{fmtNum(summary.earnedToday)}</div></div>
            <div><div className="label">累计获得</div><div className="v num">{fmtNum(summary.totalEarned)}</div></div>
            <div><div className="label">累计兑换</div><div className="v num">{fmtNum(summary.totalSpent)}</div></div>
            <div><div className="label">处理中</div><div className="v num" style={{ color: summary.processing ? 'var(--warn)' : undefined }}>{summary.processing}</div></div>
          </div>
        </section>

        <Routes>
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/shop" element={<Shop />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/ledger" element={<Ledger />} />
          <Route path="*" element={<Navigate to="/tasks" replace />} />
        </Routes>
      </main>

      {toastMsg && <div className={`toast${toastMsg.bad ? ' bad' : ''}`}>{toastMsg.msg}</div>}
    </Ctx.Provider>
  );
}
