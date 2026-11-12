import { useEffect, useId, useRef, useState } from 'react';
import { managementConflict, type ManagementAction, type ManagementData, type SavedView, type SkillViewFilters, type ToolViewFilters } from './management-data';

export type SavedViewsProps = {
  data: ManagementData | null; action: ManagementAction; onChanged: (data: ManagementData) => void; readOnly?: boolean;
} & ({ view: 'skills'; filters: SkillViewFilters; onApply: (filters: SkillViewFilters) => void }
  | { view: 'tools'; filters: ToolViewFilters; onApply: (filters: ToolViewFilters) => void });
type Draft = { id?: string; revision: number; name: string; filters: SkillViewFilters | ToolViewFilters };

export function SavedViews(props: SavedViewsProps) { return <SavedViewsEditor key={props.view} {...props} />; }

function SavedViewsEditor(props: SavedViewsProps) {
  const { data, action, onChanged, readOnly = false } = props;
  const [selectedId, setSelectedId] = useState(''), [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [conflict, setConflict] = useState(false), [notice, setNotice] = useState('');
  const lock = useRef(false), alive = useRef(true), restoreFocus = useRef(false), nameInput = useRef<HTMLInputElement>(null), origin = useRef<HTMLButtonElement | null>(null), viewSelect = useRef<HTMLSelectElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const editorId = useId();
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (draft) nameInput.current?.focus(); }, [draft?.id, !!draft]);
  useEffect(() => { if (!draft && !busy && restoreFocus.current) { restoreFocus.current = false; (origin.current?.isConnected ? origin.current : viewSelect.current || createButton.current)?.focus(); } }, [!!draft, busy]);
  const views = data?.savedViews.filter(item => item.view === props.view) || [];
  const selected = views.find(item => item.id === selectedId);
  const editing = draft?.id ? views.find(item => item.id === draft.id) : undefined;
  const changedElsewhere = !!draft && (conflict || !!draft.id && editing?.revision !== draft.revision);
  function begin(view: SavedView | undefined, button: HTMLButtonElement) {
    if (readOnly || !data || lock.current) return;
    origin.current = button;
    setDraft(view ? { id: view.id, revision: view.revision, name: view.name, filters: { ...view.filters } } : { revision: 0, name: '', filters: { ...props.filters } });
    setConflict(false); setError(''); setNotice('');
  }
  function close() { if (!lock.current) { restoreFocus.current = true; setDraft(null); } }
  function apply() {
    if (selected?.view === 'skills' && props.view === 'skills') props.onApply({ ...selected.filters });
    if (selected?.view === 'tools' && props.view === 'tools') props.onApply({ ...selected.filters });
  }
  async function mutate(remove = false) {
    if (readOnly || !data || !draft || changedElsewhere || lock.current || (remove ? !draft.id : !draft.name.trim() || draft.name.length > 80)) return;
    const previousIds = new Set(data.savedViews.map(item => item.id));
    lock.current = true; setBusy(true); setError('');
    try {
      const result = await action(remove ? '删除保存的视图' : '保存筛选视图', remove ? 'saved_view_remove' : 'saved_view_save', remove
        ? { id: draft.id, expectedRevision: draft.revision }
        : { ...(draft.id ? { id: draft.id } : {}), expectedRevision: draft.revision, name: draft.name.trim(), view: props.view, filters: { ...draft.filters } });
      onChanged(result);
      if (alive.current) {
        // Names are not unique. Select a created row only when its identity can be established.
        const created = !remove && !draft.id ? result.savedViews.filter(item => !previousIds.has(item.id)
          && item.view === props.view && item.name === draft.name.trim()
          && Object.entries(draft.filters).every(([key, value]) => Reflect.get(item.filters, key) === value)) : [];
        const nextId = remove ? '' : draft.id || (created.length === 1 ? created[0].id : '');
        restoreFocus.current = true; setDraft(null); setSelectedId(nextId);
        setNotice(remove ? '已删除保存的视图。' : nextId ? '视图已保存。' : '视图已保存；请在列表中选择要应用的视图。');
      }
    } catch (cause) { if (alive.current) { setError(String(cause)); setConflict(managementConflict(cause)); } }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  async function reload() {
    if (lock.current || !draft) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const result = await action('重新读取保存的视图', 'management_data', {});
      onChanged(result);
      if (alive.current) {
        const current = result.savedViews.find(item => item.id === draft.id && item.view === props.view);
        if (draft.id && !current) { restoreFocus.current = true; setDraft(null); setSelectedId(''); setNotice('此视图已被删除。'); }
        else if (current) { setDraft({ id: current.id, revision: current.revision, name: current.name, filters: { ...current.filters } }); setNotice('已读取最新内容。'); }
        setConflict(false);
      }
    } catch (cause) { if (alive.current) setError(String(cause)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  return <section className="saved-views" aria-label="保存的视图" data-expanded={!!draft || !!error || !!notice || undefined}>
    <div className="management-data-toolbar">
      {views.length > 0 && <><select ref={viewSelect} aria-label="保存的视图" value={selected?.id || ''} disabled={!data || busy || !!draft} onChange={event => { setSelectedId(event.target.value); setNotice(''); }}><option value="">选择保存的视图</option>{views.map(view => <option key={view.id} value={view.id}>{view.name}</option>)}</select>
      <button type="button" className="button" disabled={!selected || busy || !!draft} onClick={apply}>应用视图</button></>}
      {!readOnly && <><button ref={createButton} type="button" className="button" disabled={!data || busy || !!draft} aria-expanded={!!draft && !draft.id} aria-controls={editorId} onClick={event => begin(undefined, event.currentTarget)}>保存当前视图</button>
        {selected && <button type="button" className="button" disabled={busy || !!draft} aria-expanded={!!draft?.id} aria-controls={editorId} onClick={event => begin(selected, event.currentTarget)}>编辑视图</button>}</>}
    </div>
    {draft && !readOnly && <div id={editorId} className="management-data-editor">
      <label>视图名称<input ref={nameInput} aria-label="视图名称" maxLength={80} value={draft.name} disabled={busy} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <p className="management-data-help">{draft.id ? '保存名称时会保留已有筛选条件；需要更新条件时，先使用下方按钮。' : '将保存打开此编辑区时的筛选条件。'}</p>
      <button type="button" className="button" disabled={busy || changedElsewhere} onClick={() => setDraft({ ...draft, filters: { ...props.filters } })}>使用当前筛选条件</button>
      {changedElsewhere && <p role="alert" className="management-data-help">视图已在其他位置更改。草稿已保留，请重新读取后再编辑。</p>}
      <div className="management-data-actions"><button type="button" className="button primary" disabled={busy || changedElsewhere || !draft.name.trim() || draft.name.length > 80 || !data} onClick={() => void mutate()}>保存视图</button>
        {draft.id && <button type="button" className="button" disabled={busy || changedElsewhere || !data} onClick={() => void mutate(true)}>删除视图</button>}
        {(changedElsewhere || error) && <button type="button" className="button" disabled={busy} onClick={() => void reload()}>重新读取（替换草稿）</button>}
        <button type="button" className="button" disabled={busy} onClick={close}>取消</button></div>
    </div>}
    {error && <p role="alert" className="management-data-error">{error}</p>}
    {notice && <p role="status" className="management-data-help">{notice}</p>}
  </section>;
}
