import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { Package, Trash2, X } from 'lucide-react';
import { resourceKinds, type Resource, type ResourceKind } from './resources';
import { ResourceGithub, type GithubDownload } from './ResourceGithub';
import { RuntimePackageInstall } from './RuntimePackageInstall';
import { RemovalHistory } from './RemovalHistory';

type Action = <T>(label: string, action: string, args: Record<string, unknown>) => Promise<T>;
type PackageFile = { path: string; bytes: number; license: boolean; role?: string };
type PackageInventory = { archivePath: string; files: PackageFile[]; unpackedBytes: number };
type InstallPlan = { id: string; kind: 'resourceInstall'; archivePath: string; targetPath: string; files: PackageFile[]; selectedBytes: number; source: { repository?: string; version?: string; verification: string }; canApply: boolean; warnings: string[] };
type RemovalEntry = { path: string; relative: string; role: string; remove: boolean; reason: string; expected?: { bytes: number } | null; runtimeId?: string; runtimeLabel?: string; selectionId?: string };
type SystemEntry = { id: string; address: { kind: string; path?: string; target?: string; key?: string; valueName?: string; token?: string }; operation: string; requested: boolean; reason: string };
type MetadataEntry = { id: string; runtimeId: string; runtimeLabel: string; path: string; requested: boolean; remove: boolean; status: string; reason: string };
type ProtectedEntry = { path: string; reason: string; runtimeId: string };
type RemovalPlan = { id: string; kind: 'resourceRemove'; resourceId: string; resourceName: string; targetPath: string; extent: string; entries: RemovalEntry[]; systemEntries?: SystemEntry[]; metadataEntries?: MetadataEntry[]; protectedEntries?: ProtectedEntry[]; canApply: boolean; warnings: string[] };
type RemovalResultEntry = { id: string; path?: string; status: string; reason: string };
type RemovalResult = { resource: Resource; complete: boolean; result?: { failures?: [string, string][]; retained?: string[]; deleted?: string[] }; persistenceError?: string | null; systemResult?: { entries: RemovalResultEntry[]; persistenceError?: string | null }; metadataResult?: { entries: RemovalResultEntry[]; complete: boolean } };
const resultLabel = (status: string) => ({ deleted: '已删除', removed: '已移除', restored: '已恢复原值', alreadyAbsent: '已不存在', retained: '已保留', failed: '未完成', notAttempted: '未处理' }[status] || status);
const systemAddress = (entry: SystemEntry) => entry.address.path || (entry.address.key ? `HKCU\\${entry.address.key} · ${entry.address.valueName || '(默认值)'}` : entry.address.token || entry.id);
const bytes = (value: number) => value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MiB` : `${(value / 1024).toFixed(1)} KiB`;
const extentLabels: Record<string, string> = { disable: '停用，保留全部文件', runtime: '卸载运行部分，保留个人资料', complete: '完整卸载已确认归属内容', custom: '自定义范围' };
const roleLabels: Record<string, string> = { runtime: '运行文件', privateDependency: '专用依赖', configuration: '配置文件', userData: '用户数据', cache: '缓存', localModification: '本地改造', license: '许可证' };
const preventComposingSubmit = (event: React.KeyboardEvent) => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); };

export function InstallResource({ action, onInstalled, visible = true, readOnly = false }: { action: Action; onInstalled: (resource: Resource) => void; visible?: boolean; readOnly?: boolean }) {
  const [opened, setOpened] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [archivePath, setArchivePath] = useState(''), [name, setName] = useState(''), [kind, setKind] = useState<ResourceKind>('portable');
  const [destinationPath, setDestinationPath] = useState(''), [repository, setRepository] = useState(''), [version, setVersion] = useState('');
  const [inventory, setInventory] = useState<PackageInventory | null>(null), [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [fileRoles, setFileRoles] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<InstallPlan | null>(null), [notice, setNotice] = useState('');
  const [mode, setMode] = useState<'local' | 'github' | 'package'>('local'), [downloadId, setDownloadId] = useState<string | null>(null), [downloadBusy, setDownloadBusy] = useState(false);
  const [packageBusy, setPackageBusy] = useState(false), [wheel, setWheel] = useState<GithubDownload | null>(null);
  const [sourceEdited, setSourceEdited] = useState(false);
  const lock = useRef(false), origin = useRef<HTMLButtonElement>(null);
  async function request<T>(label: string, command: string, args: Record<string, unknown>, receive: (value: T) => void) {
    if (lock.current || !visible || readOnly || packageBusy) return; lock.current = true; setBusy(true); setError('');
    try { receive(await action<T>(label, command, args)); } catch (cause) { setError(String(cause)); } finally { lock.current = false; setBusy(false); }
  }
  function close() { if (lock.current || downloadBusy || packageBusy) return; setOpened(false); setPlan(null); origin.current?.focus(); }
  function invalidate() { setPlan(null); setNotice(''); }
  function resetPackage() { setArchivePath(''); setInventory(null); setSelectedFiles([]); setFileRoles({}); setDownloadId(null); setSourceEdited(false); setRepository(''); setVersion(''); invalidate(); }
  function downloaded(value: GithubDownload) { resetPackage(); setArchivePath(value.archivePath); setInventory(value); setSelectedFiles(value.files.filter(file => file.license).map(file => file.path)); setDownloadId(value.downloadId); setRepository(value.source.repository); setVersion(value.source.version); }
  function editSource() { if (downloadId) setSourceEdited(true); setDownloadId(null); invalidate(); }
  async function chooseArchive() {
    try {
      const selected = await open({ multiple: false, filters: [{ name: 'ZIP 发行包', extensions: ['zip'] }], title: '选择已下载的发行包' });
      if (typeof selected === 'string') { setArchivePath(selected); setInventory(null); setSelectedFiles([]); setFileRoles({}); setDownloadId(null); setSourceEdited(false); invalidate(); }
    } catch (cause) { setError(String(cause)); }
  }
  function inspect() {
    invalidate();
    void request<PackageInventory>('核对发行包内容', 'resource_package_inspect', { archivePath }, value => { setInventory(value); setSelectedFiles(value.files.filter(file => file.license).map(file => file.path)); setFileRoles({}); });
  }
  function preview() {
    const roles = Object.fromEntries(selectedFiles.filter(path => !inventory?.files.find(file => file.path === path)?.license).map(path => [path, fileRoles[path] || 'runtime']));
    void request<InstallPlan>('预览最小安装范围', 'preview_resource_install', { archivePath, destinationPath, name, kind, repository: repository.trim() || null, version: version.trim() || null, selectedFiles, fileRoles: roles, ...(downloadId ? { downloadId } : {}) }, value => setPlan(value));
  }
  function apply() {
    if (!plan?.canApply) return;
    void request<{ resource?: Resource; complete: boolean; receipt?: { error?: string } }>('安装已确认的发行文件', 'apply_resource_install', { previewId: plan.id }, value => {
      setPlan(null);
      if (value.resource) onInstalled(value.resource);
      if (value.complete) { setNotice('所选文件已安装并登记，运行能力仍需验证。'); setOpened(false); origin.current?.focus(); }
      else setError(value.receipt?.error || '安装未完整完成，已产生的文件保留，请核对操作记录。');
    });
  }
  return <div className="resource-install">
    <button className="button" ref={origin} disabled={busy || downloadBusy || packageBusy || readOnly || !visible} aria-expanded={opened} onClick={opened ? close : () => { setOpened(true); setPlan(null); setError(''); setNotice(''); }}><Package size={16} />安装发行包</button>
    {notice && <p role="status">{notice}</p>}
    {opened && <section className="resource-lifecycle-panel" aria-label="安装发行包">
      <div className="resource-editor-title"><h2>安装发行包</h2><button className="button" aria-label="关闭安装" disabled={busy || downloadBusy || packageBusy} onClick={close}><X size={16} /></button></div>
      <div className="resource-install-source" role="group" aria-label="发行包来源">{([['local','本地 ZIP'],['github','GitHub 发行版'],['package','官方软件包']] as const).map(([value,label]) => <button key={value} className={`button${mode === value ? ' active' : ''}`} aria-pressed={mode === value} disabled={busy || downloadBusy || packageBusy || readOnly || !visible} onClick={() => { if (mode !== value) { resetPackage(); setMode(value); } }}>{label}</button>)}</div>
      {mode === 'package' ? <>
        <details><summary>下载 Agent Reach 官方 wheel</summary><ResourceGithub action={action} packageFormat="reachWheel" disabled={busy || packageBusy || readOnly || !visible} onDownloaded={setWheel} onReset={() => setWheel(null)} onBusyChange={setDownloadBusy} /></details>
        <RuntimePackageInstall action={action} onInstalled={onInstalled} visible={visible} readOnly={readOnly} disabled={busy || downloadBusy} onBusyChange={setPackageBusy} archivePath={wheel?.archivePath} downloadId={wheel?.downloadId} />
      </> : mode === 'local' ? <p className="muted">选择已下载的 ZIP，核对运行文件与来源。许可证会保留；本流程不自动执行安装脚本。</p> : <ResourceGithub action={action} disabled={busy || readOnly || !visible} onDownloaded={downloaded} onReset={resetPackage} onBusyChange={setDownloadBusy} />}
      {error && <div className="resource-error" role="alert">{error}</div>}
      {mode !== 'package' && (mode === 'local' || inventory) && <form onSubmit={event => { event.preventDefault(); inventory ? preview() : inspect(); }} onKeyDown={preventComposingSubmit}>
        <fieldset disabled={busy || downloadBusy}>
          <label>发行包<div className="resource-folder-input"><input required value={archivePath} readOnly={mode === 'github'} onChange={event => { setArchivePath(event.target.value); setInventory(null); setSelectedFiles([]); setDownloadId(null); setSourceEdited(false); invalidate(); }} />{mode === 'local' && <><button className="button" type="button" onClick={() => void chooseArchive()}>选择 ZIP</button><button className="button" type="button" disabled={!archivePath.trim()} onClick={inspect}>读取清单</button></>}</div></label>
          {inventory && <>
            <div className="resource-file-selection" aria-label="发行包文件清单">{inventory.files.map(file => <div className="resource-package-file" key={file.path}><label><input type="checkbox" checked={file.license || selectedFiles.includes(file.path)} disabled={file.license} onChange={event => { setSelectedFiles(previous => event.target.checked ? [...previous, file.path] : previous.filter(path => path !== file.path)); invalidate(); }} /><span>{file.path}{file.license ? ' · 许可文件' : ''}</span><small>{bytes(file.bytes)}</small></label>{!file.license && selectedFiles.includes(file.path) && <select aria-label={`${file.path}用途`} value={fileRoles[file.path] || 'runtime'} onChange={event => { setFileRoles(previous => ({ ...previous, [file.path]: event.target.value })); invalidate(); }}>{Object.entries(roleLabels).filter(([value]) => value !== 'license').map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>}</div>)}</div>
            <p className="muted">包内展开总量 {bytes(inventory.unpackedBytes)}。请按工具说明选择完整运行范围，不能仅凭文件后缀裁剪。</p>
            <label>名称<input required value={name} onChange={event => { setName(event.target.value); invalidate(); }} /></label>
            <label>类型<select value={kind} onChange={event => { setKind(event.target.value as ResourceKind); invalidate(); }}>{Object.entries(resourceKinds).filter(([key]) => key !== 'skill').map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>新版本保存目录<input required value={destinationPath} placeholder="选择持久位置中的新目录，例如 D:\工具\示例\v1" onChange={event => { setDestinationPath(event.target.value); invalidate(); }} /></label>
            <label>原 GitHub 仓库<input type="url" value={repository} placeholder="https://github.com/作者/仓库" onChange={event => { setRepository(event.target.value); editSource(); }} /></label>
            <label>固定版本<input value={version} onChange={event => { setVersion(event.target.value); editSource(); }} placeholder="不确定时留空" /></label>
            {downloadId && <p className="muted">来源与固定版本已关联本次下载回执；安装前仍会复核文件摘要。</p>}
            {sourceEdited && <p role="status">来源或版本已编辑，下载来源证明已失效，后续按手动填写信息核对。</p>}
            <button className="button" type="submit" disabled={!selectedFiles.length || !name.trim() || !destinationPath.trim()}>预览安装</button>
          </>}
        </fieldset>
      </form>}
      {plan && <section className="resource-effect-preview" aria-label="安装影响清单"><h3>确认本次安装</h3><dl><dt>保存位置</dt><dd>{plan.targetPath}</dd><dt>所选占用</dt><dd>{bytes(plan.selectedBytes)}</dd><dt>来源</dt><dd>{plan.source.repository || '未填写'} · {plan.source.version || '版本未核实'}</dd></dl><p className="muted">{plan.source.verification === 'githubDigest' ? '来源、下载回执及上游 SHA-256 已核对；运行能力及依赖仍需分别验证。' : plan.source.verification === 'githubAsset' ? '来源与下载回执已核对，上游未提供摘要；运行能力及依赖仍需分别验证。' : '来源由本次填写；文件校验不代表已确认其作者或运行能力。'}</p><ul>{plan.files.map(file => <li key={file.path}>{file.path} · {bytes(file.bytes)} · {roleLabels[file.role || 'runtime']}</li>)}</ul>{plan.warnings.map((warning, index) => <p key={index}>{warning}</p>)}<button className="button primary" disabled={busy || downloadBusy || !plan.canApply} onClick={apply}>确认安装这些文件</button></section>}
    </section>}
  </div>;
}

export function RemoveResource({ resource, action, onChanged, visible = true, readOnly = false }: { resource: Resource; action: Action; onChanged: (resource: Resource) => void; visible?: boolean; readOnly?: boolean }) {
  const [opened, setOpened] = useState(false), [extent, setExtent] = useState('');
  const [plan, setPlan] = useState<{ value: RemovalPlan; context: string } | null>(null), [candidates, setCandidates] = useState<RemovalEntry[]>([]);
  const [customFiles, setCustomFiles] = useState<string[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [systemCandidates, setSystemCandidates] = useState<SystemEntry[]>([]), [customSystemIds, setCustomSystemIds] = useState<string[]>([]);
  const [metadataCandidates, setMetadataCandidates] = useState<MetadataEntry[]>([]), [scopeContext, setScopeContext] = useState<string | null>(null);
  const [result, setResult] = useState<{ value: RemovalResult; resourceId: string; extent: string; protectedEntries: ProtectedEntry[] } | null>(null);
  const lock = useRef(false), mounted = useRef(true), epoch = useRef(0), origin = useRef<HTMLButtonElement>(null);
  const context = JSON.stringify([resource.id, resource.revision, resource.rootPath]);
  const gate = useRef({ opened, visible, readOnly, context }); gate.current = { opened, visible, readOnly, context };
  const activePlan = plan?.context === context && plan.value.resourceId === resource.id ? plan.value : null;
  const shownResult = result?.resourceId === resource.id ? result : null;
  const scopeLoaded = scopeContext === context, disabled = busy || !visible || readOnly;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; }; }, []);
  useLayoutEffect(() => { epoch.current++; setPlan(null); setScopeContext(null); setCandidates([]); setSystemCandidates([]); setMetadataCandidates([]); setCustomFiles([]); setCustomSystemIds([]); }, [context, visible, readOnly]);
  function invalidate() { epoch.current++; setPlan(null); setResult(null); setError(''); }
  function resetScope() { setScopeContext(null); setCandidates([]); setSystemCandidates([]); setMetadataCandidates([]); setCustomFiles([]); setCustomSystemIds([]); }
  function begin() { if (disabled || lock.current) return; invalidate(); setOpened(true); setExtent(''); resetScope(); }
  function close() { if (lock.current) return; invalidate(); setOpened(false); origin.current?.focus(); }
  function active(generation: number, original: string) { const current = gate.current; return mounted.current && current.visible && !current.readOnly && current.opened && generation === epoch.current && original === current.context; }
  async function run<T>(label: string, command: string, args: Record<string, unknown>, receive: (value: T) => void) {
    const current = gate.current;
    if (lock.current || !current.visible || current.readOnly || !current.opened) return;
    const generation = epoch.current, original = current.context;
    lock.current = true; setBusy(true); setError('');
    try { const value = await action<T>(label, command, args); if (active(generation, original)) receive(value); }
    catch (cause) { if (active(generation, original)) { setError(String(cause)); setPlan(null); } }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  function preview() {
    if (!extent) return;
    invalidate();
    void run<RemovalPlan>('核对本次卸载范围', 'preview_resource_remove', { id: resource.id, expectedRevision: resource.revision, extent, customFiles: extent === 'custom' ? customFiles : [], customSystemIds: extent === 'custom' ? customSystemIds : [] }, value => {
      setCandidates(value.entries); setSystemCandidates(value.systemEntries || []); setMetadataCandidates(value.metadataEntries || []); setScopeContext(context); setPlan({ value, context });
    });
  }
  function apply() {
    if (!activePlan?.canApply) return;
    const chosen = activePlan;
    void run<RemovalResult>('处理已确认的卸载范围', 'apply_resource_remove', { previewId: chosen.id }, value => {
      setPlan(null); resetScope(); setExtent('');
      setResult({ value, resourceId: resource.id, extent: chosen.extent, protectedEntries: chosen.protectedEntries || [] });
      const issues = [...(value.result?.failures || []).map(([path, reason]) => `${path}：${reason}`), ...(value.systemResult?.entries || []).filter(entry => entry.status === 'failed').map(entry => `${entry.path || entry.id}：${entry.reason}`), ...(value.metadataResult?.entries || []).filter(entry => entry.status === 'failed' || entry.status === 'notAttempted').map(entry => `${entry.path || entry.id}：${entry.reason}`), value.systemResult?.persistenceError, value.persistenceError];
      setError([...new Set(issues.filter(Boolean))].join('\n'));
      onChanged(value.resource);
    });
  }
  function selectFile(key: string, selected: boolean) { setCustomFiles(previous => selected ? [...previous, key] : previous.filter(path => path !== key)); invalidate(); }
  if (!visible || readOnly) return null;
  return <div className="resource-remove">
    <button className="button" ref={origin} disabled={disabled} aria-expanded={opened} onClick={opened ? close : begin}><Trash2 size={15} />卸载或停用</button>
    {!shownResult && <RemovalHistory record={resource.installation?.removalState} />}
    {opened && <section className="resource-lifecycle-panel" aria-label={`卸载${resource.name}`}><div className="resource-editor-title"><h3>卸载或停用 {resource.name}</h3><button className="button" disabled={busy} aria-label="关闭卸载" onClick={close}><X size={16} /></button></div>
      <p>每次先选择处理程度，再核对完整清单。</p>
      {error && <div className="resource-error" role="alert">{error}</div>}
      {shownResult && <p role="status">{shownResult.value.complete ? (shownResult.extent === 'disable' ? '已停用，文件保留。' : '本次所选范围已处理，来源关联保留。') : '本次未完整完成。请核对保留项和失败原因。'}</p>}
      <label>本次卸载程度<select aria-label="本次卸载程度" disabled={disabled} value={extent} onChange={event => { setExtent(event.target.value); invalidate(); resetScope(); }}><option value="">请选择</option>{Object.entries(extentLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {extent === 'custom' && scopeLoaded && candidates.length > 0 && <div className="resource-file-selection" aria-label="自定义卸载文件">{candidates.map(entry => <label key={entry.selectionId || entry.relative}><input type="checkbox" disabled={disabled || !entry.expected} checked={customFiles.includes(entry.selectionId || entry.relative)} onChange={event => selectFile(entry.selectionId || entry.relative, event.target.checked)} /><span>{entry.path}</span></label>)}</div>}
      {extent === 'custom' && scopeLoaded && metadataCandidates.length > 0 && <div className="resource-file-selection" aria-label="自定义卸载管理记录"><h4>资源侧管理记录</h4>{metadataCandidates.map(entry => <label key={entry.id}><input type="checkbox" disabled={disabled || !['owned', 'absent'].includes(entry.status)} checked={customFiles.includes(entry.id)} onChange={event => selectFile(entry.id, event.target.checked)} /><span className="resource-metadata-choice">{entry.path}<small>{entry.runtimeLabel} · {entry.reason}</small></span></label>)}</div>}
      {extent === 'custom' && scopeLoaded && systemCandidates.length > 0 && <div className="resource-file-selection" aria-label="自定义卸载系统入口">{systemCandidates.map(entry => <label key={entry.id}><input type="checkbox" disabled={disabled} checked={customSystemIds.includes(entry.id)} onChange={event => { setCustomSystemIds(previous => event.target.checked ? [...previous, entry.id] : previous.filter(id => id !== entry.id)); invalidate(); }} /><span>{systemAddress(entry)}</span></label>)}</div>}
      <button className="button" disabled={disabled || !extent} onClick={preview}>{extent === 'custom' && !scopeLoaded ? '读取可选择范围' : '预览本次影响'}</button>
      {activePlan && <section className="resource-effect-preview" aria-label="卸载影响清单"><h4>{extentLabels[activePlan.extent]}</h4><p className="resource-path">{activePlan.targetPath}</p>{activePlan.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
        <ul>{activePlan.entries.map(entry => <li key={entry.selectionId || entry.relative}><strong>{entry.remove ? '拟删除' : '保留'}</strong><span>{entry.path}</span><small>{entry.reason}</small></li>)}</ul>
        {!!activePlan.metadataEntries?.length && <div aria-label="管理记录影响"><h4>资源侧管理记录</h4><p className="muted">供重新接管工具使用；与运行文件、许可证和个人配置分别处理。</p><ul>{activePlan.metadataEntries.map(entry => <li key={entry.id}><strong>{entry.remove ? '拟删除' : entry.status === 'absent' ? '已不存在' : '保留'}</strong><span>{entry.path}</span><small>{entry.runtimeLabel} · {entry.reason}</small></li>)}</ul></div>}
        {!!activePlan.protectedEntries?.length && <div aria-label="必须保留的文件"><h4>保留项</h4><ul>{activePlan.protectedEntries.map((entry, index) => <li key={`${entry.path}-${index}`}><strong>保留</strong><span>{entry.path}</span><small>{entry.reason}</small></li>)}</ul></div>}
        <ul aria-label="系统入口影响">{activePlan.systemEntries?.map(entry => <li key={entry.id}><strong>{{ remove: '拟移除', restore: '拟恢复原值', keep: '保留', alreadyAbsent: '已不存在' }[entry.operation] || entry.operation}</strong><span>{systemAddress(entry)}</span><small>{entry.reason}</small></li>)}</ul>
        <p className="muted">来源关联保留。清单变化后，本次预览失效，必须重新核对。</p><button className="button primary" disabled={disabled || !activePlan.canApply} onClick={apply}>{busy ? '正在处理…' : '确认按此清单处理'}</button>
      </section>}
      {!activePlan && shownResult && <section aria-label="本次卸载结果">
        {!!shownResult.value.result?.deleted?.length && <ul className="resource-removal-result" aria-label="文件删除结果">{shownResult.value.result.deleted.map(path => <li key={path}>{path} · 已删除并核验</li>)}</ul>}
        {!!shownResult.value.result?.retained?.length && <ul className="resource-removal-result" aria-label="文件未删除结果">{shownResult.value.result.retained.map(path => <li key={path}>{path} · 未删除</li>)}</ul>}
        {!!shownResult.value.metadataResult?.entries.length && <ul className="resource-removal-result" aria-label="管理记录结果">{shownResult.value.metadataResult.entries.map(entry => <li key={entry.id}>{entry.path || entry.id} · {resultLabel(entry.status)} · {entry.reason}</li>)}</ul>}
        {!!shownResult.value.systemResult?.entries.length && <ul className="resource-removal-result" aria-label="系统入口结果">{shownResult.value.systemResult.entries.map(entry => <li key={entry.id}>{entry.path || entry.id} · {resultLabel(entry.status)} · {entry.reason}</li>)}</ul>}
        {!!shownResult.protectedEntries.length && <ul className="resource-removal-result" aria-label="保留归属不明的文件">{shownResult.protectedEntries.map((entry, index) => <li key={`${entry.path}-${index}`}>{entry.path} · 已保留 · {entry.reason}</li>)}</ul>}
      </section>}
    </section>}
  </div>;
}
