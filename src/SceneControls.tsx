import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import './scenes.css';

export type SceneEndpoint = { kind: 'skill' | 'tool'; id: string };
export type SceneMember = SceneEndpoint & { name: string; exists: boolean; enabled: boolean; sceneEligible: boolean; sceneReason: string; effectiveEnabled: boolean };
export type SceneDefinition = { id: string; name: string; members: SceneMember[] };
export type SceneData = { revision: number; activeSceneId: string | null; scenes: SceneDefinition[]; candidates: SceneMember[] };
export type SceneDraft = { expanded: boolean; selectedId: string | null; editor: { id?: string; revision: number; name: string; members: SceneEndpoint[] } | null };
type Action = <T>(label: string, command: string, args: Record<string, unknown>) => Promise<T>;
const endpointKey = (value: SceneEndpoint) => JSON.stringify([value.kind, value.id]);
const endpoint = ({ kind, id }: SceneEndpoint): SceneEndpoint => ({ kind, id });
const editorFor = (data: SceneData, scene?: SceneDefinition): NonNullable<SceneDraft['editor']> => ({ ...(scene ? { id: scene.id } : {}), revision: data.revision, name: scene?.name || '', members: scene?.members.map(endpoint) || [] });

// One window shares reads; importing this module performs no I/O.
let cache = { data: null as SceneData | null, loading: false, stale: true, error: '' };
let invalidation = -1, generation = 0, pendingRead: Promise<SceneData | null> | null = null;
const subscribers = new Set<() => void>();
function publish(next: typeof cache) { cache = next; subscribers.forEach(notify => notify()); }
const subscribe = (notify: () => void) => { subscribers.add(notify); return () => { subscribers.delete(notify); }; };
const getSnapshot = () => cache;
function invalidate(revision: number) { if (revision > invalidation) { invalidation = revision; generation++; publish({ ...cache, stale: true }); } }
function accept(data: SceneData, fresh = true) {
  if (cache.data && data.revision < cache.data.revision) return;
  generation++; publish({ ...cache, data, stale: !fresh, error: '' });
}
function read(action: Action, force = false): Promise<SceneData | null> {
  if (pendingRead) return pendingRead;
  if (!force && cache.data && !cache.stale) return Promise.resolve(cache.data);
  const started = generation; publish({ ...cache, loading: true, error: '' });
  pendingRead = action<SceneData>('读取场景', 'resource_scenes', {}).then(data => {
    if (started !== generation) return null;
    accept(data); return cache.data;
  }, cause => { if (started === generation) publish({ ...cache, error: String(cause) }); return null; }).finally(() => { pendingRead = null; publish({ ...cache, loading: false }); });
  return pendingRead;
}

export function SceneControls({ action, revision = 0, readOnly = false, visible = true, initialDraft, onDraft }: {
  action: Action; revision?: number; readOnly?: boolean; visible?: boolean; initialDraft?: SceneDraft; onDraft?: (draft: SceneDraft) => void;
}) {
  const [expanded, setExpanded] = useState(initialDraft?.expanded || false), [selectedId, setSelectedId] = useState<string | null>(initialDraft?.selectedId ?? null);
  const [editor, setEditor] = useState<SceneDraft['editor']>(initialDraft?.editor || null), [busy, setBusy] = useState(false), [conflict, setConflict] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const state = useSyncExternalStore(subscribe, getSnapshot), data = state.data;
  const contentId = useId(), alive = useRef(true), lock = useRef(false), current = useRef({ visible, expanded, readOnly }); current.current = { visible, expanded, readOnly };
  const actionRef = useRef(action), draftCallback = useRef(onDraft); actionRef.current = action; draftCallback.current = onDraft;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useLayoutEffect(() => { draftCallback.current?.({ expanded, selectedId, editor }); }, [expanded, selectedId, editor]);
  useEffect(() => {
    invalidate(revision);
    if (!visible || !expanded) return;
    let active = true;
    void read(actionRef.current).then(() => { if (active && cache.stale && !cache.error) void read(actionRef.current); });
    return () => { active = false; };
  }, [visible, expanded, revision]);
  const choice = selectedId ?? data?.activeSceneId ?? '';
  const selected = data?.scenes.find(scene => scene.id === choice), activeScene = data?.scenes.find(scene => scene.id === data.activeSceneId);
  const staleEditor = !!editor && !!data && editor.revision !== data.revision;
  const blocked = readOnly || !visible || busy || state.loading || state.stale || !data || conflict;
  const summaries = new Map(data?.scenes.flatMap(scene => scene.members).map(member => [endpointKey(member), member]));
  data?.candidates.forEach(member => summaries.set(endpointKey(member), member));
  const members = editor?.members || selected?.members || [];
  const candidateKeys = new Set(data?.candidates.map(endpointKey)), selectedKeys = new Set(members.map(endpointKey));
  const choices = [...new Map([...(data?.candidates || []).map(member => [endpointKey(member), member] as const), ...members.filter(member => !candidateKeys.has(endpointKey(member))).map(member => [endpointKey(member), summaries.get(endpointKey(member)) || { ...member, name: member.id, exists: false, enabled: false, sceneEligible: false, effectiveEnabled: false, sceneReason: '资源已不在登记目录中' }] as const)]).values()];
  async function refresh(replaceDraft = false) {
    if (!visible || lock.current) return;
    setError('');
    const value = await read(actionRef.current, true);
    if (!alive.current || !value || cache.stale) return;
    setConflict(false);
    if (replaceDraft && editor) {
      const latest = value.scenes.find(scene => scene.id === editor.id);
      if (editor.id && !latest) { setError('此场景已被移除，草稿仍保留；可取消后新建。'); return; }
      setEditor(latest ? editorFor(value, latest) : { ...editor, revision: value.revision });
    }
  }
  async function mutate(command: 'resource_scene_save' | 'resource_scene_remove' | 'resource_scene_activate', args: Record<string, unknown>) {
    if (blocked || lock.current || !data || command === 'resource_scene_save' && staleEditor) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    const before = generation, knownIds = new Set(data.scenes.map(scene => scene.id));
    try {
      const value = await actionRef.current<SceneData>(command === 'resource_scene_save' ? '保存场景' : command === 'resource_scene_remove' ? '移除场景定义' : '切换管理器场景', command, { expectedRevision: command === 'resource_scene_save' ? editor!.revision : data.revision, ...args });
      accept(value, generation === before);
      if (alive.current) {
        setConflict(false);
        if (command === 'resource_scene_save') {
          const added = value.scenes.filter(scene => !knownIds.has(scene.id));
          if (editor?.id) setSelectedId(editor.id); else if (added.length === 1) setSelectedId(added[0].id);
          setEditor(null);
        } else if (command === 'resource_scene_remove') setSelectedId('');
        setNotice(command === 'resource_scene_activate' ? '场景资格已切换；现有任务和客户端连接保持。' : '场景定义已保存；资源文件和运行任务保持。');
        if (current.current.visible && current.current.expanded && cache.stale) void read(actionRef.current);
      }
    } catch (cause) { if (alive.current) { setError(String(cause)); if (/revision|conflict|变化|更改|冲突|过期/i.test(String(cause))) setConflict(true); } }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  function edit(scene?: SceneDefinition) { if (blocked || !data) return; setEditor(editorFor(data, scene)); setError(''); setNotice(''); }
  return <section className="card scene-controls" aria-label="场景设置">
    <div className="card-header"><div><h2 data-outline-key="settings:scenes" data-outline-label="场景" data-outline-level="2">场景</h2><p>选择本次工作使用的资源集合。</p></div><button className="button" type="button" aria-expanded={expanded} aria-controls={contentId} disabled={!visible || busy} onClick={() => setExpanded(value => !value)}>{expanded ? '收起场景' : '管理场景'}</button></div>
    {expanded && <div id={contentId} className="scene-content" aria-busy={state.loading || busy}>
      <p className="muted">场景只限制管理器后续调用入口，不阻断原生客户端使用 Skill；切换不启动或停止任务，也不更改客户端连接。手动停用始终优先。</p>
      <div className="scene-actions"><span>当前：{activeScene?.name || (data?.activeSceneId ? '场景定义不可用' : '无场景限制')}</span><button className="button" type="button" disabled={!visible || busy || state.loading} onClick={() => void refresh()}>刷新场景</button></div>
      {data && <>
        <div className="scene-actions"><label>场景定义<select aria-label="场景定义" value={choice} disabled={busy} onChange={event => setSelectedId(event.target.value)}><option value="">选择场景</option>{choice && !selected && <option value={choice} disabled>所选场景已移除</option>}{data.scenes.map(scene => <option key={scene.id} value={scene.id}>{scene.name}{scene.id === data.activeSceneId ? ' · 当前' : ''}</option>)}</select></label>{!readOnly && <><button className="button" type="button" disabled={blocked || !selected || selected.id === data.activeSceneId} onClick={() => void mutate('resource_scene_activate', { id: selected!.id })}>启用此场景</button><button className="button" type="button" disabled={blocked || !data.activeSceneId} onClick={() => void mutate('resource_scene_activate', { id: null })}>退出当前场景</button></>}</div>
        {selected && !editor && <ul className="scene-members" aria-label="场景成员">{selected.members.map(member => <li key={endpointKey(member)}>{member.kind === 'tool' ? '工具' : 'Skill'} · {member.name || member.id}{!member.exists ? <span className="error-text"> · 失效引用</span> : !member.enabled ? <span> · 已手动停用</span> : null}</li>)}{!selected.members.length && <li>此场景未包含任何资源。</li>}</ul>}
        {!readOnly && <div className="scene-actions"><button className="button" type="button" disabled={blocked || !!editor} onClick={() => edit()}>新建场景</button><button className="button" type="button" disabled={blocked || !selected || !!editor} onClick={() => edit(selected)}>编辑场景</button><button className="button" type="button" disabled={blocked || !selected || !!editor} onClick={() => void mutate('resource_scene_remove', { id: selected!.id })}>移除场景定义</button></div>}
      </>}
      {editor && !readOnly && <div className="scene-editor" aria-label="编辑场景定义"><label>场景名称<input aria-label="场景名称" maxLength={80} value={editor.name} disabled={busy || !visible} onChange={event => setEditor({ ...editor, name: event.target.value })} /></label><div className="scene-choices" aria-label="选择场景资源">{choices.map(member => <label key={endpointKey(member)}><input type="checkbox" aria-label={`${member.kind === 'tool' ? '工具' : 'Skill'} ${member.name || member.id}`} checked={selectedKeys.has(endpointKey(member))} disabled={busy || !visible} onChange={event => setEditor({ ...editor, members: event.target.checked ? [...editor.members, endpoint(member)] : editor.members.filter(item => endpointKey(item) !== endpointKey(member)) })} /><span>{member.kind === 'tool' ? '工具' : 'Skill'} · {member.name || member.id}{!member.exists ? ' · 失效引用（可保留或移除）' : !member.enabled ? ' · 已手动停用（加入场景不会启用）' : ''}</span></label>)}</div>{(staleEditor || conflict) && <p className="helper-note" role="alert">场景记录已变化，草稿仍保留。<button className="text-button" type="button" disabled={!visible || busy || state.loading} onClick={() => void refresh(true)}>重新读取（替换场景草稿）</button></p>}<div className="scene-actions"><button className="button" type="button" disabled={busy} onClick={() => setEditor(null)}>取消编辑场景</button><button className="button primary" type="button" disabled={blocked || staleEditor || !editor.name.trim()} onClick={() => void mutate('resource_scene_save', { ...(editor.id ? { id: editor.id } : {}), name: editor.name.trim(), members: editor.members.map(endpoint) })}>保存场景</button></div></div>}
      {readOnly && <p className="muted">基本模式只查看场景定义，不能切换或修改。</p>}{(state.error || error) && <p className="error-text" role="alert">{error || state.error}</p>}{notice && <p role="status">{notice}</p>}
    </div>}
  </section>;
}
