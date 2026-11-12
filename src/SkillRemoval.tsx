import { useEffect, useRef, useState } from 'react';
import { RemovalHistory, type RemovalHistoryRecord } from './RemovalHistory';
import './skill-removal.css';

type Entry = { path: string; relative?: string; remove?: boolean; reason?: string; expected?: unknown };
type Plan = { id: string; kind: string; skillId: string; extent: string; targetPath?: string; entries: Entry[]; linkEntries: Entry[]; canApply: boolean; warnings: string[] };
type Action = <T>(label: string, command: string, args: Record<string, unknown>) => Promise<T>;
type Props = { skillId: string; name: string; action: Action; revision: number; readOnly?: boolean; visible?: boolean; lastRemoval?: RemovalHistoryRecord; onChanged: () => void };
const extents = { disable: '停用／断开连接，保留文件', runtime: '卸载运行部分，保留本地改造与数据', full: '完整卸载已核实归属的内容', custom: '自定义文件范围' };

export function SkillRemoval({ skillId, name, action, revision, readOnly = false, visible = true, lastRemoval, onChanged }: Props) {
  const [opened, setOpened] = useState(false), [extent, setExtent] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null), [candidates, setCandidates] = useState<Entry[]>([]), [files, setFiles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const pending = useRef(false), allowed = useRef(false), generation = useRef(0), source = useRef<HTMLButtonElement>(null);
  const expected = useRef({ skillId, revision });
  allowed.current = visible && !readOnly;
  useEffect(() => {
    if (expected.current.skillId !== skillId || expected.current.revision !== revision) {
      expected.current = { skillId, revision }; generation.current++; setPlan(null);
    }
  }, [skillId, revision]);
  useEffect(() => { if (!visible || readOnly) { generation.current++; setPlan(null); } }, [visible, readOnly]);
  useEffect(() => () => { generation.current++; allowed.current = false; }, []);
  async function run(work: (current: () => boolean) => Promise<void>) {
    if (!allowed.current || pending.current) return;
    pending.current = true; setBusy(true); setError(''); const request = ++generation.current;
    const current = () => request === generation.current && allowed.current;
    try { await work(current); } catch (cause) { if (current()) { setError(cause instanceof Error ? cause.message : String(cause)); setPlan(null); } }
    finally { pending.current = false; setBusy(false); }
  }
  function reset() { generation.current++; setOpened(true); setExtent(''); setPlan(null); setCandidates([]); setFiles([]); setNotice(''); setError(''); }
  function preview() {
    if (!extent) return;
    return run(async current => {
      const result = await action<Plan>('核对本次 Skill 卸载范围', 'preview_skill_remove', { skillId, extent, customFiles: extent === 'custom' ? files : [] });
      if (current()) { setPlan(result); setCandidates(result.entries); }
    });
  }
  function apply() {
    if (!plan?.canApply) return;
    const chosen = plan;
    return run(async current => {
      const result = await action<{ complete: boolean; result?: { failures?: [string, string][] }; warnings?: string[] }>('处理已确认的 Skill 卸载范围', 'apply_skill_remove', { previewId: chosen.id });
      if (current()) {
        setPlan(null); setExtent(''); setFiles([]); setCandidates([]); onChanged();
        setNotice(result.complete ? '本次所选范围已处理，来源关联和结果记录保留。' : '本次未完整完成，已保留剩余归属记录；再次处理需重新选择程度并预览。');
        const issues = [...(result.warnings || []), ...(result.result?.failures || []).map(([path, reason]) => `${path}：${reason}`)];
        if (issues.length) setError(issues.join('\n'));
      }
    });
  }
  const disabled = busy || readOnly || !visible;
  return <section className="skill-removal" aria-label="Skill 卸载与停用">
    <button type="button" ref={source} disabled={disabled} onClick={reset}>卸载或停用 Skill</button>
    {visible && !notice && <RemovalHistory record={lastRemoval} />}
    {opened && <div className="skill-removal-panel">
      <div className="skill-removal-heading"><h3>{name} · 卸载或停用</h3><button type="button" disabled={busy} onClick={() => { generation.current++; setOpened(false); setPlan(null); source.current?.focus(); }}>关闭</button></div>
      <label>本次处理程度<select aria-label="Skill 本次处理程度" value={extent} disabled={disabled} onChange={event => { setExtent(event.target.value); setPlan(null); setCandidates([]); setFiles([]); setNotice(''); }}><option value="">请选择</option>{Object.entries(extents).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      {error && <p role="alert" className="inline-error">{error}</p>}{notice && <p role="status">{notice}</p>}
      {extent === 'custom' && candidates.length > 0 && <div className="skill-removal-files">{candidates.map(entry => <label key={entry.relative || entry.path}><input type="checkbox" aria-label={`卸载 ${entry.relative || entry.path}`} checked={files.includes(entry.relative || entry.path)} disabled={disabled || !entry.expected} onChange={event => { const key = entry.relative || entry.path; setFiles(old => event.target.checked ? [...old, key] : old.filter(value => value !== key)); setPlan(null); }} /><span>{entry.path}</span></label>)}</div>}
      <button type="button" disabled={disabled || !extent} onClick={() => void preview()}>{extent === 'custom' && !candidates.length ? '读取可选择范围' : '预览本次影响'}</button>
      {plan && <section className="skill-removal-plan" aria-label="Skill 卸载影响清单">
        {plan.targetPath && <p className="monospace">{plan.targetPath}</p>}{plan.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
        <ul>{[...plan.entries, ...plan.linkEntries].map((entry, index) => <li key={`${entry.path}-${index}`}><strong>{entry.remove ? '拟处理' : '保留'}</strong><span>{entry.path}</span><small>{entry.reason}</small></li>)}</ul>
        <button type="button" disabled={disabled || !plan.canApply} onClick={() => void apply()}>确认按此清单处理 Skill</button>
      </section>}
    </div>}
  </section>;
}
