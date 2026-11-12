import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ResourceKind } from './resources';
import { isRuntimePackageSource, PackageSourceSummary, type RuntimePackageSource } from './ResourceSource';

type Action = <T>(label: string, action: string, args: Record<string, unknown>) => Promise<T>;
export type RecoveryRegistration = { name?: string; kind: ResourceKind; rootPath: string; repository?: string; version?: string };
type RecoveryFile = { path: string; role: string; bytes: number; sha256: string };
type Recovery = {
  schemaVersion: number; resourceId: string; installationId: string; kind: 'cli' | 'portable' | 'mcp'; version: string | null;
  source: { repository?: string | null; repositoryId?: number | null; releaseId?: number | null; assetId?: number | null; assetName?: string | null; archiveSha256?: string | null; runtimePackage?: RuntimePackageSource | null } | null;
  recordedComplete: boolean; canRegister: boolean; verifiedFiles: RecoveryFile[]; missingOrUnreadable: string[]; modifiedFiles: string[]; unknownFilesRetained: string[];
  ownership: 'external'; sourceVerified: false; executionGrant: false; deleteGrant: false; automaticUpdateGrant: false; message: string;
};
const roleNames: Record<string, string> = { runtime: '运行文件', privateDependency: '专用依赖', license: '许可证' };
const kinds = { cli: '命令行工具', portable: '便携程序', mcp: 'MCP 服务' };
const size = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${bytes} B`;
function valid(value: Recovery): boolean {
  return !!value && value.schemaVersion === 1 && ['cli', 'portable', 'mcp'].includes(value.kind) && value.ownership === 'external'
    && value.sourceVerified === false && value.executionGrant === false && value.deleteGrant === false && value.automaticUpdateGrant === false
    && typeof value.canRegister === 'boolean' && typeof value.recordedComplete === 'boolean' && typeof value.message === 'string'
    && (value.version === null || typeof value.version === 'string') && (value.source === null || typeof value.source === 'object' && (value.source.repository == null || typeof value.source.repository === 'string'))
    && (value.source?.runtimePackage == null || isRuntimePackageSource(value.source.runtimePackage))
    && Array.isArray(value.verifiedFiles) && value.verifiedFiles.every(file => !!file && typeof file === 'object' && typeof file.path === 'string' && typeof file.sha256 === 'string' && typeof file.role === 'string' && typeof file.bytes === 'number' && Number.isFinite(file.bytes) && file.bytes >= 0)
    && [value.missingOrUnreadable, value.modifiedFiles, value.unknownFilesRetained].every(list => Array.isArray(list) && list.every(path => typeof path === 'string'));
}
function Findings({ title, values, opened = false }: { title: string; values: (string | RecoveryFile)[]; opened?: boolean }) {
  const [limit, setLimit] = useState(100);
  useEffect(() => { setLimit(100); }, [values]);
  return <details open={opened} aria-label={title}><summary>{title}（{values.length}）</summary>
    {values.length === 0 ? <p className="muted">无</p> : <><ul>{values.slice(0, limit).map((item, index) => <li key={index}>{typeof item === 'string' ? <span className="resource-path">{item}</span> : <><strong className="resource-path">{item.path}</strong><small>{roleNames[item.role] || item.role} · {size(item.bytes)}</small><small className="resource-path">SHA-256：{item.sha256}</small></>}</li>)}</ul>{values.length > limit && <button className="button" type="button" onClick={() => setLimit(previous => previous + 100)}>再显示 100 项（剩余 {values.length - limit}）</button>}</>}
  </details>;
}

export function ResourceRecovery({ rootPath, action, visible = true, readOnly = false, onUse }: { rootPath: string; action: Action; visible?: boolean; readOnly?: boolean; onUse: (value: RecoveryRegistration) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [result, setResult] = useState<{ root: string; value: Recovery; epoch: number } | null>(null), [used, setUsed] = useState(false);
  const mounted = useRef(true), lock = useRef(false), epoch = useRef(0), consumed = useRef(false);
  const current = useRef({ rootPath, visible, readOnly }); current.current = { rootPath, visible, readOnly };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; }; }, []);
  useLayoutEffect(() => { epoch.current++; setResult(null); setUsed(false); consumed.current = false; setError(''); setNotice(''); }, [rootPath, visible, readOnly]);
  const preview = result?.root === rootPath && result.epoch === epoch.current ? result : null;
  async function load() {
    const original = current.current;
    if (!original.visible || original.readOnly || lock.current || !original.rootPath.trim()) return;
    const generation = ++epoch.current;
    lock.current = true; consumed.current = false; setBusy(true); setResult(null); setUsed(false); setError(''); setNotice('');
    try {
      const value = await action<Recovery>('读取资源管理记录并核对文件', 'preview_resource_recover', { rootPath: original.rootPath.trim() });
      if (!mounted.current || generation !== epoch.current || current.current.rootPath !== original.rootPath || !current.current.visible || current.current.readOnly) return;
      if (!valid(value)) throw new Error('管理记录预览格式或权限状态异常，未填入登记信息。');
      setResult({ root: original.rootPath, value, epoch: generation });
    } catch (cause) {
      if (mounted.current && generation === epoch.current && current.current.visible && !current.current.readOnly && current.current.rootPath === original.rootPath) setError(String(cause));
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  function useInformation() {
    if (!preview || !preview.value.canRegister || lock.current || consumed.current || !current.current.visible || current.current.readOnly || current.current.rootPath !== preview.root) return;
    const value = preview.value;
    try {
      consumed.current = true;
      onUse({ kind: value.kind, rootPath: preview.root.trim(), ...(value.source?.repository ? { repository: value.source.repository } : {}), ...(value.version ? { version: value.version } : {}) });
      setUsed(true); setNotice('已填入待登记信息，请核对后单独保存；尚未登记或授权。');
    } catch (cause) { consumed.current = false; setError(String(cause)); }
  }
  if (!visible || readOnly) return null;
  return <section className="resource-repair" aria-label="读取资源管理记录" aria-busy={busy}>
    <div className="resource-detail-actions"><button className="button" type="button" disabled={busy || !rootPath.trim()} onClick={() => void load()}>{busy ? '正在核对管理记录…' : '读取资源管理记录'}</button></div>
    {error && <p className="resource-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {preview && <section className="resource-lifecycle-panel" aria-label="资源管理记录预览">
      <div className="resource-editor-title"><h3>核对待登记信息</h3><button className="button" type="button" onClick={() => { epoch.current++; setResult(null); setNotice(''); }}>收起预览</button></div>
      <dl><dt>目录</dt><dd className="resource-path">{preview.root.trim()}</dd><dt>工具类型</dt><dd>{kinds[preview.value.kind]}</dd><dt>记录版本</dt><dd>{preview.value.version || '未知'}</dd><dt>来源</dt><dd className="resource-path">{preview.value.source?.repository || '未记录'}</dd></dl>
      {preview.value.source?.runtimePackage && <PackageSourceSummary value={preview.value.source.runtimePackage} unverified />}
      <p className="muted">{preview.value.message}</p>
      <dl aria-label="接管权限状态"><dt>来源身份</dt><dd>尚未独立核验</dd><dt>执行权限</dt><dd>未授予</dd><dt>删除权限</dt><dd>未授予</dd><dt>自动更新</dt><dd>未授权</dd></dl>
      {!preview.value.recordedComplete && <p role="alert">管理记录标记为部分完成。</p>}
      <div className="resource-effect-preview"><Findings title="内容匹配的文件" values={preview.value.verifiedFiles} opened /><Findings title="缺失或不可读取" values={preview.value.missingOrUnreadable} opened={preview.value.missingOrUnreadable.length > 0} /><Findings title="本地已修改" values={preview.value.modifiedFiles} opened={preview.value.modifiedFiles.length > 0} /><Findings title="其余文件，原位保留" values={preview.value.unknownFilesRetained} /></div>
      {!preview.value.canRegister && <p role="status">记录或文件尚未完整核对，暂不能用作登记信息；现有文件保持。</p>}
      <div className="resource-detail-actions"><button className="button primary" type="button" disabled={busy || used || !preview.value.canRegister} onClick={useInformation}>用作登记信息</button><span className="muted">只填写表单，保存登记需另行确认。</span></div>
    </section>}
  </section>;
}
