import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import type { Resource, ResourceActionDefinition } from './resources';

type Action = <T>(label: string, action: string, args: Record<string, unknown>) => Promise<T>;
type Adapter = 'agentReach' | 'edgeControl' | 'dragonCodexBoot';
type AdapterAction = { id: string; label: string; executable: string; workingDirectory: string; args: ResourceActionDefinition['args']; parameters?: ResourceActionDefinition['parameters'] };
type BoundAction = ResourceActionDefinition & { adapterBinding?: { adapter?: string } };
type RuntimeChange = { path: string; previousSha256: string; currentSha256: string };
type Plan = { id: string; kind: 'resourceAdapter'; adapter: Adapter; operation?: 'refreshNode'; runtimeChange?: RuntimeChange; name: string; rootPath: string; resourceId: string | null; resourceRevision: number | null; detectedVersion: string; versionEvidence: string; repository: string | null; sourceVerified: false; license: string; actions: AdapterAction[]; preserved: string[]; warnings: string[]; canApply: boolean; deleteGrant: false; automaticUpdateGrant: false; filesChanged: false };
const names: Record<Adapter, string> = { agentReach: 'Agent Reach', edgeControl: 'Playwright MCP', dragonCodexBoot: 'DragonCodexBoot' };
function fixedEdgeNode(resource?: Resource): string | null {
  const entry = resource?.actions[0]?.executable;
  if (!entry || !resource?.actions.every(item => item.executable === entry && (item as BoundAction).adapterBinding?.adapter === 'edgeControl')) return null;
  return entry;
}
function validArguments(item: AdapterAction): boolean {
  return Array.isArray(item.args) && item.args.every(arg => !!arg && (
    (arg.type === 'literal' && typeof arg.value === 'string')
    || (arg.type === 'parameter' && typeof arg.name === 'string' && Array.isArray(item.parameters)
      && item.parameters.some(parameter => !!parameter && parameter.name === arg.name && typeof parameter.label === 'string' && ['text', 'choice', 'integer'].includes(parameter.kind)))
  ));
}
function valid(value: Plan, adapter: Adapter): boolean {
  return !!value && value.kind === 'resourceAdapter' && value.adapter === adapter && typeof value.id === 'string' && value.id.length > 0 && typeof value.rootPath === 'string' && typeof value.name === 'string'
    && typeof value.detectedVersion === 'string' && typeof value.versionEvidence === 'string' && typeof value.license === 'string' && typeof value.canApply === 'boolean'
    && value.sourceVerified === false && value.deleteGrant === false && value.automaticUpdateGrant === false && value.filesChanged === false
    && Array.isArray(value.actions) && value.actions.every(item => !!item && typeof item.id === 'string' && typeof item.label === 'string' && typeof item.executable === 'string' && typeof item.workingDirectory === 'string' && validArguments(item))
    && [value.preserved, value.warnings].every(list => Array.isArray(list) && list.every(item => typeof item === 'string'));
}

export function ResourceAdapters({ rootPath, resource, action, onChanged, visible = true, readOnly = false }: { rootPath: string; resource?: Resource; action: Action; onChanged: (resource: Resource) => void; visible?: boolean; readOnly?: boolean }) {
  const [expanded, setExpanded] = useState(false), [adapter, setAdapter] = useState<Adapter>('agentReach'), [nodePath, setNodePath] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const refresh = !!resource, fixedNode = fixedEdgeNode(resource), selectedAdapter = refresh ? 'edgeControl' : adapter;
  const epoch = useRef(0), lock = useRef(false), consumed = useRef(false), mounted = useRef(true), disclosure = useRef<HTMLButtonElement>(null);
  const current = useRef({ rootPath, resource, refresh, fixedNode, visible, readOnly, adapter: selectedAdapter, nodePath, expanded }); current.current = { rootPath, resource, refresh, fixedNode, visible, readOnly, adapter: selectedAdapter, nodePath, expanded };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; }; }, []);
  useLayoutEffect(() => { epoch.current++; consumed.current = false; setPlan(null); setError(''); setNotice(''); }, [rootPath, adapter, nodePath, visible, readOnly, resource?.id, fixedNode]);
  useLayoutEffect(() => { epoch.current++; consumed.current = false; setPlan(null); setError(''); }, [resource?.revision]);
  function active(generation: number) { const value = current.current; return mounted.current && generation === epoch.current && value.visible && !value.readOnly && value.expanded && (!value.refresh || !!value.fixedNode); }
  function collapse() { epoch.current++; setExpanded(false); setPlan(null); setError(''); setNotice(''); disclosure.current?.focus({ preventScroll: true }); }
  async function preview() {
    const value = current.current;
    if (lock.current || !value.visible || value.readOnly || !value.expanded || !value.rootPath.trim() || value.refresh && !value.fixedNode) return;
    const generation = ++epoch.current;
    lock.current = true; consumed.current = false; setBusy(true); setPlan(null); setError(''); setNotice('');
    try {
      const request = value.resource ? { operation: 'refreshNode', resourceId: value.resource.id, expectedRevision: value.resource.revision } : { adapter: value.adapter, rootPath: value.rootPath.trim(), ...(value.adapter === 'edgeControl' && value.nodePath.trim() ? { nodePath: value.nodePath.trim() } : {}) };
      const received = await action<Plan>(value.refresh ? '核对已登记的 Node 入口' : '核对现有工具与固定动作', 'preview_resource_adapter', request);
      if (!active(generation)) return;
      if (!valid(received, value.adapter)) throw new Error(value.refresh ? '入口预览格式或权限状态异常，请重新核对。' : '接管预览格式或权限状态异常，未保存。');
      if (value.resource) {
        const existing = value.resource, change = received.runtimeChange;
        const sameActions = received.actions.length === existing.actions.length
          && received.actions.every(item => existing.actions.some(current => current.id === item.id));
        const runtimeIdentified = change && typeof change.path === 'string' && change.path.length > 0
          && /^[a-f0-9]{64}$/i.test(change.previousSha256) && /^[a-f0-9]{64}$/i.test(change.currentSha256);
        if (received.operation !== 'refreshNode' || received.resourceId !== existing.id
          || received.resourceRevision !== existing.revision || !sameActions || !runtimeIdentified) {
          throw new Error('入口预览与当前工具不一致，请重新核对。');
        }
      }
      setPlan(received);
    } catch (cause) { if (active(generation)) setError(String(cause)); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  async function apply() {
    if (!plan || !plan.canApply || consumed.current || lock.current || !active(epoch.current)) return;
    const generation = epoch.current, original = plan, existing = current.current.resource;
    lock.current = true; consumed.current = true; setBusy(true); setError('');
    try {
      const result = await action<{ resource: Resource; operation?: 'refreshNode'; complete: boolean; adopted: boolean; executed: boolean; filesChanged: boolean; ownership: string; sourceVerified: boolean }>(existing ? '保存已核对的 Node 入口' : '保存本次接管范围', 'apply_resource_adapter', { previewId: original.id });
      if (!active(generation)) return;
      if (!result || result.complete !== true || result.adopted !== true || result.executed !== false
        || result.filesChanged !== false || result.ownership !== (existing?.ownership || 'external')
        || result.sourceVerified !== false || typeof result.resource?.id !== 'string') {
        throw new Error('保存回执不完整，请刷新工具目录核对实际结果。');
      }
      if (existing && (result.operation !== 'refreshNode' || result.resource.id !== existing.id
        || result.resource.ownership !== existing.ownership || !Number.isSafeInteger(result.resource.revision)
        || result.resource.revision <= existing.revision)) {
        throw new Error('保存回执不完整，请刷新工具目录核对实际结果。');
      }
      setPlan(null); setNotice(existing ? '入口核对已保存。' : '接管已保存，原文件与登录状态保持。'); onChanged(result.resource);
    } catch (cause) { if (active(generation)) { setPlan(null); setError(String(cause)); } }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  async function chooseNode() {
    if (lock.current || !active(epoch.current)) return;
    const generation = epoch.current;
    try { const path = await open({ title: '选择已安装的 node.exe', directory: false, multiple: false, filters: [{ name: 'Node.js', extensions: ['exe'] }] }); if (typeof path === 'string' && active(generation)) setNodePath(path); }
    catch (cause) { if (active(generation)) setError(String(cause)); }
  }
  if (!visible || readOnly || refresh && !fixedNode) return null;
  return <section className="resource-repair resource-adapters" aria-label={refresh ? '重新核对入口' : '接管现有工具'}>
    <button ref={disclosure} className="button" type="button" aria-expanded={expanded} onClick={() => expanded ? collapse() : setExpanded(true)}>{refresh ? '重新核对入口' : '接管现有工具'}</button>
    {expanded && <div className="resource-github">
      {refresh ? <><p className="muted">运行环境更新后，核对并保留原有动作</p><dl><dt>工具</dt><dd>Playwright MCP</dd><dt>目录</dt><dd className="resource-path">{rootPath}</dd><dt>Node 入口</dt><dd className="resource-path">{fixedNode}</dd></dl></> : <div className="resource-github-fields">
        <label>工具类型<select aria-label="接管工具类型" disabled={busy} value={adapter} onChange={event => setAdapter(event.target.value as Adapter)}>{Object.entries(names).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        <div><span className="muted">现有目录</span><p className="resource-path">{rootPath || '请先选择上方的工具目录'}</p></div>
        {adapter === 'edgeControl' && <label className="resource-full">现有 Node 入口<div className="resource-folder-input"><input disabled={busy} value={nodePath} onChange={event => setNodePath(event.target.value)} placeholder="留空读取已有安装记录" /><button className="button" type="button" disabled={busy} onClick={() => void chooseNode()}>选择</button></div></label>}
      </div>}
      <div className="resource-detail-actions"><button className="button" type="button" disabled={busy || !rootPath.trim()} onClick={() => void preview()}>{busy ? '正在核对…' : refresh ? '预览入口变化' : '预览接管'}</button></div>
      {error && <p className="resource-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      {plan && <section className="resource-repair-result" aria-label={refresh ? '入口变化预览' : '本次接管范围'}>
        {refresh && plan.runtimeChange ? <><h3>Node 入口变化</h3><dl><dt>入口</dt><dd className="resource-path">{plan.runtimeChange.path}</dd><dt>已登记摘要</dt><dd className="resource-path">{plan.runtimeChange.previousSha256}</dd><dt>当前摘要</dt><dd className="resource-path">{plan.runtimeChange.currentSha256}</dd><dt>固定动作</dt><dd>{resource?.actions.length} 项 → {plan.actions.length} 项</dd></dl></> : <><h3>{plan.name} · {plan.detectedVersion}</h3><dl><dt>目录</dt><dd className="resource-path">{plan.rootPath}</dd><dt>版本依据</dt><dd>{plan.versionEvidence}</dd><dt>许可证</dt><dd>{plan.license}</dd><dt>声明来源</dt><dd>{plan.repository || '未知'}</dd></dl></>}
        <details open={!refresh}><summary>固定检查动作（{plan.actions.length}）</summary>{plan.actions.length ? <ul>{plan.actions.map(item => <li key={item.id}><strong>{item.label}</strong><details><summary>入口与参数</summary><p className="resource-path">{item.executable}</p><ul>{item.args.map((arg, index) => <li className="resource-path" key={index}>{arg.type === 'literal' ? arg.value : '参数：' + (item.parameters?.find(parameter => parameter.name === arg.name)?.label || arg.name)}</li>)}</ul></details></li>)}</ul> : <p>只登记信息，保留原生启动入口。</p>}</details>
        {!refresh && <details><summary>原位保留</summary><ul>{plan.preserved.map(item => <li key={item}>{item}</li>)}</ul></details>}
        <ul>{plan.warnings.map(item => <li key={item}>{item}</li>)}</ul>
        <button className="button primary" type="button" disabled={busy || !plan.canApply || consumed.current} onClick={() => void apply()}>{refresh ? '保存入口核对' : '保存接管'}</button>
      </section>}
    </div>}
  </section>;
}
