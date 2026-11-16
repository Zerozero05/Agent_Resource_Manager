import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { Play, Square, Plus, X } from 'lucide-react';
import type { Resource, ResourceActionDefinition, ResourceRun, ResourceRunResult } from './resources';
import { mergeResourceRuns, sensitiveResourceParameter } from './resources';
import { InvocationTemplates } from './InvocationTemplates';

type Action = <T>(label: string, action: string, args: Record<string, unknown>) => Promise<T>;
const runLabels: Record<string, string> = { running: '运行中', succeeded: '执行成功', failed: '执行失败', stopped: '已停止', idle_released: '闲置后已释放', timed_out: '执行超时', cancelled: '已取消', exited: '已退出' };

export function ResourceActions({ resource, action, onChanged, readOnly = false, focusActionId, focusActionRevision, focusRequest = 0 }: { readOnly?: boolean; resource: Resource; action: Action; onChanged: (resource: Resource) => void; focusActionId?: string; focusActionRevision?: number; focusRequest?: number }) {
  const invocationAllowed = resource.enabled && resource.sceneEligible !== false && resource.effectiveEnabled !== false;
  const [runs, setRuns] = useState<ResourceRun[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedRevision, setSelectedRevision] = useState<number | null>(null);
  const [parameters, setParameters] = useState<Record<string, string>>({});
  const [templateBusy, setTemplateBusy] = useState(false), [viewTemplates, setViewTemplates] = useState<string | null>(null);
  const [result, setResult] = useState<ResourceRunResult | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState<string[]>([]);
  const [registering, setRegistering] = useState(false);
  const [label, setLabel] = useState(''), [executable, setExecutable] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState(resource.rootPath);
  const defaultWorkingDirectory = useRef(resource.rootPath);
  const [argumentsText, setArgumentsText] = useState('');
  const [mode, setMode] = useState<'task' | 'service'>('task');
  const [cancellable, setCancellable] = useState(false);
  const pending = useRef(false), alive = useRef(true), sequence = useRef(0);
  const templatePending = useRef(false);
  const stopLocks = useRef(new Set<string>());
  const actionRef = useRef(action); actionRef.current = action;
  const callForm = useRef<HTMLFormElement>(null), focusedAction = useRef('');
  useEffect(() => {
    const previous = defaultWorkingDirectory.current;
    defaultWorkingDirectory.current = resource.rootPath;
    setWorkingDirectory(current => current === previous ? resource.rootPath : current);
  }, [resource.rootPath]);
  const templateContext = JSON.stringify([resource.id, resource.revision, selected, selectedRevision, focusRequest, readOnly]);
  const templateContextRef = useRef(templateContext); templateContextRef.current = templateContext;
  useEffect(() => {
    if (!focusActionId || busy) return;
    const key = JSON.stringify([resource.id, focusActionId, focusRequest]);
    if (focusedAction.current === key) return;
    focusedAction.current = key;
    setSelected(null); setSelectedRevision(null); setParameters({}); setResult(null);
    if (readOnly || !invocationAllowed) { setError(readOnly ? '基本模式只查看已登记入口。' : !resource.enabled ? '此工具已手动停用，请重新核对后使用。' : resource.sceneReason || '当前场景未包含此工具。'); return; }
    if (resource.revision !== focusActionRevision || !resource.actions.some(item => item.id === focusActionId)) { setError('此动作已变化或不再存在，请重新搜索并核对。'); return; }
    setError(''); setSelected(focusActionId); setSelectedRevision(resource.revision); setRegistering(false);
  }, [resource, invocationAllowed, focusActionId, focusActionRevision, focusRequest, readOnly, busy]);
  useEffect(() => {
    if (selected && selectedRevision !== resource.revision && !busy) { setSelected(null); setSelectedRevision(null); setParameters({}); setError('工具信息已变化，请重新选择动作并核对参数。'); }
  }, [selected, selectedRevision, resource.revision, busy]);
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    // The parent first focuses the resource detail; keep the action input as the final target.
    queueMicrotask(() => {
      if (!cancelled) callForm.current?.querySelector<HTMLElement>('input, select, button[type="submit"]')?.focus({ preventScroll: true });
    });
    return () => { cancelled = true; };
  }, [selected, focusRequest]);
  const acceptRun = (run: ResourceRun) => setRuns(previous => mergeResourceRuns(previous, [run]));
  useEffect(() => {
    alive.current = true;
    let remove: (() => void) | undefined;
    let cancelled = false;
    const read = async () => {
      if (isTauri()) {
        try {
          const unlisten = await listen<{ run: ResourceRun }>('resource-runtime-updated', event => {
            if (event.payload.run.resourceId === resource.id && !cancelled) acceptRun(event.payload.run);
          });
          if (cancelled) { unlisten(); return; }
          remove = unlisten;
        } catch { if (!cancelled) setError('实时状态连接暂不可用，下面显示本次读取结果；重新打开详情可再次连接。'); }
      }
      const value = await actionRef.current<{ runs: ResourceRun[] }>('读取运行状态', 'resource_runtime', { id: resource.id });
      if (!cancelled) setRuns(previous => mergeResourceRuns(previous, value.runs));
    };
    void read().catch(cause => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; alive.current = false; sequence.current++; remove?.(); };
  }, [resource.id]);
  const definition = resource.actions.find(item => item.id === selected);
  const resultRun = result ? runs.find(run => run.runId === result.run.runId) || result.run : null;

  async function perform<T>(label: string, command: string, args: Record<string, unknown>, success: (value: T) => void) {
    if (pending.current || (readOnly && command !== 'resource_result')) return;
    pending.current = true; setBusy(true); setError('');
    const generation = ++sequence.current;
    try {
      const value = await actionRef.current<T>(label, command, args);
      if (alive.current && generation === sequence.current) success(value);
    } catch (cause) { if (alive.current && generation === sequence.current) setError(String(cause)); }
    finally { pending.current = false; if (alive.current && generation === sequence.current) setBusy(false); }
  }
  function invoke(definition: ResourceActionDefinition) {
    if (templatePending.current) return;
    if (readOnly || !invocationAllowed || selectedRevision !== resource.revision) { setError('此动作的状态已变化，请重新选择并核对。'); return; }
    const values: Record<string, string | number> = {};
    for (const parameter of definition.parameters) {
      const value = parameters[parameter.name] || '';
      if (!value && !parameter.required) continue;
      values[parameter.name] = parameter.kind === 'integer' ? Number(value) : value;
    }
    setResult(null);
    void perform<ResourceRunResult>(`执行${definition.label}`, 'resource_invoke', { id: resource.id, actionId: definition.id, expectedRevision: selectedRevision, parameters: values }, value => { acceptRun(value.run); setResult(value); });
  }
  async function stop(runId: string) {
    if (readOnly || stopLocks.current.has(runId)) return;
    stopLocks.current.add(runId); setStopping(previous => [...previous, runId]);
    try {
      const value = await actionRef.current<{ run: ResourceRun }>('停止对应进程', 'resource_stop', { runId });
      if (alive.current) acceptRun(value.run);
    } catch (cause) { if (alive.current) setError(String(cause)); }
    finally { stopLocks.current.delete(runId); if (alive.current) setStopping(previous => previous.filter(id => id !== runId)); }
  }
  async function chooseProgram() {
    try {
      const chosen = await open({ multiple: false, directory: false, title: '选择已安装的运行程序', filters: [{ name: 'Windows 程序', extensions: ['exe'] }] });
      if (typeof chosen === 'string' && alive.current) setExecutable(chosen);
    } catch (cause) { if (alive.current) setError(String(cause)); }
  }
  function register() {
    const definition: ResourceActionDefinition = {
      id: crypto.randomUUID(), label: label.trim(), mode, executable: executable.trim(), workingDirectory: workingDirectory.trim(), cancellable,
      args: argumentsText ? argumentsText.split(/\r?\n/).map(value => ({ type: 'literal' as const, value })) : [], parameters: [],
    };
    void perform<{ resource: Resource }>('登记运行入口', 'resource_action_set', { id: resource.id, expectedRevision: resource.revision, definition }, value => { onChanged(value.resource); setRegistering(false); setLabel(''); setExecutable(''); setArgumentsText(''); });
  }
  return <div className="resource-actions-panel">
    <div className="resource-editor-title"><h3>使用与运行</h3><button className="button" onClick={() => setRegistering(value => !value)} disabled={readOnly || busy}><Plus size={15} />登记运行入口</button></div>
    {resource.sceneEligible === false && <p className="muted" role="status">{resource.sceneReason || '当前场景未包含此工具。'} 现有任务保持，可继续查看结果或停止自有任务。</p>}
    {error && <div className="resource-error" role="alert">{error}</div>}
    {registering && !readOnly && <form className="resource-action-editor" aria-label="登记运行入口" onSubmit={event => { event.preventDefault(); register(); }} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }}>
      <p className="muted">选择已安装的程序和明确的参数。登记后由你或已连接的 Agent 调用。</p>
      <label>入口名称<input required maxLength={160} value={label} onChange={event => setLabel(event.target.value)} disabled={busy} /></label>
      <label>程序路径<div className="resource-folder-input"><input required value={executable} onChange={event => setExecutable(event.target.value)} disabled={busy} /><button className="button" type="button" onClick={() => void chooseProgram()} disabled={busy}>选择程序</button></div></label>
      <label>工作目录<input required value={workingDirectory} onChange={event => setWorkingDirectory(event.target.value)} disabled={busy} /></label>
      <label>运行方式<select value={mode} onChange={event => setMode(event.target.value as 'task' | 'service')} disabled={busy}><option value="task">任务：等待执行结果</option><option value="service">服务：在后台保持运行</option></select></label>
      {mode === 'task' && <label className="resource-checkbox"><input type="checkbox" checked={cancellable} disabled={busy} onChange={event => setCancellable(event.target.checked)} />此任务可安全中止，不会留下未完成的数据写入</label>}
      <label>固定参数，每行一个<textarea value={argumentsText} onChange={event => setArgumentsText(event.target.value)} placeholder="每行按原样作为一个参数传递" disabled={busy} /></label>
      <div className="resource-detail-actions"><button className="button primary" type="submit" disabled={busy || !label.trim() || !executable.trim() || !workingDirectory.trim()}>保存入口</button><button className="button" type="button" disabled={busy} onClick={() => setRegistering(false)}>取消</button></div>
    </form>}
    {!resource.actions.length && <p className="muted">尚未登记运行入口。目录登记不代表已经运行或验证通过。</p>}
    <div className="resource-action-list">{resource.actions.map(item => <div key={item.id}><div className="resource-action-row"><div><strong>{item.label}</strong><span className="muted">{item.mode === 'service' ? '后台服务' : '任务'}</span></div><div className="resource-detail-actions">{readOnly && <button className="button" type="button" aria-expanded={viewTemplates === item.id} onClick={() => setViewTemplates(previous => previous === item.id ? null : item.id)}>查看模板</button>}<button className="button" aria-label={`使用${item.label}`} onClick={() => { setSelected(item.id); setSelectedRevision(resource.revision); setParameters({}); setResult(null); setError(''); }} disabled={readOnly || busy || templateBusy || !invocationAllowed} title={readOnly ? '基本模式只查看已登记入口' : !resource.enabled ? '启用管理入口后可以使用' : resource.sceneEligible === false ? resource.sceneReason || '当前场景未包含此工具' : undefined}><Play size={15} />使用</button></div></div>{readOnly && viewTemplates === item.id && <InvocationTemplates resource={resource} definition={item} parameters={{}} action={action} onApply={() => {}} readOnly initialExpanded />}</div>)}</div>
    {definition && !readOnly && <form ref={callForm} className="resource-call-form" aria-label={`使用${definition.label}`} onSubmit={event => { event.preventDefault(); invoke(definition); }} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }}>
      <div className="resource-editor-title"><strong>{definition.label}</strong><button className="button" type="button" aria-label="关闭调用参数" onClick={() => { setSelected(null); setParameters({}); }} disabled={busy}><X size={15} /></button></div>
      <p className="muted">{definition.parameters.length ? '确认本次参数后执行。' : '此入口使用已登记的固定参数。'}</p>
      {definition.parameters.map(parameter => <label key={parameter.name}>{parameter.label}{parameter.kind === 'choice' && !sensitiveResourceParameter(parameter) ? <select aria-label={parameter.label} required={parameter.required} value={parameters[parameter.name] || ''} disabled={busy || templateBusy} onChange={event => setParameters(previous => ({ ...previous, [parameter.name]: event.target.value }))}><option value="">请选择</option>{parameter.choices?.map(value => <option key={value} value={value}>{value}</option>)}</select> : <input aria-label={parameter.label} required={parameter.required} type={sensitiveResourceParameter(parameter) ? 'password' : parameter.kind === 'integer' ? 'number' : 'text'} autoComplete={sensitiveResourceParameter(parameter) ? 'off' : undefined} min={parameter.min} max={parameter.max} maxLength={parameter.maxLength} value={parameters[parameter.name] || ''} disabled={busy || templateBusy} onChange={event => setParameters(previous => ({ ...previous, [parameter.name]: event.target.value }))} />}</label>)}
      <button className="button primary" disabled={readOnly || busy || templateBusy || !invocationAllowed} type="submit"><Play size={15} />{busy ? '正在执行…' : '执行'}</button>
      {selectedRevision === resource.revision && <InvocationTemplates key={templateContext} resource={resource} definition={definition} parameters={parameters} action={action} readOnly={readOnly} disabled={busy} onBusyChange={value => { templatePending.current = value; setTemplateBusy(value); }} onApply={values => {
        if (templateContextRef.current !== templateContext || pending.current || selectedRevision !== resource.revision || readOnly) return;
        setParameters(previous => ({ ...previous, ...Object.fromEntries(Object.entries(values).map(([name, value]) => [name, String(value)])) }));
      }} />}
    </form>}
    {runs.length > 0 && <div className="resource-run-list" aria-label="运行记录">{runs.map(run => <div className="resource-run-row" key={run.runId}><div><strong>{run.mode === 'service' && run.protocolSession ? 'Edge 浏览器连接' : resource.actions.find(item => item.id === run.actionId)?.label || run.actionId}</strong><span>{runLabels[run.status] || run.status}{run.exitCode != null ? ` · 退出码 ${run.exitCode}` : ''}</span><time dateTime={run.startedAt}>{new Date(run.startedAt).toLocaleString()}</time></div>{run.status === 'running' ? <button className="button" disabled={readOnly || stopping.includes(run.runId) || (run.mode !== 'service' && !run.cancellable)} title={readOnly ? '基本模式不执行进程操作' : run.mode !== 'service' && !run.cancellable ? '此任务未声明可安全中止，请等待完成' : undefined} onClick={() => void stop(run.runId)}><Square size={15} />{stopping.includes(run.runId) ? '正在停止…' : run.mode === 'service' && run.protocolSession ? '断开连接' : '停止'}</button> : <button className="button" disabled={busy} onClick={() => void perform<ResourceRunResult>('读取本次结果', 'resource_result', { runId: run.runId }, value => setResult(value))}>查看结果</button>}</div>)}</div>}
    {result && resultRun && <section className="resource-run-result" aria-label="本次运行结果"><strong>{runLabels[resultRun.status] || resultRun.status}</strong>{result.capabilityEvidenceWarning && <p className="resource-error" role="alert">调用结果已保留，实测记录未保存：{result.capabilityEvidenceWarning}</p>}{result.stdout && <pre>{result.stdout}</pre>}{result.stderr && <pre>{result.stderr}</pre>}{result.outputTruncated && <p>结果较长，当前显示已截断。</p>}<p className="muted">输出仅保留在本次会话中。</p></section>}
  </div>;
}
