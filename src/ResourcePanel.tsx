import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { openPath, openUrl } from '@tauri-apps/plugin-opener';
import { Box, ChevronDown, ExternalLink, FolderOpen, Plus, RefreshCw, Search, X } from 'lucide-react';
import { preserveResourceOrder, queryResources, repositoryHref, resourceKinds, type Resource, type ResourceKind } from './resources';
import { ResourceActions } from './ResourceActions';
import { InstallResource, RemoveResource } from './ResourceLifecycle';
import { ResourceRepair } from './ResourceRepair';
import { ResourceUpdate } from './ResourceUpdate';
import { ResourceAutomation } from './ResourceAutomation';
import { ResourceRecovery } from './ResourceRecovery';
import { ResourceAdapters } from './ResourceAdapters';
import { ResourceRelocation } from './ResourceRelocation';
import { ResourceCapabilityEvidence } from './ResourceCapabilityEvidence';
import { ResourceRelations } from './ResourceRelations';
import { ResourceSource } from './ResourceSource';
import { ResourceIdleControls } from './ResourceIdleControls';
import { ResourceSpace } from './ResourceSpace';
import { SavedViews } from './SavedViews';
import { managementConflict, type ManagementAction, type ManagementData, type ToolViewFilters } from './management-data';
import { nearestSurvivingId } from './library-reading';
import { resourceEditorFields, restoreResourceOrder, type ResourceEditorFields, type ResourcePanelDraft } from './resource-panel-state';
import './resources.css';

type Action = <T>(label: string, action: string, args: Record<string, unknown>) => Promise<T>;
const scopeLabels: Record<string, string> = { register: '目录登记', ownedFiles: '已核对文件', full: '完整管理', managedFiles: '已登记文件' };
export function ResourcePanel({ action, revision = 0, focusResourceId, focusActionId, focusActionRevision, focusRequest = 0, filterRequest, readOnly = false, visible = true, embedded = false, initialDraft, onDraft, managementData = null, managementAction, onManagementChanged }: { action: Action; readOnly?: boolean; visible?: boolean; embedded?: boolean; initialDraft?: ResourcePanelDraft; onDraft?: (draft: ResourcePanelDraft) => void; revision?: number; focusResourceId?: string; focusActionId?: string; focusActionRevision?: number; focusRequest?: number; filterRequest?: { sequence: number; filters: ToolViewFilters }; managementData?: ManagementData | null; managementAction?: ManagementAction; onManagementChanged?: (data: ManagementData) => void }) {
  const initial = useRef(initialDraft);
  const [resources, setResources] = useState<Resource[]>([]);
  const [query, setQuery] = useState(initial.current?.query || ''), [kind, setKind] = useState<ToolViewFilters['kind']>(initial.current?.kind || '');
  const appliedFilterRequest = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!visible || !filterRequest || appliedFilterRequest.current === filterRequest.sequence) return;
    appliedFilterRequest.current = filterRequest.sequence;
    setQuery(filterRequest.filters.query);
    setKind(filterRequest.filters.kind);
  }, [visible, filterRequest]);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false), [editorConflict, setEditorConflict] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<string | null>(initial.current?.selectedId ?? null);
  const [editing, setEditing] = useState<{ id: string; revision: number | null } | 'new' | null>(() => {
    const editor = initial.current?.editor;
    return editor ? editor.resourceId === null ? 'new' : { id: editor.resourceId, revision: editor.expectedRevision } : null;
  });
  const [draft, setDraft] = useState<ResourceEditorFields>(() => initial.current?.editor ? { ...initial.current.editor.fields } : resourceEditorFields());
  const [lastFocusRequest, setLastFocusRequest] = useState(initial.current?.lastFocusRequest ?? null);
  const [activeAction, setActiveAction] = useState<{ resourceId: string; id?: string; revision?: number; request: number } | null>(null);
  const alive = useRef(true), generation = useRef(0), writeLock = useRef(false);
  const editorRead = useRef(0);
  const actionRef = useRef(action); actionRef.current = action;
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const onDraftRef = useRef(onDraft); onDraftRef.current = onDraft;
  const order = useRef(initial.current?.resourceOrder || []);
  const nameInput = useRef<HTMLInputElement>(null), returnFocus = useRef<HTMLElement | null>(null);
  const detailElement = useRef<HTMLElement>(null);
  const detailOrigin = useRef<HTMLElement | null>(null), pendingDetail = useRef<string | null>(null);
  const focusedRequest = useRef<string | null>(null), pendingFocus = useRef<string | null>(null);
  const shouldRestoreFocus = useRef(false);
  const focusAvailable = resources.some(resource => resource.id === focusResourceId);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  const reload = useCallback(async () => {
    if (!visibleRef.current) return;
    const request = ++generation.current;
    setLoading(true);
    try {
      const result = await actionRef.current<{ resources: Resource[] }>('读取工具目录', 'resource_list', {});
      if (alive.current && request === generation.current) {
        const previousOrder = order.current;
        const next = restoreResourceOrder(previousOrder, result.resources);
        order.current = next.map(resource => resource.id);
        setResources(next); setLoaded(true);
        setSelected(previous => previous === null ? null : nearestSurvivingId(previousOrder, order.current, previous) || null);
        setError(''); return next;
      }
    } catch (cause) {
      if (alive.current && request === generation.current) setError(String(cause));
    } finally {
      if (alive.current && request === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => { if (visible) void reload(); }, [reload, revision, visible]);
  useEffect(() => { if (visible && editing) nameInput.current?.focus(); }, [editing, visible]);
  useEffect(() => { if (visible && !editing && !busy && shouldRestoreFocus.current) { shouldRestoreFocus.current = false; returnFocus.current?.focus({ preventScroll: true }); } }, [editing, busy, visible]);
  useEffect(() => {
    if (!visible || !loaded || !focusResourceId || lastFocusRequest?.resourceId === focusResourceId && lastFocusRequest.request === focusRequest) return;
    setLastFocusRequest({ resourceId: focusResourceId, request: focusRequest });
    pendingDetail.current = null; detailOrigin.current = null;
    pendingFocus.current = `${focusResourceId}:${focusRequest}`;
    setActiveAction({ resourceId: focusResourceId, id: focusActionId, revision: focusActionRevision, request: focusRequest });
    setSelected(focusResourceId); setQuery(''); setKind('');
  }, [visible, loaded, focusResourceId, focusRequest, focusActionId, focusActionRevision, lastFocusRequest]);
  useEffect(() => {
    const request = `${focusResourceId}:${focusRequest}`;
    if (visible && pendingFocus.current === request && focusResourceId && selected === focusResourceId && focusAvailable && focusedRequest.current !== request && detailElement.current) {
      focusedRequest.current = request;
      pendingFocus.current = null;
      detailElement.current.scrollIntoView?.({ block: 'nearest' }); detailElement.current.focus({ preventScroll: true });
    }
  }, [selected, focusResourceId, focusRequest, focusAvailable, visible, activeAction]);
  useEffect(() => {
    if (!visible || !pendingDetail.current || selected !== pendingDetail.current || !detailElement.current) return;
    pendingDetail.current = null;
    detailElement.current.scrollIntoView?.({ block: 'start' }); detailElement.current.focus({ preventScroll: true });
  }, [selected, resources, visible]);
  useLayoutEffect(() => {
    if (loaded) order.current = resources.map(resource => resource.id);
    onDraftRef.current?.({ query, kind, selectedId: selected, resourceOrder: [...order.current], editor: editing ? { resourceId: editing === 'new' ? null : editing.id, expectedRevision: editing === 'new' ? null : editing.revision, fields: { ...draft } } : null, lastFocusRequest });
  }, [query, kind, selected, resources, loaded, editing, draft, lastFocusRequest]);
  const visibleResources = useMemo(() => queryResources(resources, query, kind), [resources, query, kind]);
  const detail = resources.find(resource => resource.id === selected);
  const editorCurrent = editing && editing !== 'new' ? resources.find(resource => resource.id === editing.id) : undefined;
  const staleEditor = editorConflict || !!editing && editing !== 'new' && loaded && editorCurrent?.revision !== editing.revision;
  function closeEditor() {
    if (writeLock.current) return;
    editorRead.current++;
    shouldRestoreFocus.current = true;
    setEditing(null);
  }
  function closeDetail() {
    pendingDetail.current = null; setSelected(null);
    if (detailOrigin.current?.isConnected) detailOrigin.current.focus({ preventScroll: true });
    detailOrigin.current = null;
  }
  function selectDetail(id: string, origin: HTMLElement) {
    if (selected === id) { closeDetail(); return; }
    detailOrigin.current = origin; pendingDetail.current = id; setSelected(id);
  }
  function edit(resource: Resource | 'new', origin: HTMLElement) {
    if (readOnly || !visible) return;
    editorRead.current++;
    returnFocus.current = origin;
    setDraft(resourceEditorFields(resource === 'new' ? undefined : resource));
    setEditing(resource === 'new' ? 'new' : { id: resource.id, revision: resource.revision }); setEditorConflict(false); setNotice(''); setError('');
  }
  async function reloadEditor() {
    if (readOnly || !visible || !editing || editing === 'new' || writeLock.current) return;
    const target = editing.id;
    const sequence = ++editorRead.current;
    const current = (await reload())?.find(resource => resource.id === target);
    if (current && alive.current && editorRead.current === sequence) { setDraft(resourceEditorFields(current)); setEditing({ id: current.id, revision: current.revision }); setEditorConflict(false); }
  }
  async function chooseFolder() {
    try {
      const chosen = await open({ directory: true, multiple: false, title: '选择工具现有目录' });
      if (typeof chosen === 'string' && alive.current) setDraft(previous => ({ ...previous, rootPath: chosen }));
    } catch (cause) { if (alive.current) setError(String(cause)); }
  }
  async function save() {
    if (readOnly || !visible || !loaded || loading || staleEditor || !editing || writeLock.current) return;
    writeLock.current = true; setBusy(true); setError('');
    try {
      const changes = { name: draft.name.trim(), alias: draft.alias.trim(), notes: draft.notes };
      const result = await actionRef.current<{ resource: Resource }>('保存工具信息', editing === 'new' ? 'resource_register' : 'resource_update', editing === 'new' ? { ...changes, kind: draft.kind, rootPath: draft.rootPath.trim(), repository: draft.repository.trim() || null, version: draft.version.trim() || null } : { id: editing.id, expectedRevision: editing.revision, changes });
      if (alive.current) {
        setResources(previous => preserveResourceOrder(previous, [...previous.filter(item => item.id !== result.resource.id), result.resource]));
        setSelected(result.resource.id); setEditing(null); setNotice(editing === 'new' ? '已登记原目录。' : '工具信息已保存。');
        shouldRestoreFocus.current = true;
      }
    } catch (cause) { if (alive.current) { setError(String(cause)); if (managementConflict(cause)) setEditorConflict(true); } }
    finally { writeLock.current = false; if (alive.current) setBusy(false); }
  }
  async function toggle(resource: Resource) {
    if (readOnly || !visible) return;
    if (writeLock.current) return;
    writeLock.current = true; setBusy(true); setError('');
    try {
      const result = await actionRef.current<{ resource: Resource }>('更新工具启用状态', 'resource_set_enabled', { id: resource.id, expectedRevision: resource.revision, enabled: !resource.enabled });
      if (alive.current) {
        setResources(previous => previous.map(item => item.id === result.resource.id ? result.resource : item));
        setNotice(result.resource.enabled ? '已启用管理入口。运行能力以验证结果为准。' : '已停用后续管理入口调用，现有任务和原生入口保持。');
      }
    } catch (cause) { if (alive.current) setError(String(cause)); }
    finally { writeLock.current = false; if (alive.current) setBusy(false); }
  }
  async function openSystemApps() {
    if (!visibleRef.current || writeLock.current) return;
    writeLock.current = true; setBusy(true); setError('');
    try { await actionRef.current('打开系统卸载设置', 'open_system_apps', {}); }
    catch (cause) { if (alive.current) setError(String(cause)); }
    finally { writeLock.current = false; if (alive.current) setBusy(false); }
  }
  async function openLocation(resource: Resource) {
    try { await openPath(resource.rootPath); } catch (cause) { if (alive.current) setError(`无法打开目录：${String(cause)}`); }
  }
  async function openRepository(resource: Resource) {
    const url = repositoryHref(resource.repository);
    if (!url) { setError('来源不是有效的 GitHub HTTPS 地址。'); return; }
    try { await openUrl(url); } catch (cause) { if (alive.current) setError(`无法打开来源：${String(cause)}`); }
  }
  const registerControl = <button className="button primary" onClick={event => edit('new', event.currentTarget)} disabled={readOnly || busy}><Plus size={16} />登记现有工具</button>;
  return <section className="resource-panel" aria-label="工具管理">
    {!embedded && <header className="resource-heading"><h1>工具</h1>{registerControl}</header>}
    {readOnly ? <p className="resource-notice" role="status">基本模式只读：可查看目录、来源、能力和运行记录；登记、安装、卸载与调用暂不可用。</p> : <InstallResource action={action} visible={visible} readOnly={readOnly} onInstalled={resource => { setResources(previous => preserveResourceOrder(previous, [...previous.filter(item => item.id !== resource.id), resource])); setSelected(resource.id); }} />}
    <div className="resource-toolbar">
      <label className="resource-search"><Search size={17} /><input aria-label="搜索工具" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称、别名、用途或来源" /></label>
      <select aria-label="工具类型" value={kind} onChange={event => setKind(event.target.value as ToolViewFilters['kind'])}><option value="">全部类型</option>{Object.entries(resourceKinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <button className="button" onClick={() => void reload()} disabled={loading || busy || !visible} aria-label="刷新工具目录"><RefreshCw size={16} />刷新</button><span className="resource-count">{visibleResources.length} 项</span>
      {(embedded || managementAction && onManagementChanged) && <div className="resource-toolbar-actions">
      {managementAction && onManagementChanged && <SavedViews view="tools" filters={{ query, kind }} data={managementData} action={managementAction} onChanged={onManagementChanged} readOnly={readOnly} onApply={filters => { setQuery(filters.query); setKind(filters.kind); }} />}
        {embedded && registerControl}
      </div>}
    </div>
    {error && <div className="resource-error" role="alert">{error}</div>}
    {notice && <div className="resource-notice" role="status">{notice}</div>}
    {editing && !readOnly && <form className="resource-editor" aria-label={editing === 'new' ? '登记工具' : '编辑工具信息'} onSubmit={event => { event.preventDefault(); void save(); }} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) { event.preventDefault(); return; } if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); closeEditor(); } }}>
      <div className="resource-editor-title"><h2>{editing === 'new' ? '登记现有工具' : '工具信息'}</h2><button className="button" type="button" onClick={closeEditor} disabled={readOnly || busy} aria-label="关闭编辑"><X size={17} /></button></div>
      {staleEditor && <p className="resource-error" role="alert">工具信息已变化或工具已移除，未提交内容仍保留。重新读取会替换当前草稿。<button className="button" type="button" disabled={loading || busy || !visible} onClick={() => void reloadEditor()}>重新读取（替换草稿）</button></p>}
      <fieldset disabled={readOnly || busy}><label>名称<input ref={nameInput} required maxLength={160} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
        {editing === 'new' && <><label>类型<select value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value as ResourceKind })}>{Object.entries(resourceKinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="resource-full">原目录<div className="resource-folder-input"><input required value={draft.rootPath} onChange={event => setDraft({ ...draft, rootPath: event.target.value })} placeholder="工具实际所在的完整路径" /><button className="button" type="button" onClick={() => void chooseFolder()}><FolderOpen size={16} />选择</button></div></label></>}
        {editing === 'new' ? <><label className="resource-full">GitHub 来源<input type="url" value={draft.repository} onChange={event => setDraft({ ...draft, repository: event.target.value })} placeholder="https://github.com/作者/仓库" /></label><label>已安装版本<input value={draft.version} onChange={event => setDraft({ ...draft, version: event.target.value })} placeholder="不确定时留空" /></label><p className="muted resource-full">手填来源和版本作为未验证的登记信息保存。</p></> : <div className="resource-full"><p>当前来源：{editorCurrent?.repository || '尚未关联'} · 已安装版本：{editorCurrent?.version || '尚未核实'}</p><p className="muted">此表只保存名称、别名和备注。来源变更请在工具详情的“来源与健康”中预览确认；旧草稿中的来源、版本不会随此表保存。</p></div>}<label>个人别名<input maxLength={160} value={draft.alias} onChange={event => setDraft({ ...draft, alias: event.target.value })} /></label>
        <label className="resource-full">用途备注<textarea maxLength={4000} value={draft.notes} onChange={event => setDraft({ ...draft, notes: event.target.value })} placeholder="记录用途与注意事项，请勿填写密码或令牌" /></label>
        {editing === 'new' && <div className="resource-full"><ResourceRecovery rootPath={draft.rootPath} action={action} visible={visible} readOnly={readOnly || busy} onUse={recovered => setDraft(previous => ({ ...previous, kind: recovered.kind, rootPath: recovered.rootPath, repository: recovered.repository || '', version: recovered.version || '' }))} /></div>}
        {editing === 'new' && <div className="resource-full"><ResourceAdapters rootPath={draft.rootPath} action={action} visible={visible} readOnly={readOnly || busy} onChanged={resource => {
          setResources(previous => preserveResourceOrder(previous, [...previous.filter(item => item.id !== resource.id), resource]));
          setSelected(resource.id); setEditing({ id: resource.id, revision: resource.revision }); setEditorConflict(false);
          setDraft(previous => ({ ...previous, name: previous.name || resource.name, kind: resource.kind, rootPath: resource.rootPath, repository: resource.repository || '', version: resource.version || '' }));
          setNotice('接管已保存；名称、别名和备注草稿仍保留，可继续保存。');
        }} /></div>}
      </fieldset><div className="resource-editor-actions"><button className="button" type="button" onClick={closeEditor} disabled={readOnly || busy}>取消</button><button className="button primary" type="submit" disabled={busy || !visible || !loaded || loading || staleEditor || !draft.name.trim() || (editing === 'new' && !draft.rootPath.trim())}>{busy ? '正在保存…' : '保存'}</button></div>
    </form>}
    <div className="resource-list" aria-busy={loading}>
      {visibleResources.map(resource => {
        const limitedByScene = resource.enabled && resource.effectiveEnabled === false;
        return <article className={`resource-row${selected === resource.id ? ' selected' : ''}`} key={resource.id}>
          <span className="resource-symbol"><Box size={21} /></span>
          <div className="resource-name">
            <button className="resource-name-button" onClick={event => selectDetail(resource.id, event.currentTarget)} aria-expanded={selected === resource.id} title={`${resource.alias || resource.name} · ${resource.rootPath}`}><span>{resource.alias || resource.name}</span><ChevronDown size={14} /></button>
            <div className="resource-name-meta">
              <span title={resource.repository || resourceKinds[resource.kind]}>{resource.alias ? resource.name + ' · ' : ''}{resourceKinds[resource.kind]}{resource.repository ? ` · ${resource.repository.replace('https://github.com/', '')}` : ''}</span>
              <code className="resource-directory" title={resource.rootPath}><bdi dir="ltr">{resource.rootPath}</bdi></code>
            </div>
          </div>
          <span className="resource-version" title={resource.version || '尚未登记版本'}>{resource.version || '—'}</span>
          <span className={`resource-state ${resource.enabled ? '' : 'off'}`} title={limitedByScene ? resource.sceneReason || '当前场景未包含此工具' : undefined}>{limitedByScene ? '场景未启用' : resource.enabled ? '管理入口已启用' : '管理入口已停用'}</span>
          <div className="resource-row-actions"><button className="button" onClick={event => edit(resource, event.currentTarget)} disabled={readOnly || busy}>编辑</button><button className="button" onClick={() => void toggle(resource)} disabled={readOnly || busy}>{resource.enabled ? '停用' : '启用'}</button></div>
        </article>;
      })}
      {!visibleResources.length && <div className="resource-empty"><Box size={28} /><p>{loading ? '正在读取工具目录…' : resources.length ? '没有匹配的工具' : '登记现有工具，统一查看来源与管理信息'}</p>{resources.length > 0 && <button className="button" onClick={() => { setQuery(''); setKind(''); }}>清除筛选</button>}</div>}
    </div>
    {detail && <section className="resource-detail" ref={detailElement} tabIndex={-1} aria-label={`${detail.name} 详情`}><div className="resource-editor-title"><h2>{detail.name}</h2><button className="button" aria-label="关闭工具详情" onClick={closeDetail}><X size={16} /></button></div><dl><dt>实际目录</dt><dd className="resource-path">{detail.rootPath}</dd><dt>维护归属</dt><dd>{detail.ownership === 'external' ? '外部安装 · 原位置保留' : '管理器安装'}</dd><dt>管理范围</dt><dd>{scopeLabels[detail.managementScope] || detail.managementScope}</dd><dt>登记版本</dt><dd>{detail.version || '未登记'}</dd><dt>运行能力</dt><dd>{detail.actions.length ? `已登记 ${detail.actions.length} 项动作；可用性需分别验证` : '尚未登记运行入口'}</dd><dt>个人备注</dt><dd>{detail.notes || '未填写'}</dd></dl>
      <ul className="resource-capabilities" aria-label="各项能力状态">{detail.capabilities.map(capability => <li key={capability.id}><div><strong>{capability.label}</strong><span>{({ available: '已核验', configured: '已配置，待验证', unverified: '未验证', unavailable: '当前不可用', failed: '验证失败', needs_login: '需要登录' } as Record<string, string>)[capability.status] || capability.status}</span></div>{capability.reason && <p>{capability.reason}</p>}<small>{capability.verifiedAt ? `最近验证：${new Date(capability.verifiedAt).toLocaleString()}` : '尚无验证时间'}</small></li>)}</ul>
      <div className="resource-detail-actions"><button className="button" onClick={() => void openLocation(detail)}><FolderOpen size={16} />打开目录</button><button className="button" disabled={busy || !visible} onClick={() => void openSystemApps()} title="系统安装的程序在 Windows 设置中卸载；不会自动执行卸载命令">Windows 卸载设置</button>{repositoryHref(detail.repository) && <button className="button" onClick={() => void openRepository(detail)}><ExternalLink size={16} />查看来源</button>}</div>
      <ResourceRelocation key={`relocate-${detail.id}`} resource={detail} action={action} visible={visible} readOnly={readOnly || busy} onChanged={changed => setResources(previous => previous.map(item => item.id === changed.id ? changed : item))} />
      <ResourceActions key={detail.id} resource={detail} action={action} readOnly={readOnly} focusActionId={visible && detail.id === activeAction?.resourceId ? activeAction.id : undefined} focusActionRevision={activeAction?.revision} focusRequest={activeAction?.request ?? 0} onChanged={changed => setResources(previous => previous.map(item => item.id === changed.id ? changed : item))} />
      <ResourceAdapters key={`adapter-${detail.id}`} resource={detail} rootPath={detail.rootPath} action={action} visible={visible} readOnly={readOnly} onChanged={changed => setResources(previous => previous.map(item => item.id === changed.id ? changed : item))} />
      <ResourceCapabilityEvidence key={`evidence-${detail.id}`} resource={detail} action={action} visible={visible} />
      <ResourceRelations endpoint={{ kind: 'tool', id: detail.id }} action={action} revision={revision} readOnly={readOnly} visible={visible} />
      <ResourceSource resource={detail} action={action} onChanged={() => void reload()} readOnly={readOnly} visible={visible} />
      <ResourceIdleControls resource={detail} action={action} onChanged={() => void reload()} readOnly={readOnly} visible={visible} />
      <ResourceSpace endpoint={{ kind: 'tool', id: detail.id }} action={action} revision={revision} visible={visible} />
      {!readOnly && <ResourceRepair key={`repair-${detail.id}`} resource={detail} action={action} onChanged={changed => setResources(previous => previous.map(item => item.id === changed.id ? changed : item))} />}
      <ResourceUpdate key={`update-${detail.id}`} resource={detail} action={action} visible={visible} readOnly={readOnly} onChanged={changed => setResources(previous => previous.map(item => item.id === changed.id ? changed : item))} />
      <ResourceAutomation key={`automation-${detail.id}`} resource={detail} action={action} visible={visible} readOnly={readOnly} onChanged={changed => setResources(previous => previous.map(item => item.id === changed.id ? changed : item))} />
      {!readOnly && <RemoveResource key={`remove-${detail.id}`} resource={detail} action={action} visible={visible} readOnly={readOnly} onChanged={changed => setResources(previous => previous.map(item => item.id === changed.id ? changed : item))} />}
    </section>}
  </section>;
}
