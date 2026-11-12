import { useEffect, useId, useRef, useState } from 'react';
import { managementConflict, type ManagementAction, type ManagementData, type SkillAnnotation } from './management-data';

export type SkillMetadataProps = {
  skillId: string; originalName: string; data: ManagementData | null;
  action: ManagementAction; onChanged: (data: ManagementData) => void; readOnly?: boolean;
};

export function SkillMetadata(props: SkillMetadataProps) { return <SkillMetadataEditor key={props.skillId} {...props} />; }

function SkillMetadataEditor({ skillId, originalName, data, action, onChanged, readOnly = false }: SkillMetadataProps) {
  const current = data?.skillAnnotations.find(item => item.skillId === skillId);
  const blank = (): SkillAnnotation => ({ skillId, revision: 0, alias: '', notes: '' });
  const [expanded, setExpanded] = useState(false), [draft, setDraft] = useState<SkillAnnotation>(() => current || blank());
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [conflict, setConflict] = useState(false), [notice, setNotice] = useState('');
  const lock = useRef(false), alive = useRef(true), restoreFocus = useRef(false), toggle = useRef<HTMLButtonElement>(null), aliasInput = useRef<HTMLInputElement>(null);
  const editorId = useId();
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (expanded && !readOnly) aliasInput.current?.focus(); }, [expanded, readOnly]);
  useEffect(() => { if (!expanded && !busy && restoreFocus.current) { restoreFocus.current = false; toggle.current?.focus(); } }, [expanded, busy]);
  const changedElsewhere = expanded && (conflict || (current?.revision ?? 0) !== draft.revision);
  function open() { setDraft(current || blank()); setError(''); setConflict(false); setNotice(''); setExpanded(true); }
  function close() { if (!lock.current) { restoreFocus.current = true; setExpanded(false); } }
  async function save() {
    if (readOnly || !data || changedElsewhere || lock.current || draft.alias.length > 160 || draft.notes.length > 4000) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const result = await action('保存 Skill 别名与备注', 'skill_annotation_set', { skillId, expectedRevision: draft.revision, alias: draft.alias.trim(), notes: draft.notes });
      onChanged(result);
      if (alive.current) { restoreFocus.current = true; setExpanded(false); setNotice('别名与备注已保存。'); }
    } catch (cause) { if (alive.current) { setError(String(cause)); setConflict(managementConflict(cause)); } }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  async function reload() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const result = await action('重新读取 Skill 别名与备注', 'management_data', {});
      onChanged(result);
      if (alive.current) { setDraft(result.skillAnnotations.find(item => item.skillId === skillId) || blank()); setConflict(false); setNotice('已读取最新内容。'); }
    } catch (cause) { if (alive.current) setError(String(cause)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  return <section className="skill-metadata" aria-label="Skill 别名与备注">
    <div className="management-data-toolbar">
      <button ref={toggle} type="button" className="button" aria-expanded={expanded} aria-controls={editorId} disabled={!data || busy} onClick={() => expanded ? close() : open()}>别名与备注</button>
      {!expanded && <span className="management-data-summary">{current?.alias || (current?.notes ? '已添加备注' : '尚未设置')}</span>}
    </div>
    {expanded && <div id={editorId} className="management-data-editor">
      <p className="management-data-help">原名：{originalName}。别名仅用于管理器内显示。</p>
      {readOnly ? <dl className="management-data-preview"><dt>别名</dt><dd>{current?.alias || '未设置'}</dd><dt>备注</dt><dd>{current?.notes || '未设置'}</dd></dl> : <>
        <label>别名<input ref={aliasInput} aria-label="Skill 别名" maxLength={160} value={draft.alias} disabled={busy} placeholder={originalName} onChange={event => setDraft({ ...draft, alias: event.target.value })} /></label>
        <label>备注<textarea aria-label="Skill 备注" maxLength={4000} rows={3} value={draft.notes} disabled={busy} onChange={event => setDraft({ ...draft, notes: event.target.value })} /></label>
        {changedElsewhere && <p role="alert" className="management-data-help">内容已在其他位置更改。草稿已保留，请重新读取后再编辑。</p>}
        <div className="management-data-actions"><button type="button" className="button primary" disabled={busy || changedElsewhere || !data || draft.alias.length > 160 || draft.notes.length > 4000} onClick={() => void save()}>保存别名与备注</button>
          {(changedElsewhere || error) && <button type="button" className="button" disabled={busy} onClick={() => void reload()}>重新读取（替换草稿）</button>}
          <button type="button" className="button" disabled={busy} onClick={close}>取消</button></div>
      </>}
    </div>}
    {error && <p role="alert" className="management-data-error">{error}</p>}
    {notice && <p role="status" className="management-data-help">{notice}</p>}
  </section>;
}
