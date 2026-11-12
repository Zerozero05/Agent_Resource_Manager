import { useEffect, useRef, useState } from 'react';
import './resource-space.css';

type Endpoint = { kind: 'tool' | 'skill'; id: string };
type Space = { endpoint: Endpoint; rootPath: string; scope?: 'singleRoot' | 'registeredRuntimeRoots'; rootCount?: number; scannedAt: string; observedBytes: number; fileCount: number; partial: boolean; skippedCount: number; reasons: string[]; categories: { id: string; label: string; bytes: number | null; files: number | null; reason?: string }[]; sharedDependencies: { kind: string; id: string; name: string; exists: boolean }[]; basis: string };
type Action = <T>(label: string, action: string, args: Record<string, unknown>) => Promise<T>;
const bytes = (value: number | null) => { if (value === null) return '未知'; const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let index = 0; while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; } return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[index]}`; };

export function ResourceSpace({ endpoint, action, revision, visible = true }: { endpoint: Endpoint; action: Action; revision: number; visible?: boolean }) {
  const [data, setData] = useState<Space | null>(null), [loadedRevision, setLoadedRevision] = useState<number | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const pending = useRef(false), generation = useRef(0), alive = useRef(true);
  const current = useRef({ endpoint, revision, visible }); current.current = { endpoint, revision, visible };
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  useEffect(() => { generation.current++; pending.current = false; setData(null); setLoadedRevision(null); setError(''); setBusy(false); }, [endpoint.kind, endpoint.id]);
  async function measure() {
    if (!visible || pending.current) return;
    const ticket = ++generation.current, original = { ...endpoint }, capturedRevision = revision;
    pending.current = true; setBusy(true); setError('');
    try {
      const value = await action<Space>('统计资源空间', 'resource_space', original);
      if (!alive.current || ticket !== generation.current || current.current.endpoint.id !== original.id || current.current.endpoint.kind !== original.kind) return;
      if (value.endpoint.id !== original.id || value.endpoint.kind !== original.kind) throw new Error('返回的资源不匹配，请重新统计。');
      setData(value); setLoadedRevision(capturedRevision);
    } catch (cause) { if (alive.current && ticket === generation.current) setError(String(cause instanceof Error ? cause.message : cause)); }
    finally { if (alive.current && ticket === generation.current) { pending.current = false; setBusy(false); } }
  }
  return <details className="resource-space"><summary>空间明细</summary>
    <div className="section-actions"><button type="button" disabled={busy || !visible} onClick={() => void measure()}>{busy ? '正在统计…' : data ? '重新统计' : '统计本目录空间'}</button>{data && <small className="muted">读取于 {new Date(data.scannedAt).toLocaleString()}</small>}</div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {data && <>
      <p><strong>{data.partial ? '已读取部分' : data.scope === 'registeredRuntimeRoots' ? '已登记版本目录的文件' : '本目录已读取文件'}：{bytes(data.observedBytes)}</strong> · {data.fileCount} 个文件{data.scope === 'registeredRuntimeRoots' && ` · ${data.rootCount} 个目录`}</p>
      {loadedRevision !== revision && <p className="helper-note">管理记录已变化，下面保留上次统计，可按需重新读取。</p>}
      <table><caption>按已有用途记录分类</caption><thead><tr><th>类别</th><th>逻辑大小</th><th>文件数</th></tr></thead><tbody>{data.categories.map(row => <tr key={row.id}><th scope="row">{row.label}{row.reason && <small>{row.reason}</small>}</th><td>{bytes(row.bytes)}</td><td>{row.files ?? '未知'}</td></tr>)}</tbody></table>
      {data.reasons.map(reason => <p className="helper-note" key={reason}>{reason}</p>)}
      {data.sharedDependencies.length > 0 && <p>共享依赖：{data.sharedDependencies.map(item => `${item.name}${item.exists ? '' : '（记录失效）'}`).join('、')}。只计量本次范围内实际读取的文件，共享目录不额外叠加。</p>}
      <p className="muted small-text">{data.basis}</p>
    </>}
    {!data && <p className="muted small-text">仅在点击后统计文件大小；不读取运行文件内容、不跟随目录联接，不执行清理。</p>}
  </details>;
}
