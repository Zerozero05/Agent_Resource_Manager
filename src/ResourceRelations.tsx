import { useEffect, useId, useRef, useState } from 'react';
import './resources.css';

export type RelationEndpoint = { kind: 'skill' | 'tool'; id: string };
export type RelationSummary = RelationEndpoint & { name: string; exists: boolean; ownership: 'managed' | 'external' | 'unknown'; shared: boolean };
export type ResourceRelation = { id: string; dependent: RelationSummary; dependency: RelationSummary; createdAt: string };
export type ResourceRelationsSnapshot = { revision: number; endpoint: RelationSummary; dependencies: ResourceRelation[]; dependents: ResourceRelation[]; candidates: RelationSummary[] };
type Action = <T>(label: string, action: string, args: Record<string, unknown>) => Promise<T>;
export type ResourceRelationsProps = { endpoint: RelationEndpoint; action: Action; revision?: number; readOnly?: boolean; visible?: boolean };
const endpointKey = (endpoint: RelationEndpoint) => JSON.stringify([endpoint.kind, endpoint.id]);
const sameEndpoint = (left: RelationEndpoint, right: RelationEndpoint) => left.kind === right.kind && left.id === right.id;
const kindLabel = (kind: RelationEndpoint['kind']) => kind === 'skill' ? 'Skill' : '工具';
const ownershipLabel = { managed: '有安装归属记录', external: '外部资源', unknown: '归属未知' };

function Summary({ value }: { value: RelationSummary }) {
  return <span className="relation-summary"><strong>{value.name || value.id}</strong><span>{kindLabel(value.kind)} · {ownershipLabel[value.ownership]}</span>{value.shared && <span className="relation-shared">共享使用</span>}{!value.exists && <span className="relation-missing">失效引用</span>}</span>;
}

export function ResourceRelations(props: ResourceRelationsProps) { return <RelationsEditor key={endpointKey(props.endpoint)} {...props} />; }

function RelationsEditor({ endpoint, action, revision = 0, readOnly = false, visible = true }: ResourceRelationsProps) {
  const [expanded, setExpanded] = useState(false), [data, setData] = useState<ResourceRelationsSnapshot | null>(null);
  const [selectedKey, setSelectedKey] = useState(''), [loading, setLoading] = useState(false), [writing, setWriting] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [conflict, setConflict] = useState(false);
  const contentId = useId();
  const alive = useRef(true), readPending = useRef(false), writeLock = useRef(false), queuedRead = useRef(false), epoch = useRef(0);
  const dataRef = useRef(data), actionRef = useRef(action), current = useRef({ visible, expanded, readOnly });
  actionRef.current = action; current.current = { visible, expanded, readOnly };
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; }; }, []);
  function accept(value: ResourceRelationsSnapshot) {
    if (!sameEndpoint(value.endpoint, endpoint)) throw new Error('关系结果不属于当前资源，请刷新后重试。');
    if (dataRef.current && value.revision < dataRef.current.revision) return;
    dataRef.current = value; setData(value); setConflict(false);
  }
  function active() { return alive.current && current.current.visible && current.current.expanded; }
  async function reload() {
    if (!active()) return;
    if (readPending.current || writeLock.current) { queuedRead.current = true; return; }
    readPending.current = true; queuedRead.current = false;
    const started = epoch.current;
    setLoading(true); setError('');
    try {
      const value = await actionRef.current<ResourceRelationsSnapshot>('读取资源依赖关系', 'resource_relations', { endpoint });
      if (active() && started === epoch.current) accept(value);
    } catch (cause) { if (active() && started === epoch.current) setError(String(cause)); }
    finally {
      readPending.current = false;
      if (alive.current) setLoading(false);
      if (queuedRead.current && active()) void reload();
    }
  }
  useEffect(() => {
    epoch.current++;
    if (visible && expanded) void reload();
  }, [visible, expanded, revision]);
  const dependencies = new Set(data?.dependencies.map(edge => endpointKey(edge.dependency)));
  const candidates = data?.candidates.filter(candidate => candidate.exists && !sameEndpoint(candidate, endpoint) && !dependencies.has(endpointKey(candidate))) || [];
  const selected = candidates.find(candidate => endpointKey(candidate) === selectedKey);
  const blocked = !visible || readOnly || loading || writing || conflict;
  async function mutate(edge?: ResourceRelation, incoming = false) {
    if (blocked || !active() || !data || readPending.current || writeLock.current || (edge ? !(incoming ? data.dependents : data.dependencies).some(item => item.id === edge.id) : !selected || !data.endpoint.exists)) return;
    writeLock.current = true; setWriting(true); setError(''); setNotice('');
    const started = epoch.current;
    try {
      const value = await actionRef.current<ResourceRelationsSnapshot>(edge ? '移除管理依赖关系' : '添加管理依赖关系', edge ? 'resource_relation_remove' : 'resource_relation_add', edge
        ? { id: edge.id, expectedRevision: data.revision }
        : { dependent: endpoint, dependency: { kind: selected!.kind, id: selected!.id }, expectedRevision: data.revision });
      if (alive.current) {
        if (!sameEndpoint(value.endpoint, edge?.dependent || endpoint)) throw new Error(incoming ? '关系结果不属于该使用者，请刷新后重试。' : '关系结果不属于当前资源，请刷新后重试。');
        if (incoming) queuedRead.current = true;
        else if (active() && started === epoch.current) accept(value);
        if (!edge) setSelectedKey('');
        setNotice(edge ? '管理关系已移除。' : '管理关系已添加。');
      }
    } catch (cause) {
      if (alive.current) { setError(String(cause)); if (/revision|conflict|变化|更改|冲突|过期/i.test(String(cause))) setConflict(true); }
    } finally {
      writeLock.current = false;
      if (alive.current) setWriting(false);
      if (queuedRead.current && active()) void reload();
    }
  }
  return <section className="resource-relations" aria-label="资源依赖关系">
    <button className="button" type="button" aria-expanded={expanded} aria-controls={contentId} disabled={!visible || writing} onClick={() => setExpanded(previous => !previous)}>依赖关系</button>
    {expanded && <div id={contentId} className="resource-relations-content" aria-busy={loading || writing}>
      <div className="resource-detail-actions"><p className="muted">这里只记录管理关系，不改动文件，也不授予删除权限。</p><button className="button" type="button" disabled={!visible || loading || writing} onClick={() => void reload()}>刷新关系</button></div>
      {data && <>
        <div className="relation-endpoint"><Summary value={data.endpoint} /></div>
        <div className="relation-columns">
          <section aria-label="依赖什么"><h4>依赖什么 <span>{data.dependencies.length}</span></h4>{data.dependencies.length ? <ul>{data.dependencies.map(edge => <li key={edge.id}><Summary value={edge.dependency} />{!readOnly && <button className="button" type="button" aria-label={`移除对${edge.dependency.name || edge.dependency.id}的依赖关系`} disabled={blocked} onClick={() => void mutate(edge)}>移除关系</button>}</li>)}</ul> : <p className="muted">尚未记录依赖。</p>}</section>
          <section aria-label="被谁使用"><h4>被谁使用 <span>{data.dependents.length}</span></h4>{data.dependents.length ? <ul>{data.dependents.map(edge => <li key={edge.id}><Summary value={edge.dependent} />{!readOnly && <button className="button" type="button" aria-label={`移除来自${edge.dependent.name || edge.dependent.id}的管理关系`} title={`移除来自${edge.dependent.name || edge.dependent.id}的管理关系`} disabled={blocked} onClick={() => void mutate(edge, true)}>移除关系</button>}</li>)}</ul> : <p className="muted">尚未记录使用者。</p>}</section>
        </div>
        {!readOnly && <div className="relation-add"><label>添加依赖<select aria-label="选择依赖资源" value={selectedKey} disabled={blocked || !data.endpoint.exists} onChange={event => setSelectedKey(event.target.value)}><option value="">选择已登记的 Skill 或工具</option>{selectedKey && !selected && <option value={selectedKey} disabled>所选资源当前不可用，请重新选择</option>}{candidates.map(candidate => <option key={endpointKey(candidate)} value={endpointKey(candidate)}>{kindLabel(candidate.kind)} · {candidate.name || candidate.id}</option>)}</select></label><button className="button" type="button" disabled={blocked || !selected || !data.endpoint.exists} onClick={() => void mutate()}>添加关系</button></div>}
      </>}
      {!data && loading && <p className="muted">正在读取依赖关系…</p>}
      {conflict && <p className="muted">关系已在其他位置更改，选择已保留；刷新后可继续。</p>}
      {error && <p className="resource-error" role="alert">{error}</p>}
      {notice && <p className="resource-notice" role="status">{notice}</p>}
    </div>}
  </section>;
}
