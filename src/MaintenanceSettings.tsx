import { useEffect, useRef, useState } from 'react';
import { Clock3 } from 'lucide-react';
import { observeMaintenanceClock } from './maintenance-clock';
import './maintenance.css';

export type MaintenanceState = {
  revision: number; valid: boolean; pausedManually: boolean; pauseUntil: string | null;
  window: { startMinute: number; endMinute: number } | null;
  automaticAllowed: boolean; reason: string;
};
type WindowDraft = { revision: number; enabled: boolean; start: string; end: string };
function clockText(minute: number) { return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`; }
function windowDraft(state: MaintenanceState): WindowDraft {
  return { revision: state.revision, enabled: state.window !== null, start: clockText(state.window?.startMinute ?? 540), end: clockText(state.window?.endMinute ?? 1080) };
}
function minute(value: string) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hours, minutes] = value.split(':').map(Number); return hours * 60 + minutes;
}

function maintenanceStatus(state: MaintenanceState | undefined, disabled: boolean, now: number): { text: string; nextChange?: number; clockSensitive?: boolean } {
  if (!state) return { text: '正在读取维护设置…' };
  if (!state.valid) return { text: state.reason ? `自动维护保持暂停：${state.reason}` : '维护记录无法读取，自动维护保持暂停。' };
  if (disabled) return { text: '当前模式不执行自动维护；维护设置仅供查看。' };
  const until = state.pauseUntil === null ? null : Date.parse(state.pauseUntil);
  const window = state.window;
  if (until !== null && (!Number.isFinite(until) || state.pausedManually)
    || window && (![window.startMinute, window.endMinute].every(value => Number.isInteger(value) && value >= 0 && value < 1440) || window.startMinute === window.endMinute)) {
    return { text: '维护设置无效，自动维护保持暂停。' };
  }
  if (state.pausedManually) return { text: '已暂停自动维护，等待手动恢复。' };
  if (until !== null && until > now) return { text: '自动维护仍在定时暂停期间。', nextChange: until, clockSensitive: true };
  if (!window) return { text: '自动维护可按各项策略运行。', clockSensitive: until !== null };
  const local = new Date(now), currentMinute = local.getHours() * 60 + local.getMinutes();
  const inside = window.startMinute < window.endMinute
    ? currentMinute >= window.startMinute && currentMinute < window.endMinute
    : currentMinute >= window.startMinute || currentMinute < window.endMinute;
  const boundary = inside ? window.endMinute : window.startMinute;
  const next = new Date(now); next.setHours(Math.floor(boundary / 60), boundary % 60, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return { text: inside ? '当前在维护时间窗口内，自动维护可按各项策略运行。' : '当前不在自动维护时间窗口内。', nextChange: next.getTime(), clockSensitive: true };
}

export function MaintenanceSettings({ state, disabled = false, visible = true, onSave }: {
  state?: MaintenanceState; disabled?: boolean; visible?: boolean; onSave: (request: Record<string, unknown>) => Promise<{ maintenance?: MaintenanceState }>;
}) {
  const [now, setNow] = useState(Date.now);
  const [pause, setPause] = useState('hour');
  const [draft, setDraft] = useState<WindowDraft | null>(() => state ? windowDraft(state) : null);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const inFlight = useRef(false), alive = useRef(true), latestState = useRef(state); latestState.current = state;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (state && !dirty) setDraft(current => !current || state.revision >= current.revision ? windowDraft(state) : current); }, [state, dirty]);
  useEffect(() => {
    if (!visible) return;
    let timer: number | undefined;
    const refresh = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      const current = Date.now(); setNow(current);
      if (document.hidden) return;
      const next = maintenanceStatus(state, disabled, current).nextChange;
      if (next !== undefined) timer = window.setTimeout(refresh, Math.min(2_147_483_647, Math.max(1, next - current)));
    };
    refresh();
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    const stopClock = maintenanceStatus(state, disabled, Date.now()).clockSensitive ? observeMaintenanceClock(document, window, refresh) : () => {};
    return () => { stopClock(); if (timer !== undefined) window.clearTimeout(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [state, disabled, visible]);
  const status = maintenanceStatus(state, disabled, now);
  const paused = !!state && (state.pausedManually || state.pauseUntil !== null && Date.parse(state.pauseUntil) > now);
  const stale = !!state && !!draft && dirty && state.revision > draft.revision;
  const unavailable = disabled || busy || !state;
  async function save(request: Record<string, unknown>) {
    if (disabled || !state || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await onSave({ expectedRevision: state.revision, ...request });
      if (alive.current) {
        let newerWindow = false;
        if ('window' in request) {
          const saved = result.maintenance;
          newerWindow = !!saved && !!latestState.current && latestState.current.revision > saved.revision;
          if (saved) setDraft(windowDraft(newerWindow ? latestState.current! : saved));
          setDirty(false);
        }
        setNotice(newerWindow ? '本次保存已完成；另一窗口随后更新了设置，当前显示最新内容。' : '维护设置已保存；正在提交的任务会安全收尾。');
      }
    } catch (cause) { if (alive.current) setError(String(cause)); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  function saveWindow() {
    if (!draft || stale) return;
    const startMinute = minute(draft.start), endMinute = minute(draft.end);
    if (draft.enabled && (startMinute === null || endMinute === null || startMinute === endMinute)) {
      setError('请选择有效且不同的开始、结束时间。'); return;
    }
    void save({ expectedRevision: draft.revision, window: draft.enabled ? { startMinute, endMinute } : null });
  }
  function editWindow(change: Partial<WindowDraft>) {
    if (!draft) return;
    setDraft({ ...draft, ...change }); setDirty(true); setNotice('');
  }
  return <section className="card maintenance-settings" aria-label="自动维护设置">
    <div className="card-header"><div><h2 data-outline-key="settings:maintenance" data-outline-label="自动维护" data-outline-level="2">自动维护</h2><p>所有窗口共用；暂停或时间窗口不影响手动检查。</p></div><Clock3 size={20} className="muted" /></div>
    <div className="maintenance-body">
    {state ? <p className="maintenance-status" role="status">{status.text}{state.pauseUntil && Number.isFinite(Date.parse(state.pauseUntil)) && <span>暂停截止：{new Date(state.pauseUntil).toLocaleString()}</span>}</p> : <p className="muted">{status.text}</p>}
    {state && !state.valid ? <div className="maintenance-invalid"><p>维护记录无法读取，自动维护保持暂停。可明确重设为暂停，之后再设置运行时间。</p><button className="button" disabled={unavailable} onClick={() => void save({ pause: 'manual', window: null })}>重设为暂停维护</button></div> : <>
      <div className="maintenance-pause"><label className="setting-row"><span className="setting-copy"><strong>暂停时长</strong></span><select value={pause} disabled={unavailable} onChange={event => setPause(event.target.value)}><option value="hour">1 小时</option><option value="tomorrow">到明天零点</option><option value="manual">直到手动恢复</option></select></label><div className="maintenance-actions"><button className="button" disabled={unavailable} onClick={() => void save({ pause })}>暂停自动维护</button><button className="button ghost" disabled={unavailable || !paused} onClick={() => void save({ pause: 'resume' })}>恢复维护</button></div></div>
      <div className="maintenance-window"><label className="maintenance-window-toggle"><span className="setting-copy"><strong>每日维护时段</strong><small>开启后，仅在指定时间内自动维护。</small></span><input type="checkbox" checked={draft?.enabled ?? false} disabled={unavailable} onChange={event => editWindow({ enabled: event.target.checked })} /></label>
        {draft?.enabled && <div className="maintenance-time-range"><label>开始时间<input type="time" value={draft.start} disabled={unavailable} onChange={event => editWindow({ start: event.target.value })} /></label><span aria-hidden="true">—</span><label>结束时间<input type="time" value={draft.end} disabled={unavailable} onChange={event => editWindow({ end: event.target.value })} /></label></div>}
        <p className="muted small-text">使用本机时间，可跨午夜；结束时已进入提交阶段的任务会安全完成。</p>
        {stale && <p className="helper-note" role="alert">另一窗口已修改维护设置，当前草稿保留。<button className="text-button" disabled={unavailable} onClick={() => { if (state) setDraft(windowDraft(state)); setDirty(false); setError(''); }}>读取当前设置</button></p>}
        <button className="button" disabled={unavailable || !dirty || stale} onClick={saveWindow}>保存时间窗口</button>
      </div>
    </>}
    {disabled && <p className="muted small-text">当前模式无法更改维护设置。</p>}
    {error && <p className="error-text" role="alert">{error}</p>}{notice && <p className="helper-note" role="status">{notice}</p>}
    </div>
  </section>;
}
