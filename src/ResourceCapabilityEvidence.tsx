import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Resource } from './resources';

type Action = <T>(label: string, action: string, args: Record<string, unknown>) => Promise<T>;
type ProtocolEvidence = { method: 'tools/call' | null; toolName: 'browser_tabs' | 'browser_snapshot' | null; protocolVersion: string | null; rpcResultReceived: boolean; isError: boolean | null; jsonRpcError: boolean };
type Evidence = { runId: string; resourceId: string; actionId: string; version: string | null; rootPath: string; entryPath: string; scope: string; startedAt: string; finishedAt: string; processStatus: string; exitCode: number | null; completionKind?: 'processExit' | 'mcpToolCall'; protocol?: ProtocolEvidence | null };
type ActionStatus = { actionId: string; label: string; mode: string; status: 'passed' | 'failed' | 'stale' | 'unverified'; reason: string; latest: Evidence | null };
type Status = { resourceId: string; version: string | null; rootPath: string; checkedAt: string; actions: ActionStatus[]; removedActionEvidence: Evidence[]; history: Evidence[]; total: number; historyLimit: number; scope: 'ownedActionCompletion'; parametersStored: false; outputStored: false; platformCallsVerified: false; userSessionVerified: false };
const names: Record<string, string> = { passed: '命令完成', failed: '命令失败', stale: '需复核', unverified: '未核验' };
const scopeNames: Record<string, string> = { cliVersionCommand: '版本命令退出', cliHelpCommand: '帮助命令退出', localDoctorCommand: '本地依赖检查命令退出', channelListingCommand: '平台清单命令退出', registeredTaskExit: '登记动作进程退出', mcpToolCall: '单个 MCP 工具调用' };
const protocolVersions = new Set(['2025-11-25', '2025-06-18', '2025-03-26']);
const tools: Record<string, string> = { 'edge-tabs': 'browser_tabs', 'edge-snapshot': 'browser_snapshot' };
const toolNames: Record<string, string> = { browser_tabs: '列出标签页', browser_snapshot: '读取当前页面' };
const date = (value: string) => { const parsed = new Date(value); return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString(); };
function validProtocol(value: ProtocolEvidence): boolean {
  return !!value && Object.keys(value).every(key => ['method', 'toolName', 'protocolVersion', 'rpcResultReceived', 'isError', 'jsonRpcError'].includes(key)) && (value.method === null || value.method === 'tools/call') && (value.toolName === null || Object.hasOwn(toolNames, value.toolName)) && (value.protocolVersion === null || typeof value.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.protocolVersion)) && typeof value.rpcResultReceived === 'boolean' && (value.isError === null || typeof value.isError === 'boolean') && typeof value.jsonRpcError === 'boolean';
}
function validEvidence(value: Evidence): boolean {
  return !!value && typeof value.runId === 'string' && typeof value.resourceId === 'string' && typeof value.actionId === 'string' && typeof value.rootPath === 'string' && typeof value.entryPath === 'string' && typeof value.scope === 'string' && typeof value.startedAt === 'string' && typeof value.finishedAt === 'string' && typeof value.processStatus === 'string' && (value.version === null || typeof value.version === 'string') && (value.exitCode === null || typeof value.exitCode === 'number') && (value.completionKind === undefined || value.completionKind === 'processExit' || value.completionKind === 'mcpToolCall') && (value.completionKind === 'mcpToolCall' ? validProtocol(value.protocol!) : value.protocol == null);
}
function completed(value: Evidence): boolean {
  if (value.completionKind !== 'mcpToolCall') return value.processStatus === 'succeeded' && value.exitCode === 0;
  const protocol = value.protocol;
  return value.processStatus === 'succeeded' && value.exitCode === null && !!protocol && protocol.method === 'tools/call' && protocol.toolName === tools[value.actionId] && !!protocol.protocolVersion && protocolVersions.has(protocol.protocolVersion) && protocol.rpcResultReceived && protocol.isError === false && !protocol.jsonRpcError;
}
function completionName(value: Evidence): string { return value.completionKind === 'mcpToolCall' ? completed(value) ? 'MCP调用完成' : 'MCP调用失败' : completed(value) ? '命令完成' : '命令失败'; }
function statusName(value: ActionStatus): string { return value.latest?.completionKind === 'mcpToolCall' && (value.status === 'passed' || value.status === 'failed') ? value.status === 'passed' ? 'MCP调用完成' : 'MCP调用失败' : names[value.status]; }
function valid(value: Status, id: string): boolean {
  const ownedEvidence = (item: Evidence) => validEvidence(item) && item.resourceId === id;
  return !!value && value.resourceId === id && value.scope === 'ownedActionCompletion' && value.parametersStored === false && value.outputStored === false && value.platformCallsVerified === false && value.userSessionVerified === false && typeof value.checkedAt === 'string' && typeof value.total === 'number' && typeof value.historyLimit === 'number' && Array.isArray(value.actions) && value.actions.every(item => !!item && typeof item.actionId === 'string' && typeof item.label === 'string' && typeof item.reason === 'string' && Object.hasOwn(names, item.status) && (item.latest === null || ownedEvidence(item.latest) && item.latest.actionId === item.actionId) && (item.status !== 'passed' || item.mode === 'task' && !!item.latest && completed(item.latest) && (!Object.hasOwn(tools, item.actionId) || item.latest.completionKind === 'mcpToolCall'))) && Array.isArray(value.history) && value.history.every(ownedEvidence) && Array.isArray(value.removedActionEvidence) && value.removedActionEvidence.every(ownedEvidence);
}
function Record({ value }: { value: Evidence }) {
  const protocol = value.completionKind === 'mcpToolCall' ? value.protocol : null;
  return <dl><dt>当时版本</dt><dd>{value.version || '未知'}</dd><dt>实际入口</dt><dd className="resource-path">{value.entryPath}</dd><dt>开始／完成</dt><dd>{date(value.startedAt)} → {date(value.finishedAt)}</dd>{protocol ? <><dt>MCP动作</dt><dd>{protocol.toolName ? `${toolNames[protocol.toolName]} · ${protocol.toolName}` : '未取得匹配动作'}</dd><dt>协议版本</dt><dd>{protocol.protocolVersion || '未完成协商'}</dd><dt>完成状态</dt><dd>{value.processStatus} · {completionName(value)}</dd></> : <><dt>退出状态</dt><dd>{value.processStatus} · 退出码 {value.exitCode ?? '未知'}</dd></>}<dt>证明范围</dt><dd>{scopeNames[value.scope] || value.scope}</dd></dl>;
}

export function ResourceCapabilityEvidence({ resource, action, visible = true }: { resource: Resource; action: Action; visible?: boolean }) {
  const [expanded, setExpanded] = useState(false), [busy, setBusy] = useState(false), [result, setResult] = useState<Status | null>(null), [error, setError] = useState('');
  const key = JSON.stringify([resource.id, resource.rootPath, resource.version, resource.repository, resource.actions]);
  const epoch = useRef(0), mounted = useRef(true), lock = useRef(false), disclosure = useRef<HTMLButtonElement>(null);
  const current = useRef({ key, visible, expanded, id: resource.id }); current.current = { key, visible, expanded, id: resource.id };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; }; }, []);
  useLayoutEffect(() => { epoch.current++; setResult(null); setError(''); }, [key, visible]);
  async function load() {
    if (lock.current || !current.current.visible || !current.current.expanded) return;
    const generation = ++epoch.current, original = current.current;
    lock.current = true; setBusy(true); setError('');
    try {
      const value = await action<Status>('核对实际调用证据', 'resource_capability_evidence', { resourceId: original.id });
      if (!mounted.current || generation !== epoch.current || !current.current.visible || !current.current.expanded || current.current.key !== original.key) return;
      if (!valid(value, original.id)) throw new Error('调用证据格式或证明范围异常，未显示为通过。');
      setResult(value);
    } catch (cause) { if (mounted.current && generation === epoch.current && current.current.visible && current.current.expanded) { setResult(null); setError(String(cause)); } }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  function toggle() { if (expanded) { epoch.current++; setExpanded(false); setError(''); disclosure.current?.focus({ preventScroll: true }); } else setExpanded(true); }
  if (!visible) return null;
  return <section className="resource-repair" aria-label="实际调用证据">
    <button className="button" ref={disclosure} type="button" aria-expanded={expanded} onClick={toggle}>调用证据</button>
    {expanded && <div className="resource-github">
      <div className="resource-detail-actions"><button className="button" type="button" disabled={busy} onClick={() => void load()}>{busy ? '正在核对…' : result ? '重新核对' : '读取调用证据'}</button>{result && <small className="muted">上次核对 {date(result.checkedAt)}</small>}</div>
      {error && <p role="alert" className="resource-error">{error}</p>}
      {result && <div aria-label="动作核验结果">
        {result.actions.length === 0 ? <p className="muted">尚未登记调用动作。</p> : <ul className="resource-capabilities">{result.actions.map(item => <li key={item.actionId}><div><strong>{item.label}</strong><span className={`badge ${item.status === 'passed' ? 'green' : item.status === 'failed' ? 'red' : item.status === 'stale' ? 'amber' : 'neutral'}`}>{statusName(item)}</span></div><p>{item.reason}</p>{item.latest && <details><summary>版本、入口与时间</summary><Record value={item.latest} /></details>}</li>)}</ul>}
        <details><summary>历史记录（{result.total}）</summary>{result.history.length ? <ul>{result.history.map(item => <li key={item.runId}><details><summary>{item.actionId} · {date(item.finishedAt)} · {completionName(item)}</summary><Record value={item} /></details></li>)}</ul> : <p className="muted">尚无已完成的受管任务。</p>}{result.total > result.history.length && <p className="muted">此处显示最近 {result.historyLimit} 条；其余记录仍保存在管理数据库中。</p>}</details>
        {result.removedActionEvidence.length > 0 && <details><summary>已移除动作的历史（{result.removedActionEvidence.length}）</summary><ul>{result.removedActionEvidence.map(item => <li key={item.runId}><details><summary>{item.actionId}</summary><Record value={item} /></details></li>)}</ul></details>}
      </div>}
    </div>}
  </section>;
}
