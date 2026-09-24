import { useEffect, useState } from 'react';
import { api, ApiError, type Task } from '../api';
import { useApp } from '../context';

export function Tasks() {
  const { refresh, toast } = useApp();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => api.tasks().then((r) => setTasks(r.tasks));
  useEffect(() => { load(); }, []);

  const complete = async (t: Task) => {
    setBusy(t.id);
    try {
      const r = await api.completeTask(t.id);
      toast(`完成「${t.title}」，+${r.reward} 积分`);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '网络错误，请重试', true);
    } finally {
      setBusy(null);
      await Promise.all([load(), refresh()]);
    }
  };

  const groups: [string, string, Task['kind']][] = [
    ['每日任务', '每天 UTC 0 点刷新', 'daily'],
    ['新手任务', '每个账户限领一次', 'once'],
  ];

  return (
    <>
      {groups.map(([title, hint, kind]) => (
        <section key={kind}>
          <div className="section-head"><h2>{title}</h2><span className="hint">{hint}</span></div>
          <div className="grid">
            {tasks?.filter((t) => t.kind === kind).map((t) => (
              <div key={t.id} className={`card${t.completed ? ' done' : ''}`}>
                <h3>{t.title}</h3>
                <p>{t.description}</p>
                <div className="card-foot">
                  <span className="reward num">+{t.reward}</span>
                  <button className={`btn${t.completed ? '' : ' primary'}`} disabled={t.completed || busy === t.id} onClick={() => complete(t)}>
                    {t.completed ? (kind === 'daily' ? '今日已领' : '已完成') : busy === t.id ? '领取中…' : '完成并领取'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
