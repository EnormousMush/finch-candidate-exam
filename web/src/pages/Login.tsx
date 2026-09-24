import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';

export function Login({ onDone }: { onDone: () => Promise<void> }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e?: FormEvent, creds?: { u: string; p: string }) => {
    e?.preventDefault();
    setBusy(true);
    setError('');
    try {
      const u = creds?.u ?? username.trim();
      const p = creds?.p ?? password;
      if (mode === 'register' && !creds) await api.register(u, p);
      else await api.login(u, p);
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误，请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand"><span className="brand-mark" />积分兑换</div>
        <h1>{mode === 'login' ? '欢迎回来' : '创建账户'}</h1>
        <div className="muted" style={{ fontSize: 14 }}>完成任务赚积分，兑换数字商品。</div>

        <div className="seg">
          <button type="button" className={mode === 'login' ? 'on' : ''} onClick={() => { setMode('login'); setError(''); }}>登录</button>
          <button type="button" className={mode === 'register' ? 'on' : ''} onClick={() => { setMode('register'); setError(''); }}>注册</button>
        </div>

        <label className="field">
          <span>用户名</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" placeholder="3–20 位字母、数字或下划线" required />
        </label>
        <label className="field">
          <span>密码</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'} placeholder="至少 6 位" required />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="btn primary block" disabled={busy}>
          {busy && <span className="spinner" />}{mode === 'login' ? '登录' : '注册并领取 20 积分'}
        </button>

        <div className="demo">
          测试账户：
          <button type="button" disabled={busy} onClick={() => submit(undefined, { u: 'alice', p: 'alice123' })}>alice</button>
          {' / '}
          <button type="button" disabled={busy} onClick={() => submit(undefined, { u: 'bob', p: 'bob123' })}>bob</button>
          <span className="faint">（密码 alice123 / bob123）</span>
        </div>
      </form>
    </div>
  );
}
