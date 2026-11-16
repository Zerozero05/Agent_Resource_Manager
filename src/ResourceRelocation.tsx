import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { FolderOpen } from 'lucide-react';
import type { Resource } from './resources';

type Action = <T>(label: string, action: string, args: Record<string, unknown>) => Promise<T>;
type ActionMapping = { id: string; label: string; oldExecutable: string; newExecutable: string; oldWorkingDirectory: string; newWorkingDirectory: string; argumentPaths?: { index: number; oldPath: string; newPath: string }[] };
type RuntimeChange = { path: string; previousSha256: string; currentSha256: string };
type HasExecutableHash = { executableSha256?: string };
type RelocationPlan = {
  previewId: string; kind: 'resourceRelocation'; resourceId: string; resourceRevision: number;
  oldRootPath: string; newRootPath: string; adapter: 'agentReach' | 'edgeControl' | 'dragonCodexBoot'; version: string | null; license: string;
  actions: ActionMapping[]; preserved: string[]; warnings: string[]; canApply: true;
  runtimeChange?: RuntimeChange;
  filesChanged: false; executed: false; actionsAdded: 0;
};
type RelocationReceipt = { resource: Resource; complete: boolean; filesChanged: boolean; executed: boolean; actionsAdded: number };
const adapterNames = { agentReach: 'Agent Reach', edgeControl: 'Playwright MCP', dragonCodexBoot: 'DragonCodexBoot' };

function matchesPlan(plan: RelocationPlan, resource: Resource): boolean {
  const runtime = plan?.runtimeChange;
  return !!plan && plan.kind === 'resourceRelocation' && typeof plan.previewId === 'string' && !!plan.previewId
    && plan.resourceId === resource.id && plan.resourceRevision === resource.revision && plan.oldRootPath === resource.rootPath
    && !!plan.newRootPath && plan.newRootPath !== plan.oldRootPath
    && ['agentReach', 'edgeControl', 'dragonCodexBoot'].includes(plan.adapter) && plan.canApply === true
    && plan.filesChanged === false && plan.executed === false && plan.actionsAdded === 0
    && Array.isArray(plan.actions) && plan.actions.length === resource.actions.length
    && (!runtime || plan.adapter === 'edgeControl'
      && [runtime.previousSha256, runtime.currentSha256].every(hash => /^[a-f0-9]{64}$/i.test(hash))
      && resource.actions.length === 4 && resource.actions.every(item => item.executable === runtime.path && (item as HasExecutableHash).executableSha256 === runtime.previousSha256)
      && plan.actions.every(item => item.newExecutable === runtime.path))
    && new Set(plan.actions.map(item => item?.id)).size === plan.actions.length
    && plan.actions.every(item => {
      const existing = resource.actions.find(action => action.id === item?.id);
      return !!existing && item.label === existing.label && item.oldExecutable === existing.executable && item.oldWorkingDirectory === existing.workingDirectory
        && !!item.newExecutable && !!item.newWorkingDirectory && (item.argumentPaths ?? []).every(mapping => {
          const argument = existing.args[mapping.index];
          return Number.isInteger(mapping.index) && argument?.type === 'literal' && argument.value === mapping.oldPath && !!mapping.newPath && mapping.newPath !== mapping.oldPath;
        });
    });
}

function matchesReceipt(receipt: RelocationReceipt, plan: RelocationPlan, resource: Resource): boolean {
  const changed = receipt?.resource;
  return !!changed && receipt.complete === true && receipt.filesChanged === false && receipt.executed === false && receipt.actionsAdded === 0
    && changed.id === resource.id && changed.revision === resource.revision + 1 && changed.rootPath === plan.newRootPath
    && Array.isArray(changed.actions) && changed.actions.length === resource.actions.length
    && new Set(changed.actions.map(item => item?.id)).size === changed.actions.length
    && changed.actions.every(item => {
      const mapping = plan.actions.find(action => action.id === item?.id), original = resource.actions.find(action => action.id === item?.id);
      return !!mapping && !!original && item.label === original.label && item.executable === mapping.newExecutable && item.workingDirectory === mapping.newWorkingDirectory
        && (!plan.runtimeChange || (item as HasExecutableHash).executableSha256 === plan.runtimeChange.currentSha256)
        && (mapping.argumentPaths ?? []).every(path => { const argument = item.args[path.index]; return argument?.type === 'literal' && argument.value === path.newPath; });
    });
}

export function ResourceRelocation({ resource, action, onChanged, readOnly = false, visible = true }: { resource: Resource; action: Action; onChanged: (resource: Resource) => void; readOnly?: boolean; visible?: boolean }) {
  const [expanded, setExpanded] = useState(false), [rootPath, setRootPath] = useState('');
  const [plan, setPlan] = useState<RelocationPlan | null>(null), [phase, setPhase] = useState<'choose' | 'preview' | 'apply' | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const contentId = useId(), disclosure = useRef<HTMLButtonElement>(null), mounted = useRef(true), epoch = useRef(0), lock = useRef(false), consumed = useRef(false);
  const context = JSON.stringify([resource.id, resource.revision, resource.rootPath, resource.actions]);
  const current = useRef({ context, expanded, rootPath, visible, readOnly }); current.current = { context, expanded, rootPath, visible, readOnly };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; }; }, []);
  useLayoutEffect(() => { epoch.current++; setPlan(null); setError(''); consumed.current = false; }, [context, rootPath, visible, readOnly]);
  function active(generation: number, key: string) { const value = current.current; return mounted.current && generation === epoch.current && value.context === key && value.visible && !value.readOnly && value.expanded; }
  function collapse() { epoch.current++; setExpanded(false); setPlan(null); setError(''); setNotice(''); disclosure.current?.focus({ preventScroll: true }); }
  function changeRoot(value: string) { epoch.current++; setRootPath(value); setPlan(null); setError(''); setNotice(''); }
  async function chooseFolder() {
    if (lock.current || !active(epoch.current, context)) return;
    const generation = epoch.current, key = context;
    lock.current = true; setPhase('choose'); setError('');
    try {
      const selected = await open({ directory: true, multiple: false, title: '选择工具现在所在的目录' });
      if (typeof selected === 'string' && active(generation, key)) changeRoot(selected);
    } catch (cause) { if (active(generation, key)) setError(String(cause)); }
    finally { lock.current = false; if (mounted.current) setPhase(null); }
  }
  async function preview() {
    if (lock.current || !rootPath.trim() || !active(epoch.current, context)) return;
    const generation = ++epoch.current, key = context;
    lock.current = true; consumed.current = false; setPhase('preview'); setPlan(null); setError(''); setNotice('');
    try {
      const result = await action<RelocationPlan>('预览工具目录重新定位', 'preview_resource_relocate', { id: resource.id, expectedRevision: resource.revision, rootPath: rootPath.trim() });
      if (!active(generation, key)) return;
      if (!matchesPlan(result, resource)) throw new Error('目录预览与当前工具不一致，请刷新后重新预览。');
      setPlan(result);
    } catch (cause) { if (active(generation, key)) setError(String(cause)); }
    finally { lock.current = false; if (mounted.current) setPhase(null); }
  }
  async function apply() {
    if (lock.current || consumed.current || !plan?.canApply || !active(epoch.current, context)) return;
    const generation = epoch.current, key = context, original = plan;
    lock.current = true; consumed.current = true; setPhase('apply'); setError('');
    try {
      const result = await action<RelocationReceipt>('保存已确认的工具目录', 'apply_resource_relocate', { previewId: original.previewId });
      if (!mounted.current || current.current.context !== key) return;
      if (!matchesReceipt(result, original, resource)) throw new Error('保存回执不完整，请刷新工具目录核对实际结果。');
      if (active(generation, key)) { setPlan(null); setRootPath(''); setNotice('目录已更新，原管理记录已保留。目录变化后，原能力与自动更新许可须按新位置重新核对。'); }
      onChanged(result.resource);
    } catch (cause) { if (active(generation, key)) { setPlan(null); setError(`${String(cause)} 请重新预览后再确认。`); } }
    finally { lock.current = false; if (mounted.current) setPhase(null); }
  }
  if (!visible || readOnly) return null;
  return <section className="resource-source" aria-label="工具目录重新定位">
    <button ref={disclosure} className="button" type="button" disabled={phase === 'apply'} aria-expanded={expanded} aria-controls={contentId} onClick={() => expanded ? collapse() : setExpanded(true)}>重新定位目录…</button>
    {expanded && <div id={contentId} className="resource-source-content resource-action-editor resource-github" aria-busy={phase !== null}>
      <p className="muted">核对工具现在所在的目录，保留原管理记录。当前仅支持可核对的 Agent Reach、Playwright MCP 和 DragonCodexBoot。</p>
      <label>现在所在目录<div className="resource-folder-input"><input aria-label="工具现在所在目录" value={rootPath} disabled={phase === 'choose' || phase === 'apply'} onChange={event => changeRoot(event.target.value)} placeholder="工具迁移后的完整路径" /><button className="button" type="button" disabled={phase !== null} onClick={() => void chooseFolder()}><FolderOpen size={16} />选择目录</button></div></label>
      <div className="resource-detail-actions"><button className="button" type="button" disabled={phase !== null || !rootPath.trim()} onClick={() => void preview()}>{phase === 'preview' ? '正在核对目录…' : '预览目录变化'}</button></div>
      {phase === 'choose' && <p role="status">正在选择目录…</p>}
      {error && <p className="resource-error" role="alert">{error}</p>}{notice && <p className="resource-notice" role="status">{notice}</p>}
      {plan && <section className="resource-effect-preview" aria-label="目录重新定位预览">
        <p><strong>{adapterNames[plan.adapter]}</strong>{plan.version ? ` · ${plan.version}` : ''} · {plan.license}</p>
        <dl><dt>原目录</dt><dd className="resource-path">{plan.oldRootPath}</dd><dt>新目录</dt><dd className="resource-path">{plan.newRootPath}</dd></dl>
        {plan.runtimeChange && <details open><summary>共享运行环境校验信息已变化</summary>{plan.runtimeChange.previousSha256 === plan.runtimeChange.currentSha256 && <p className="muted">内容摘要相同，文件身份或修改信息已变化。</p>}<dl><dt>共享运行程序</dt><dd className="resource-path">{plan.runtimeChange.path}</dd><dt>原文件 SHA-256</dt><dd className="resource-path">{plan.runtimeChange.previousSha256}</dd><dt>现文件 SHA-256</dt><dd className="resource-path">{plan.runtimeChange.currentSha256}</dd></dl></details>}
        <details open><summary>现有动作路径（{plan.actions.length}）</summary>{plan.actions.length ? <ul>{plan.actions.map(item => <li key={item.id}><strong>{item.label}</strong><dl><dt>原入口</dt><dd className="resource-path">{item.oldExecutable}</dd><dt>新入口</dt><dd className="resource-path">{item.newExecutable}</dd><dt>原工作目录</dt><dd className="resource-path">{item.oldWorkingDirectory}</dd><dt>新工作目录</dt><dd className="resource-path">{item.newWorkingDirectory}</dd>{item.argumentPaths?.map(path => <Fragment key={path.index}><dt>原参数路径（第{path.index + 1}项）</dt><dd className="resource-path">{path.oldPath}</dd><dt>新参数路径（第{path.index + 1}项）</dt><dd className="resource-path">{path.newPath}</dd></Fragment>)}</dl></li>)}</ul> : <p>没有已登记动作，保留原生启动入口。</p>}</details>
        {plan.preserved.length > 0 && <details><summary>保留内容</summary><ul>{plan.preserved.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
        {plan.warnings.length > 0 && <ul>{plan.warnings.map((item, index) => <li key={index}>{item}</li>)}</ul>}
        <div className="resource-detail-actions"><button className="button primary" type="button" disabled={phase !== null || consumed.current} onClick={() => void apply()}>{phase === 'apply' ? '正在保存目录…' : '确认重新定位'}</button></div>
      </section>}
    </div>}
  </section>;
}
