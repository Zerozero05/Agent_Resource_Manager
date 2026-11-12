import { useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { Wrench, X } from 'lucide-react';
import type { Resource } from './resources';

type Action = <T>(label: string, action: string, args: Record<string, unknown>) => Promise<T>;
type RepairFile = { path: string; target?: string; role: string; decision: 'restore' | 'preserve'; reason: string; temporaryPath?: string };
type RepairArtifact = { path: string; file: { bytes: number; sha256: string; modified?: unknown }; origin: { kind: 'npmRegistry'; registry: string; package: string; version: string; repository: string; tarball: string; integrity: string } | { kind: 'githubRelease'; source: { repository: string; version: string; assetName: string; downloadUrl: string } } | { kind: 'pyPiWheel'; package: string; version: string; filename: string; url: string } };
type RuntimeSourceFile = { path: string; target: string; bytes: number; sha256: string };
type RepairPlan = { id: string; kind: 'resourceRepair'; resourceId: string; targetPath: string; archivePath: string | null; sourceFormat?: 'npmTgz' | 'pythonWheel' | 'zip'; sourcePaths?: string[]; source: { repository?: string | null; version?: string | null; verification?: string; recipe?: string; artifacts?: RepairArtifact[]; runtimeFiles?: RuntimeSourceFile[] }; files: RepairFile[]; requiredBytes: number; canApply: boolean; completionOnly?: boolean; warnings: string[]; temporaryPaths?: string[]; retainedTemporaryPaths?: string[] };
type RepairReceipt = { restored: string[]; retained: string[]; failures: [string, string][]; temporaryPaths: string[] };
type RepairResult = { resource: Resource; receipt: RepairReceipt; complete: boolean; ownershipSaved: boolean };
const roleLabels: Record<string, string> = { runtime: '运行文件', privateDependency: '专用依赖', configuration: '配置文件', userData: '用户数据', cache: '缓存', localModification: '本地改造', license: '许可证' };
const bytes = (value: number) => value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MiB` : `${value} B`;

function PackageRepairSources({ plan }: { plan: RepairPlan }) {
  const artifacts = plan.source.artifacts || [], runtimeFiles = plan.source.runtimeFiles || [], npm = plan.sourceFormat === 'npmTgz';
  const paths = plan.sourcePaths || [...new Set([...artifacts.map(artifact => artifact.path), ...runtimeFiles.map(file => file.path)])];
  return <section className="resource-repair-sources" aria-label={npm ? '本次核对的 npm 资产' : '本次核对的 wheel 与原 Python 文件'}><h4>{npm ? '本次核对的 TGZ' : '本次核对的源文件'}（{paths.length}）</h4>{!paths.length ? <p className="muted">本次没有需要读取的源文件；保留项及原因见修复范围。</p> : <ul>{paths.map(path => {
    const artifact = artifacts.find(item => item.path === path), original = runtimeFiles.filter(file => file.path === path), runtimeFile = original[0];
    const origin = artifact?.origin, sourceUrl = origin?.kind === 'npmRegistry' ? origin.tarball : origin?.kind === 'githubRelease' ? origin.source.downloadUrl : origin?.url;
    const label = origin?.kind === 'githubRelease' ? `${origin.source.assetName} · ${origin.source.version}` : origin ? `${origin.package} · ${origin.version}` : runtimeFile ? '原 Python 文件' : '绑定运行环境（仅核对）';
    const fingerprint = artifact?.file || runtimeFile;
    return <li key={path}><strong>{label}</strong><code className="resource-path">{path}</code>{fingerprint && <small title={fingerprint.sha256}>{bytes(fingerprint.bytes)} · SHA-256：{fingerprint.sha256.slice(0, 16)}…</small>}{runtimeFile && <p>补齐到：{original.map(file => file.target).join('、')}</p>}{(fingerprint || sourceUrl) && <details><summary>来源与完整校验摘要</summary><dl>{sourceUrl && <><dt>原资产地址</dt><dd className="resource-path">{sourceUrl}</dd></>}{fingerprint && <><dt>SHA-256</dt><dd className="resource-path">{fingerprint.sha256}</dd></>}{origin?.kind === 'npmRegistry' && <><dt>npm integrity</dt><dd className="resource-path">{origin.integrity}</dd></>}</dl></details>}</li>;
  })}</ul>}</section>;
}

export function ResourceRepair({ resource, action, onChanged, readOnly = false }: { resource: Resource; action: Action; onChanged: (value: Resource) => void; readOnly?: boolean }) {
  const [opened, setOpened] = useState(false), [archivePath, setArchivePath] = useState('');
  const [artifactDirectory, setArtifactDirectory] = useState('');
  const [plan, setPlan] = useState<{ value: RepairPlan; resourceKey: string } | null>(null), [result, setResult] = useState<(RepairResult & { completionOnly: boolean }) | null>(null);
  const [phase, setPhase] = useState<'preview' | 'apply' | 'choose' | null>(null), [error, setError] = useState('');
  const mounted = useRef(true), epoch = useRef(0), viewEpoch = useRef(0), lock = useRef(false), openedRef = useRef(false), restoreFocus = useRef(false), origin = useRef<HTMLButtonElement>(null);
  const resourceKey = `${resource.id}:${resource.revision}:${readOnly}`;
  const currentKey = useRef(resourceKey); currentKey.current = resourceKey;
  const currentResource = useRef(resource); currentResource.current = resource;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; viewEpoch.current++; }; }, []);
  useEffect(() => { viewEpoch.current++; setResult(null); setArtifactDirectory(''); }, [resource.id]);
  useEffect(() => { epoch.current++; setPlan(null); setError(''); }, [resourceKey]);
  useEffect(() => { if (!opened && phase === null && restoreFocus.current) { restoreFocus.current = false; origin.current?.focus(); } }, [opened, phase]);
  const visiblePlan = plan?.resourceKey === resourceKey ? plan.value : null;
  const visibleResult = result?.resource.id === resource.id ? result : null;
  const recipe = resource.installation?.runtimePackage?.recipe, npmPackage = recipe === 'edgeMcpNpmV1', reachPackage = recipe === 'agentReachWheelV1', packageMode = npmPackage || reachPackage;
  function invalidate() { epoch.current++; setPlan(null); setResult(null); setError(''); }
  function begin() { if (readOnly || lock.current) return; invalidate(); viewEpoch.current++; openedRef.current = true; setOpened(true); }
  function close() { if (phase === 'apply') return; epoch.current++; viewEpoch.current++; setPlan(null); openedRef.current = false; restoreFocus.current = true; setOpened(false); }
  function active(generation: number, key: string) { return mounted.current && openedRef.current && generation === epoch.current && key === currentKey.current; }
  function applyActive(generation: number, id: string) { return mounted.current && openedRef.current && generation === viewEpoch.current && currentResource.current.id === id; }
  async function preview() {
    if (readOnly || lock.current) return;
    invalidate(); const generation = epoch.current, key = resourceKey;
    lock.current = true; setPhase('preview');
    try {
      const value = await action<RepairPlan>('核对固定版本缺失文件', 'preview_resource_repair', { id: resource.id, expectedRevision: resource.revision, ...(packageMode ? artifactDirectory.trim() ? { artifactDirectory: artifactDirectory.trim() } : {} : archivePath.trim() ? { archivePath: archivePath.trim() } : {}) });
      if (active(generation, key)) setPlan({ value, resourceKey: key });
    } catch (cause) { if (active(generation, key)) setError(String(cause)); }
    finally { lock.current = false; if (mounted.current) setPhase(null); }
  }
  async function chooseArchive() {
    if (readOnly || lock.current) return;
    const generation = epoch.current, key = resourceKey;
    lock.current = true; setPhase('choose');
    try {
      const value = await open(packageMode ? { directory: true, multiple: false, title: npmPackage ? '选择原精确 npm TGZ 资产所在目录' : '选择原精确 wheel 资产所在目录' } : { multiple: false, filters: [{ name: '原固定版本的 ZIP', extensions: ['zip'] }], title: '选择与原安装包完全一致的 ZIP' });
      if (active(generation, key) && typeof value === 'string') { invalidate(); if (packageMode) setArtifactDirectory(value); else setArchivePath(value); }
    } catch (cause) { if (active(generation, key)) setError(String(cause)); }
    finally { lock.current = false; if (mounted.current) setPhase(null); }
  }
  async function apply() {
    if (readOnly || lock.current || !visiblePlan?.canApply) return;
    const generation = viewEpoch.current, id = resource.id;
    lock.current = true; setPhase('apply'); setError('');
    try {
      const value = await action<RepairResult>(visiblePlan.completionOnly ? '核验并完成上次修复' : '补齐已确认的固定版本文件', 'apply_resource_repair', { previewId: visiblePlan.id });
      if (applyActive(generation, id)) {
        setPlan(null); setResult({ ...value, completionOnly: !!visiblePlan.completionOnly });
        // Catalog events may arrive before this task receipt; preserve newer metadata.
        if (value.resource.revision >= currentResource.current.revision) onChanged(value.resource);
      }
    } catch (cause) { if (applyActive(generation, id)) { setPlan(null); setError(String(cause)); } }
    finally { lock.current = false; if (mounted.current) setPhase(null); }
  }
  if (readOnly) return null;
  return <div className="resource-repair">
    <button className="button" type="button" ref={origin} disabled={phase !== null} aria-expanded={opened} onClick={opened ? close : begin}><Wrench size={15} />修复缺失文件</button>
    {opened && <section className="resource-lifecycle-panel" aria-label={`修复 ${resource.name}`} aria-busy={phase !== null}>
      <div className="resource-editor-title"><h3>补齐原版本缺失文件</h3><button className="button" type="button" disabled={phase === 'apply'} aria-label="关闭修复" onClick={close}><X size={16} /></button></div>
      <p className="muted">先核对原安装记录与发行包，只补齐清单内的缺失文件。已有内容和本地改造按核对结果保留；此处不升级、下载或启动工具，完成后按核对结果保留或恢复原启用选择。</p>
      {error && <div className="resource-error" role="alert">{error}</div>}
      <form onSubmit={event => { event.preventDefault(); void preview(); }} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); close(); } }}>
        <fieldset disabled={phase !== null}>
          {packageMode ? <><label>{npmPackage ? '原精确 npm 资产目录（可选）' : '原精确 wheel 资产目录（可选）'}<div className="resource-folder-input"><input aria-label={npmPackage ? '原精确 npm 资产目录' : '原精确 wheel 资产目录'} value={artifactDirectory} placeholder={npmPackage ? '留空沿用原 TGZ 资产路径' : '留空沿用原 wheel 资产路径'} onChange={event => { invalidate(); setArtifactDirectory(event.target.value); }} /><button className="button" type="button" onClick={() => void chooseArchive()}>选择资产目录</button></div></label><p className="muted">{npmPackage ? 'TGZ 已移走时，可选择同一批原资产所在的本地目录。仅核对缺失文件对应的包、原版本、摘要和 integrity；不联网下载或覆盖已有文件。' : 'wheel 已移走时，可选择同一批原资产所在的本地目录。仅使用已核对的原 wheel 载荷、许可证及原 Python 文件；无法可信重建的生成项由预览逐项说明。不联网、不重装或覆盖已有文件。'}</p></> : <><label>原版本 ZIP（可选）<div className="resource-folder-input"><input value={archivePath} placeholder="留空使用安装记录中的原包" onChange={event => { invalidate(); setArchivePath(event.target.value); }} /><button className="button" type="button" onClick={() => void chooseArchive()}>选择 ZIP</button></div></label><p className="muted">原包已移走时，可以选择重新取得的同一 ZIP；程序会核对原安装包摘要，不仅比较版本名称。</p></>}
          <div className="resource-detail-actions"><button className="button" type="submit">预览修复范围</button></div>
        </fieldset>
      </form>
      {visiblePlan && <section className="resource-effect-preview" aria-label="修复影响清单">
        <h4>{visiblePlan.completionOnly ? '核验并完成上次修复' : '本次核对结果'}</h4>
        {visiblePlan.completionOnly && <p>上次文件已补齐，本次只核验已有文件并完成记录，不再解包。仍须确认后才执行。</p>}
        <dl><dt>原固定版本</dt><dd>{visiblePlan.source.version || '原记录未提供版本名称，以原资产摘要核对'}</dd><dt>原来源</dt><dd>{visiblePlan.source.repository || '原记录未提供来源'}</dd>{visiblePlan.sourceFormat !== 'npmTgz' && visiblePlan.archivePath && <><dt>{visiblePlan.completionOnly ? '原发行包记录' : '核对发行包'}</dt><dd className="resource-path">{visiblePlan.archivePath}</dd></>}<dt>修复目录</dt><dd className="resource-path">{visiblePlan.targetPath}</dd><dt>需补齐大小</dt><dd>{bytes(visiblePlan.requiredBytes)}</dd></dl>
        {(visiblePlan.sourceFormat === 'npmTgz' || visiblePlan.sourceFormat === 'pythonWheel') && <PackageRepairSources plan={visiblePlan} />}
        {!visiblePlan.canApply && <p role="status">{visiblePlan.files.some(file => file.decision === 'restore') ? '当前无法安全补齐，请查看下方原因。' : '当前清单无需补齐运行文件；保留项及原因见下方。'}</p>}
        <ul>{visiblePlan.files.map(file => <li key={file.path}><strong>{file.decision === 'restore' ? '补齐' : '保留'} · {roleLabels[file.role] || file.role}</strong><span className="resource-path">{file.target || file.path}</span><small>{file.reason}</small></li>)}</ul>
        {!!visiblePlan.temporaryPaths?.length && <div><h4>本次临时位置</h4><ul>{visiblePlan.temporaryPaths.map(path => <li className="resource-path" key={path}>{path}</li>)}</ul></div>}
        {!!visiblePlan.retainedTemporaryPaths?.length && <section aria-label="保留的历史临时文件"><h4>保留的历史临时文件</h4><p>这些文件原样保留，本次不复用、不删除。</p><ul>{visiblePlan.retainedTemporaryPaths.map(path => <li className="resource-path" key={path}>{path}</li>)}</ul></section>}
        {visiblePlan.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
        <div className="resource-detail-actions"><button className="button primary" type="button" disabled={phase !== null || !visiblePlan.canApply} onClick={() => void apply()}>{visiblePlan.completionOnly ? '核验并完成上次修复' : '确认补齐这些文件'}</button></div>
      </section>}
      {visibleResult && <section className="resource-repair-result" aria-label="本次修复结果">
        <h4>本次处理结果</h4>
        <p role="status">{visibleResult.complete && visibleResult.ownershipSaved ? `${visibleResult.completionOnly ? '已有文件已核验，上次修复记录已完成。' : '所选缺失文件已补齐并记录。'}本次完成时资源为${visibleResult.resource.enabled ? '已启用' : '已停用'}；修复未启动工具，运行能力仍需验证。` : '本次修复未完整完成，请核对下列结果。'}</p>
        {!visibleResult.ownershipSaved && <p role="alert">文件归属记录尚未保存，不能将本次处理视为修复完成。</p>}
        <ul>{visibleResult.receipt.restored.map(path => <li key={`restored:${path}`}><strong>已补齐</strong><span className="resource-path">{path}</span></li>)}{visibleResult.receipt.retained.map(path => <li key={`retained:${path}`}><strong>已保留</strong><span className="resource-path">{path}</span></li>)}{visibleResult.receipt.failures.map(([path, reason], index) => <li key={`failed:${index}`}><strong>未完成</strong><span className="resource-path">{path}</span><small>{reason}</small></li>)}</ul>
        {!!visibleResult.receipt.temporaryPaths.length && <div><h4>仍需核对的临时位置</h4><ul>{visibleResult.receipt.temporaryPaths.map(path => <li className="resource-path" key={path}>{path}</li>)}</ul></div>}
      </section>}
    </section>}
  </div>;
}
