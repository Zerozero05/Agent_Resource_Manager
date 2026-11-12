import { useEffect, useRef, useState } from 'react';
import type { Resource, ResourceRun } from './resources';
import './resource-idle.css';

type Action = <T>(label: string, action: string, args: Record<string, unknown>) => Promise<T>;
type IdleAction = { actionId: string; label: string; mode: string; idleReleaseSafe: boolean; idleUsageTracked: boolean; idleTimeoutSeconds: number };
type IdleRun = ResourceRun & { keepAlive: boolean; activeUses: number; loginUses: number; idleEligible: boolean; lastActivityAt?: string; idleTimeoutSeconds: number; idleError?: string };
export type IdleSnapshot = { id: string; resourceRevision: number; actions: IdleAction[]; runs: IdleRun[] };
type Draft = { actionId: string; safe: boolean; tracked: boolean; minutes: string; revision: number };

export function ResourceIdleControls({ resource, action, onChanged, readOnly = false, visible = true }: {
  resource: Resource; action: Action; onChanged: () => void; readOnly?: boolean; visible?: boolean;
}) {
  const [expanded, setExpanded] = useState(false), [data, setData] = useState<IdleSnapshot | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const alive = useRef(true), pending = useRef(false), generation = useRef(0);
  const state = useRef({ id: resource.id, revision: resource.revision, visible, readOnly });
  state.current = { id: resource.id, revision: resource.revision, visible, readOnly };
  const actionRef = useRef(action); actionRef.current = action;
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  useEffect(() => {
    generation.current++; setData(null); setDraft(null); setError(''); setBusy(false); pending.current = false;
  }, [resource.id]);
  const stale = data !== null && data.resourceRevision !== resource.revision;
  async function load() {
    if (pending.current || !state.current.visible) return;
    const id = resource.id, revision = resource.revision, ticket = ++generation.current;
    pending.current = true; setBusy(true); setError('');
    try {
      const value = await actionRef.current<IdleSnapshot>('读取闲置设置', 'resource_idle', { id });
      if (!alive.current || ticket !== generation.current || state.current.id !== id || !state.current.visible) return;
      if (value.id !== id || value.resourceRevision !== revision || state.current.revision !== revision) throw new Error('工具设置已变化，请刷新工具后重新读取。');
      setData(value); setDraft(null);
    } catch (cause) {
      if (alive.current && ticket === generation.current && state.current.id === id && state.current.visible) setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      if (alive.current && ticket === generation.current) { pending.current = false; setBusy(false); }
    }
  }
  useEffect(() => {
    if (expanded && visible && !data && !pending.current) void load();
    // No automatic retries or background reads after a failed request.
  }, [expanded, visible, resource.id]);
  async function save() {
    if (!draft || !data || pending.current || readOnly || !visible || draft.revision !== resource.revision) return;
    const seconds = Number(draft.minutes) * 60;
    if (!draft.minutes.trim() || !Number.isInteger(seconds) || seconds < 0 || seconds > 86400) { setError('请输入 0 至 1440 分钟，精确到整秒；0 表示关闭。'); return; }
    const id = resource.id, ticket = ++generation.current;
    pending.current = true; setBusy(true); setError('');
    try {
      const value = await actionRef.current<IdleSnapshot>('保存闲置设置', 'resource_idle_set', { id, actionId: draft.actionId, expectedRevision: draft.revision, idleReleaseSafe: draft.safe, idleUsageTracked: draft.tracked, idleTimeoutSeconds: seconds });
      if (!alive.current || ticket !== generation.current || state.current.id !== id) return;
      if (value.id !== id || value.resourceRevision < draft.revision) throw new Error('返回的闲置设置不匹配，请重新读取。');
      setData(value); setDraft(null); onChanged();
    } catch (cause) { if (alive.current && ticket === generation.current && state.current.id === id) setError(String(cause instanceof Error ? cause.message : cause)); }
    finally { if (alive.current && ticket === generation.current) { pending.current = false; setBusy(false); } }
  }
  async function keep(run: IdleRun) {
    if (pending.current || readOnly || !visible) return;
    const id = resource.id, ticket = ++generation.current;
    pending.current = true; setBusy(true); setError('');
    try {
      const value = await actionRef.current<{ run: IdleRun }>('设置服务保活', 'resource_keep_alive', { runId: run.runId, enabled: !run.keepAlive });
      if (!alive.current || ticket !== generation.current || state.current.id !== id) return;
      if (value.run.runId !== run.runId || value.run.resourceId !== id) throw new Error('返回的服务不匹配，请重新读取。');
      setData(previous => previous ? { ...previous, runs: previous.runs.map(item => item.runId === run.runId ? value.run : item) } : previous);
    } catch (cause) { if (alive.current && ticket === generation.current && state.current.id === id) setError(String(cause instanceof Error ? cause.message : cause)); }
    finally { if (alive.current && ticket === generation.current) { pending.current = false; setBusy(false); } }
  }
  return <section className="resource-source resource-idle" aria-label="闲置释放与保活">
    <button type="button" className="text-button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>闲置与保活</button>
    {expanded && <>
      <p className="muted small-text">仅处理管理器拥有、已确认可安全停止且使用情况可跟踪的服务。默认闲置 10 分钟；正在调用、登录或明确保活时保持运行。</p>
      <button type="button" disabled={busy || !visible} onClick={() => void load()}>重新读取闲置状态</button>
      {busy && <p role="status">正在处理…</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {stale && <p role="alert">工具设置已变化，编辑内容保留。重新读取后才能保存。</p>}
      {data && <>
        {data.actions.filter(item => item.mode === 'service').map(item => <div className="resource-source-section" key={item.actionId}>
          <strong>{item.label}</strong><p>{item.idleReleaseSafe && item.idleUsageTracked && item.idleTimeoutSeconds > 0 ? `闲置 ${item.idleTimeoutSeconds / 60} 分钟后释放` : '保持运行，不自动释放'}</p>
          {!readOnly && <button type="button" disabled={busy || stale || !visible} onClick={() => { setError(''); setDraft({ actionId: item.actionId, safe: item.idleReleaseSafe, tracked: item.idleUsageTracked, minutes: String(item.idleTimeoutSeconds / 60), revision: data.resourceRevision }); }}>调整{item.label}的闲置设置</button>}
        </div>)}
        {!data.actions.some(item => item.mode === 'service') && <p className="muted">此工具尚未登记可管理的服务动作。</p>}
        {draft && <form onSubmit={event => { event.preventDefault(); void save(); }}>
          <label className="field-label">闲置分钟数<input type="number" min="0" max="1440" step="any" value={draft.minutes} disabled={busy || readOnly} onChange={event => setDraft({ ...draft, minutes: event.target.value })} /></label>
          <label><input type="checkbox" checked={draft.safe} disabled={busy || readOnly} onChange={event => setDraft({ ...draft, safe: event.target.checked })} />已确认此服务可以安全停止</label>
          <label><input type="checkbox" checked={draft.tracked} disabled={busy || readOnly} onChange={event => setDraft({ ...draft, tracked: event.target.checked })} />此服务的调用都由管理器跟踪</label>
          <p className="muted small-text">不能确认以上条件时保持关闭。0 分钟关闭自动释放；修改设置不会立即结束任务。</p>
          <div className="section-actions"><button type="submit" disabled={busy || readOnly || stale || !visible}>保存闲置设置</button><button type="button" disabled={busy} onClick={() => setDraft(null)}>取消编辑</button></div>
        </form>}
        {data.runs.filter(run => run.mode === 'service' && run.status === 'running').map(run => <div key={run.runId} className="resource-source-section">
          <strong>{data.actions.find(item => item.actionId === run.actionId)?.label || run.actionId}</strong>
          <p>{run.keepAlive ? '已明确保活' : run.activeUses > 0 || run.loginUses > 0 ? '有正在进行的使用' : run.idleEligible ? '按闲置设置管理' : '保持运行'} · 调用 {run.activeUses || 0} · 登录 {run.loginUses || 0}</p>
          {run.lastActivityAt && <small className="muted">最近活动：<time dateTime={run.lastActivityAt}>{run.lastActivityAt}</time></small>}
          {run.idleError && <p role="alert">{run.idleError}</p>}
          {!readOnly && <button type="button" disabled={busy || !visible} onClick={() => void keep(run)}>{run.keepAlive ? '解除明确保活' : '保持此服务运行'}</button>}
        </div>)}
      </>}
    </>}
  </section>;
}
