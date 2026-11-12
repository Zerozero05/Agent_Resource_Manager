import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { ResourceGithub, type GithubDownload } from './ResourceGithub';
import { RuntimePackageInstall } from './RuntimePackageInstall';
import { paginateLibrary } from './library';
import type { Resource } from './resources';

type Action = <T>(label: string, action: string, args: Record<string, unknown>) => Promise<T>;
type PackageFile = { path: string; bytes: number; license: boolean };
type Inventory = { archivePath: string; files: PackageFile[]; unpackedBytes: number };
type OwnedFile = { path: string; role: string };
type Candidate = { root: string; version: string; archivePath: string; complete: boolean; error?: string | null; files: OwnedFile[]; createdPaths?: string[]; validation?: { verifiedAt: string; adapter: string } | null };
type UpdateState = { candidate?: Candidate | null; previous: { root: string; version?: string | null; reason: string }[]; retainedCandidates?: { candidate: Candidate; reason: string }[]; lastFailure?: string | null; switchCheck?: { status: string; checkedAt: string; verifiedScopes: string[]; error?: string | null } | null };
type Snapshot = { resource: Resource; updateState?: UpdateState | null };
type Change = { path: string; baselineSha256?: string | null; localSha256?: string | null; upstreamSha256?: string | null; localModified: boolean; upstreamChanged: boolean };
type Preview = { id: string; kind: 'resourceUpdateStage' | 'resourceUpdateSwitch' | 'resourceUpdateAbandon'; resourceId: string; resourceRevision: number; originalPath: string; targetPath: string; version: string; archivePath?: string; selectedBytes?: number; files?: Record<string, string>; changes?: Change[]; createdPaths?: string[]; canApply: boolean; warnings: string[] };
type Result = { resource?: Resource & { installation?: (NonNullable<Resource['installation']> & { updateState?: UpdateState | null }) | null }; complete?: boolean; verified?: boolean; staged?: boolean; switched?: boolean; abandoned?: boolean; rolledBack?: boolean; entryRestored?: boolean; rollbackVerified?: boolean; rollbackBlockedReason?: string; ownershipSaved?: boolean; error?: string; warning?: string; receipt?: { error?: string; createdPaths?: string[]; files?: OwnedFile[] } };
const keyOf = (resource: Resource) => JSON.stringify([resource.id, resource.revision, resource.rootPath, resource.repository, resource.version, resource.enabled]);
const bytes = (value: number) => value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MiB` : `${(value / 1024).toFixed(1)} KiB`;
const pathAt = (root: string, file: string) => `${root.replace(/[\\/]$/, '')}/${file}`;
const roleName: Record<string, string> = { runtime: '必要运行文件', privateDependency: '专用依赖', license: '许可证' };

function FilePagination({ label, result, disabled, onPage }: { label: string; result: { total: number; start: number; end: number; page: number; pageCount: number }; disabled: boolean; onPage: (page: number) => void }) {
  return <nav className="unified-pagination" aria-label={`${label}分页`}><span aria-live="polite">{result.total ? `${result.start}–${result.end} / ${result.total}` : '0 个文件'}</span><div><button className="button" type="button" aria-label={`上一页${label}`} disabled={disabled || result.page <= 1} onClick={() => onPage(result.page - 1)}>上一页</button><span>{result.page} / {result.pageCount}</span><button className="button" type="button" aria-label={`下一页${label}`} disabled={disabled || result.page >= result.pageCount} onClick={() => onPage(result.page + 1)}>下一页</button></div></nav>;
}

export function ResourceUpdate({ resource, action, onChanged, visible = true, readOnly = false }: { resource: Resource; action: Action; onChanged: (resource: Resource) => void; visible?: boolean; readOnly?: boolean }) {
  const [opened, setOpened] = useState(false), [phase, setPhase] = useState<string | null>(null);
  const [mode, setMode] = useState<'local' | 'github' | 'package'>('local'), [archivePath, setArchivePath] = useState(''), [destinationPath, setDestinationPath] = useState(''), [version, setVersion] = useState('');
  const [packageBusy, setPackageBusy] = useState(false), [wheel, setWheel] = useState<GithubDownload | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null), [selected, setSelected] = useState<string[]>([]), [roles, setRoles] = useState<Record<string, string>>({}), [downloadId, setDownloadId] = useState<string | null>(null);
  const [fileSearch, setFileSearch] = useState(''), [filePage, setFilePage] = useState(1);
  const [snapshot, setSnapshot] = useState<{ value: Snapshot; origin: string } | null>(null), [plan, setPlan] = useState<{ value: Preview; context: string } | null>(null);
  const [previewFilePage, setPreviewFilePage] = useState(1), [changePage, setChangePage] = useState(1);
  const [result, setResult] = useState<{ value: Result; id: string } | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [downloadBusy, setDownloadBusy] = useState(false);
  const mounted = useRef(true), lock = useRef(false), epoch = useRef(0), origin = useRef<HTMLButtonElement>(null);
  const propKey = keyOf(resource);
  const usableSnapshot = snapshot && snapshot.value.resource.id === resource.id && (snapshot.origin === propKey || keyOf(snapshot.value.resource) === propKey) ? snapshot.value : null;
  const current = usableSnapshot?.resource || resource, context = keyOf(current);
  const gate = useRef({ visible, readOnly, opened, context, resource }); gate.current = { visible, readOnly, opened, context, resource };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; }; }, []);
  useLayoutEffect(() => { epoch.current++; setPlan(null); }, [propKey, visible, readOnly]);
  useLayoutEffect(() => { setInventory(null); setArchivePath(''); setSelected([]); setRoles({}); setDownloadId(null); setVersion(''); setDestinationPath(''); setWheel(null); setError(''); setNotice(''); }, [resource.id, resource.rootPath, resource.repository]);
  useLayoutEffect(() => { setFileSearch(''); setFilePage(1); }, [inventory]);
  const selectedPaths = useMemo(() => new Set(selected), [selected]);
  const licensePaths = useMemo(() => new Set(inventory?.files.filter(file => file.license).map(file => file.path)), [inventory]);
  const selectedRuntimeFiles = useMemo(() => selected.filter(path => !licensePaths.has(path)), [selected, licensePaths]);
  const matchingFiles = useMemo(() => { const query = fileSearch.trim().toLocaleLowerCase(); return inventory?.files.filter(file => file.path.toLocaleLowerCase().includes(query)) || []; }, [inventory, fileSearch]);
  const filePageResult = paginateLibrary(matchingFiles, filePage, 50);
  const activePlan = plan?.context === context && plan.value.resourceId === current.id && plan.value.resourceRevision === current.revision ? plan.value : null;
  useLayoutEffect(() => { setPreviewFilePage(1); setChangePage(1); }, [activePlan]);
  const previewFiles = useMemo(() => Object.entries(activePlan?.files || {}), [activePlan]);
  const previewFilePageResult = paginateLibrary(previewFiles, previewFilePage, 50), changePageResult = paginateLibrary(activePlan?.changes || [], changePage, 50);
  const state = usableSnapshot?.updateState, candidate = state?.candidate, shownResult = result?.id === resource.id ? result.value : null;
  const blocked = phase !== null || downloadBusy || packageBusy || !visible || readOnly;
  function active(generation: number, original: string) { const value = gate.current; return mounted.current && value.visible && !value.readOnly && value.opened && generation === epoch.current && value.context === original; }
  function invalidate() { epoch.current++; setPlan(null); setError(''); setNotice(''); }
  function resetPackage() { invalidate(); setArchivePath(''); setInventory(null); setSelected([]); setRoles({}); setDownloadId(null); setVersion(''); }
  function close() { if (lock.current || downloadBusy || packageBusy) return; invalidate(); setOpened(false); origin.current?.focus(); }
  async function request<T>(label: string, command: string, args: Record<string, unknown>, receive: (value: T) => void) {
    const value = gate.current;
    if (lock.current || !value.opened || !value.visible || value.readOnly) return;
    const generation = epoch.current, original = value.context;
    lock.current = true; setPhase(command); setError('');
    try { const received = await action<T>(label, command, args); if (active(generation, original)) receive(received); }
    catch (cause) { if (active(generation, original)) { setPlan(null); setError(String(cause)); } }
    finally { lock.current = false; if (mounted.current) setPhase(null); }
  }
  function accept(value: Result) {
    setPlan(null); setResult({ value, id: current.id });
    if (value.resource) {
      setSnapshot({ value: { resource: value.resource, updateState: value.resource.installation?.updateState }, origin: keyOf(gate.current.resource) });
      if (value.resource.revision >= gate.current.resource.revision) onChanged(value.resource);
    } else setSnapshot(null);
    if (value.error || value.receipt?.error || value.warning || value.rollbackBlockedReason) setError([...new Set([value.error, value.receipt?.error, value.warning, value.rollbackBlockedReason].filter(Boolean))].join('\n'));
  }
  function receivePlan(value: Preview, expectedKind: Preview['kind']) {
    if (value.resourceId !== current.id || value.resourceRevision !== current.revision || value.kind !== expectedKind) { setPlan(null); setError('预览对应的资源或步骤已变化，请重新读取更新记录。'); return; }
    setPlan({ value, context });
  }
  function readState() {
    if (blocked || lock.current) return;
    setPlan(null);
    void request<Snapshot>('读取版本更新记录', 'resource_update_state', { id: current.id }, value => {
      setSnapshot({ value, origin: keyOf(gate.current.resource) });
      if (value.resource.revision > gate.current.resource.revision) onChanged(value.resource);
    });
  }
  async function choose(field: 'archive' | 'destination') {
    if (blocked || lock.current) return;
    const generation = epoch.current, original = context;
    lock.current = true; setPhase('choose');
    try {
      const chosen = await open(field === 'archive' ? { multiple: false, title: '选择候选版本 ZIP', filters: [{ name: 'ZIP 发行包', extensions: ['zip'] }] } : { directory: true, multiple: false, title: '选择保存候选版本的新目录的父目录' });
      if (active(generation, original) && typeof chosen === 'string') {
        invalidate();
        if (field === 'archive') { setArchivePath(chosen); setInventory(null); setSelected([]); setRoles({}); setDownloadId(null); }
        else setDestinationPath(chosen.replace(/[\\/]$/, '') + '/新版本目录');
      }
    } catch (cause) { if (active(generation, original)) setError(String(cause)); }
    finally { lock.current = false; if (mounted.current) setPhase(null); }
  }
  function inspect() {
    if (blocked || lock.current || !archivePath.trim()) return; invalidate();
    void request<Inventory>('读取候选发行包清单', 'resource_package_inspect', { archivePath: archivePath.trim() }, value => { setInventory(value); setArchivePath(value.archivePath); setSelected(value.files.filter(file => file.license).map(file => file.path)); setRoles({}); });
  }
  function downloaded(value: GithubDownload) {
    if (!gate.current.opened || !gate.current.visible || gate.current.readOnly) return;
    invalidate(); setInventory(value); setArchivePath(value.archivePath); setSelected(value.files.filter(file => file.license).map(file => file.path)); setRoles({}); setDownloadId(value.downloadId); setVersion(value.source.version);
  }
  function previewStage() {
    if (blocked || lock.current || !inventory || !version.trim() || !destinationPath.trim() || !selectedRuntimeFiles.length) return;
    invalidate();
    void request<Preview>('预览候选版本文件与差异', 'preview_resource_update', { id: current.id, expectedRevision: current.revision, archivePath, destinationPath: destinationPath.trim(), version: version.trim(), selectedFiles: selected, fileRoles: Object.fromEntries(selectedRuntimeFiles.map(path => [path, roles[path] || 'runtime'])), ...(downloadId ? { downloadId } : {}) }, value => receivePlan(value, 'resourceUpdateStage'));
  }
  function previewCandidate(kind: 'switch' | 'abandon') {
    if (blocked || lock.current) return;
    invalidate();
    void request<Preview>(kind === 'switch' ? '预览运行版本切换' : '预览结束候选流程', `preview_resource_update_${kind}`, { id: current.id, expectedRevision: current.revision }, value => receivePlan(value, kind === 'switch' ? 'resourceUpdateSwitch' : 'resourceUpdateAbandon'));
  }
  function verify() {
    if (blocked || lock.current) return;
    invalidate();
    void request<Result>('隔离验证候选运行入口', 'verify_resource_update', { id: current.id, expectedRevision: current.revision }, value => { accept(value); setNotice(value.verified ? '候选已通过本次隔离验证。切换仍需另行预览和确认。' : '验证未完成，请查看原因。'); });
  }
  function apply() {
    if (!activePlan?.canApply || activePlan.resourceId !== current.id || activePlan.resourceRevision !== current.revision) return;
    const command = activePlan.kind === 'resourceUpdateStage' ? 'stage' : activePlan.kind === 'resourceUpdateSwitch' ? 'switch' : 'abandon';
    void request<Result>('执行已确认的版本更新步骤', `apply_resource_update_${command}`, { previewId: activePlan.id }, value => { accept(value); if (value.abandoned && value.complete) { resetPackage(); setDestinationPath(''); setNotice('候选流程已结束，文件和记录原位保留；重新准备时请选择新的目录。'); } });
  }
  if (!visible || readOnly) return null;
  return <div className="resource-repair">
    <button className="button" type="button" ref={origin} disabled={blocked} aria-expanded={opened} onClick={opened ? close : () => { invalidate(); setOpened(true); }}>更新运行版本</button>
    {opened && <section className="resource-lifecycle-panel" aria-label={`更新 ${resource.name}`} aria-busy={phase !== null || downloadBusy}>
      <div className="resource-editor-title"><h3>更新运行版本</h3><button className="button" type="button" disabled={blocked} onClick={close}>收起更新</button></div>
      <p className="muted">先把所选运行文件准备到新目录，再隔离验证、确认切换。现有配置、登录、用户数据和本地改造留在原处。</p>
      {error && <p className="resource-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      <div className="resource-detail-actions"><button className="button" disabled={blocked} type="button" onClick={readState}>读取更新记录</button><span className="resource-path">当前目录：{current.rootPath} · {current.version || '版本未知'}</span></div>
      {state?.lastFailure && <p role="alert">最近失败：{state.lastFailure}</p>}
      {state?.switchCheck && <section aria-label="最近入口切换核对"><strong>{({ pending: '正在核对切换后的实际入口', passed: '切换后入口验证通过', rolledBack: '原入口已恢复，运行自检通过', rollbackUnverified: '原入口已恢复，运行未核实', rollbackBlocked: '状态已有变化，未自动恢复入口' } as Record<string, string>)[state.switchCheck.status] || '切换记录待核对'}</strong><p>{new Date(state.switchCheck.checkedAt).toLocaleString()}</p>{state.switchCheck.verifiedScopes?.length > 0 && <p>本次验证：{state.switchCheck.verifiedScopes.map(scope => ({ cliVersion: '命令行版本', localDoctor: '本机自检', isolatedLocalDoctor: '隔离环境本地自检', cliHelp: '命令帮助' } as Record<string, string>)[scope] || scope).join('、')}</p>}{state.switchCheck.error && <p role="alert">{state.switchCheck.error}</p>}</section>}
      {candidate ? <section aria-label="待处理候选版本" className="resource-effect-preview"><h4>候选 {candidate.version}</h4><p className="resource-path">{candidate.root}</p>{candidate.archivePath && <p className="resource-path">发行包：{candidate.archivePath}</p>}<p>{candidate.complete ? '文件已准备，尚未切换' : '文件准备未完成，当前版本保持'}</p>{candidate.error && <p role="alert">{candidate.error}</p>}{candidate.validation && <p>隔离验证：{candidate.validation.adapter} · {candidate.validation.verifiedAt}</p>}<div className="resource-detail-actions"><button className="button" type="button" disabled={blocked || !candidate.complete} onClick={verify}>验证候选入口</button><button className="button" type="button" disabled={blocked || !candidate.complete} onClick={() => previewCandidate('switch')}>预览切换</button><button className="button" type="button" disabled={blocked} onClick={() => previewCandidate('abandon')}>结束候选流程</button></div></section> : <>
        <div className="resource-detail-actions" role="group" aria-label="更新发行包来源">{([['local','本地 ZIP'],['github','GitHub 发行版'],['package','官方软件包']] as const).map(([value,label]) => <button className="button" key={value} type="button" aria-pressed={mode === value} disabled={blocked} onClick={() => { if (mode !== value) { resetPackage(); setMode(value); } }}>{label}</button>)}</div>
        {mode === 'github' && <ResourceGithub key={propKey} action={action} disabled={blocked} onDownloaded={downloaded} onReset={resetPackage} onBusyChange={setDownloadBusy} />}
        {mode === 'package' && <>
          <details><summary>下载 Agent Reach 官方 wheel</summary><ResourceGithub key={propKey} action={action} packageFormat="reachWheel" disabled={blocked} onDownloaded={setWheel} onReset={() => setWheel(null)} onBusyChange={setDownloadBusy} /></details>
          <RuntimePackageInstall key={current.id} action={action} resourceId={current.id} expectedRevision={current.revision} visible={visible} readOnly={readOnly} disabled={phase !== null || downloadBusy} onBusyChange={setPackageBusy} onInstalled={onChanged} onStaged={next => { accept({ resource: next, complete: true, staged: true }); setNotice('候选文件已准备，仍须验证并确认切换。'); }} archivePath={wheel?.archivePath} downloadId={wheel?.downloadId} />
        </>}
        {mode !== 'package' && <form onSubmit={event => { event.preventDefault(); previewStage(); }} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }}><fieldset disabled={blocked}>
          {mode === 'local' && <label>候选版本 ZIP<div className="resource-folder-input"><input value={archivePath} onChange={event => { invalidate(); setArchivePath(event.target.value); setInventory(null); setSelected([]); setRoles({}); setDownloadId(null); }} /><button className="button" type="button" onClick={() => void choose('archive')}>选择 ZIP</button><button className="button" type="button" disabled={!archivePath.trim()} onClick={inspect}>读取文件清单</button></div></label>}
          {inventory && <><label>固定版本<input value={version} disabled={!!downloadId} placeholder="例如 v2.0.0" onChange={event => { invalidate(); setVersion(event.target.value); }} /></label><label>候选保存目录（必须为未使用的新目录）<div className="resource-folder-input"><input value={destinationPath} placeholder="D:\\工具\\新版本目录" onChange={event => { invalidate(); setDestinationPath(event.target.value); }} /><button className="button" type="button" onClick={() => void choose('destination')}>选择父目录</button></div></label>
            <div className="resource-detail-actions"><button className="button" type="button" onClick={() => { invalidate(); setSelected(inventory.files.map(file => file.path)); }}>全选文件</button><button className="button" type="button" onClick={() => { invalidate(); setSelected(inventory.files.filter(file => file.license).map(file => file.path)); }}>仅保留许可证</button></div>
            <label>筛选候选文件<input type="search" value={fileSearch} placeholder="按文件路径搜索" onChange={event => { setFileSearch(event.target.value); setFilePage(1); }} /></label>
            <p className="muted">已选择 {selected.length} / {inventory.files.length} 个文件；全选和仅保留许可证作用于全部文件。</p>
            <div className="resource-file-selection" aria-label="候选运行文件">{filePageResult.items.map(file => <div key={file.path}><label><input type="checkbox" checked={selectedPaths.has(file.path)} disabled={file.license} onChange={event => { invalidate(); setSelected(previous => event.target.checked ? [...previous, file.path] : previous.filter(path => path !== file.path)); }} /><span>{file.path}</span><small>{bytes(file.bytes)}</small></label>{selectedPaths.has(file.path) && (file.license ? <small>许可证，自动保留</small> : <label>文件用途：{file.path}<select value={roles[file.path] || 'runtime'} onChange={event => { invalidate(); setRoles(previous => ({ ...previous, [file.path]: event.target.value })); }}><option value="runtime">必要运行文件</option><option value="privateDependency">专用依赖</option></select></label>)}</div>)}{!filePageResult.total && <p>没有匹配的候选文件。</p>}</div>
            <FilePagination label="候选文件" result={filePageResult} disabled={blocked} onPage={setFilePage} />
            <button className="button" type="submit" disabled={!version.trim() || !destinationPath.trim() || !selectedRuntimeFiles.length}>预览候选版本</button></>}
        </fieldset></form>}
      </>}
      {activePlan && <section className="resource-effect-preview" aria-label="版本更新影响清单"><h4>{activePlan.kind === 'resourceUpdateStage' ? '确认准备候选' : activePlan.kind === 'resourceUpdateSwitch' ? '确认切换运行入口' : '确认结束候选流程'}</h4><dl><dt>当前目录</dt><dd className="resource-path">{activePlan.originalPath}</dd><dt>候选目录</dt><dd className="resource-path">{activePlan.targetPath}</dd><dt>固定版本</dt><dd>{activePlan.version}</dd>{activePlan.archivePath && <><dt>发行包</dt><dd className="resource-path">{activePlan.archivePath}</dd><dt>所选占用</dt><dd>{bytes(activePlan.selectedBytes || 0)}</dd></>}</dl>
        {activePlan.files && <><ul aria-label="候选完整文件路径">{previewFilePageResult.items.map(([path, role]) => <li key={path}><span className="resource-path">{pathAt(activePlan.targetPath, path)}</span><small>{roleName[role] || role}</small></li>)}</ul><FilePagination label="预览文件" result={previewFilePageResult} disabled={blocked} onPage={setPreviewFilePage} /></>}
        {!!activePlan.changes?.length && <details><summary>当前文件与上游差异（{activePlan.changes.length}）</summary><ul aria-label="当前文件与上游差异">{changePageResult.items.map(change => <li key={change.path}><strong>{change.path}</strong><span>{!change.localSha256 ? '当前本地无文件' : !change.baselineSha256 ? '原安装未包含此文件' : change.localModified ? '本地有修改' : '本地与安装基准一致'} · {!change.upstreamSha256 ? '候选未选择或无文件' : change.upstreamChanged ? '上游内容有变化' : '上游与安装基准一致'}</span><small>安装基准：{change.baselineSha256 || '无记录'}<br />当前本地：{change.localSha256 || '无文件'}<br />候选上游：{change.upstreamSha256 || '未选择或无文件'}</small></li>)}</ul><FilePagination label="文件差异" result={changePageResult} disabled={blocked} onPage={setChangePage} /></details>}
        {!!activePlan.createdPaths?.length && <ul aria-label="保留的候选路径">{activePlan.createdPaths.map(path => <li className="resource-path" key={path}>{path}</li>)}</ul>}
        {activePlan.warnings.map((warning, index) => <p key={index}>{warning}</p>)}<div className="resource-detail-actions"><button className="button primary" type="button" disabled={blocked || !activePlan.canApply} onClick={apply}>{activePlan.kind === 'resourceUpdateStage' ? '确认准备这些文件' : activePlan.kind === 'resourceUpdateSwitch' ? '确认切换运行入口' : '确认结束并保留文件'}</button><button className="button" type="button" disabled={blocked} onClick={() => { setPlan(null); }}>取消本次确认</button></div>
      </section>}
      {shownResult && <section aria-label="本次版本更新结果" className="resource-effect-preview"><p role="status">{shownResult.switched && shownResult.complete ? '运行入口已切换，原版本已保留；用户数据未复制。' : shownResult.entryRestored && !shownResult.rollbackVerified ? '原入口已恢复，运行未核实；请查看自检原因，两个版本目录保留。' : shownResult.rollbackBlockedReason ? '状态已有变化，未自动恢复入口；请核对当前目录与切换记录。' : shownResult.abandoned && shownResult.complete ? '候选流程已结束，当前运行入口保持；候选文件和记录保留。' : shownResult.verified ? '本次隔离验证已完成，尚未切换运行入口。' : shownResult.staged && shownResult.complete ? '候选文件已准备，尚未切换运行入口。' : shownResult.rolledBack ? '原入口已恢复，运行自检通过；两个版本目录保留。' : '本次未完整完成，当前状态请读取更新记录核对。'}</p>{shownResult.ownershipSaved === false && <p role="alert">归属记录保存失败，本次不能视为完成；已产生的文件保留。</p>}{!!shownResult.receipt?.createdPaths?.length && <ul>{shownResult.receipt.createdPaths.map(path => <li className="resource-path" key={path}>{path}</li>)}</ul>}</section>}
      {!!state?.previous.length && <details><summary>保留的原运行版本（{state.previous.length}）</summary><ul>{state.previous.map((item, index) => <li key={index}><span className="resource-path">{item.root} · {item.version || '版本未知'}</span><small>{item.reason}</small></li>)}</ul></details>}
      {!!state?.retainedCandidates?.length && <details><summary>已结束并保留的候选（{state.retainedCandidates.length}）</summary><ul>{state.retainedCandidates.map((item, index) => <li key={index}><span className="resource-path">{item.candidate.root} · {item.candidate.version}</span><small>{item.reason}</small>{item.candidate.error && <p>{item.candidate.error}</p>}</li>)}</ul></details>}
    </section>}
  </div>;
}
