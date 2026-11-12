import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { FolderOpen, RefreshCw } from 'lucide-react';
import { destinationDraft, destinationReady, type DestinationDraft } from './destination';
import type { Resource } from './resources';
import { downloadRate, downloadRateLabel } from './download-rate';
import { packageBytes, packageCommitResult, packageNames, packagePreview, packageResult, packageSessionLabel, packageSessions, samePackagePath, type PackageCommitResult, type PackagePhase, type PackagePreview, type PackageRecipe, type PackageResult, type PackageSession } from './runtime-package';

type Action = <T>(label: string, action: string, args: Record<string, unknown>) => Promise<T>;
type DirectoryKind = 'workingDirectory' | 'downloadDirectory' | 'destinationPath';
type Defaults = Partial<Record<DirectoryKind, string>>;
type Props = { action: Action; onInstalled: (resource: Resource) => void; onStaged?: (resource: Resource) => void; visible?: boolean; readOnly?: boolean; disabled?: boolean; onBusyChange?: (busy: boolean) => void; defaultPaths?: Defaults; archivePath?: string; downloadId?: string; resourceId?: string; expectedRevision?: number };
const directoryNames: Record<DirectoryKind, string> = { workingDirectory: '准备工作目录', downloadDirectory: '依赖下载目录', destinationPath: '新运行目录' };
const phaseNames: Record<PackagePhase, string> = { prepare: '解析依赖', download: '下载已核对文件', resume: '继续已核对下载', materialize: '准备运行目录', commit: '登记或保存候选' };
const previewActions: Record<PackagePhase, string> = { prepare: 'preview_resource_package_prepare', download: 'preview_resource_package_download', resume: 'preview_resource_package_resume', materialize: 'preview_resource_package_materialize', commit: 'preview_resource_package_commit' };
const applyActions: Record<PackagePhase, string> = { prepare: 'apply_resource_package_prepare', download: 'apply_resource_package_download', resume: 'apply_resource_package_resume', materialize: 'apply_resource_package_materialize', commit: 'apply_resource_package_commit' };
const confirmation: Record<PackagePhase, string> = { prepare: '确认解析依赖', download: '确认下载依赖文件', resume: '确认继续此下载', materialize: '确认准备运行目录', commit: '确认登记运行目录' };

function DirectoryChoice({ kind, value, defaultPath, busy, change, choose }: { kind: DirectoryKind; value: DestinationDraft; defaultPath: string; busy: boolean; change: (value: DestinationDraft) => void; choose: () => void }) {
  const id = useId(), ready = destinationReady(value, defaultPath);
  return <fieldset className="destination-choice" disabled={busy}><legend>{directoryNames[kind]}</legend>
    <div className="destination-options" data-default={!!defaultPath}>{defaultPath && <label className={`destination-option ${value.mode === 'default' && ready ? 'is-selected' : ''}`} title={defaultPath}><input type="radio" name={id} aria-label={`使用默认${directoryNames[kind]}：${defaultPath}`} checked={value.mode === 'default' && ready} onChange={() => change({ mode: 'default', path: defaultPath })} /><span><strong>使用默认位置</strong>{value.mode === 'default' && ready && <code>{defaultPath}</code>}</span></label>}<button className={`destination-option destination-custom ${value.mode === 'custom' ? 'is-selected' : ''}`} type="button" aria-label={`自定义${directoryNames[kind]}`} onClick={choose}><FolderOpen size={16} /><span><strong>自定义位置</strong></span></button></div>
    {value.mode === 'custom' ? <label className="destination-manual">自定义完整目录<input aria-label={`${directoryNames[kind]}完整路径`} value={value.path} spellCheck={false} onChange={event => change({ mode: 'custom', path: event.target.value })} placeholder={kind === 'destinationPath' ? '填写尚未使用的独立运行目录' : '填写已有目录'} /></label> : <button className="text-button" type="button" aria-label={`手动填写${directoryNames[kind]}`} onClick={() => change({ mode: 'custom', path: '' })}>手动填写</button>}
    {value.mode === 'default' && !ready && <p className="destination-current" role="status">默认位置已变化，请重新选择。</p>}
  </fieldset>;
}

export function RuntimePackageInstall({ action, onInstalled, onStaged, visible = true, readOnly = false, disabled = false, onBusyChange, defaultPaths = {}, archivePath = '', downloadId = '', resourceId, expectedRevision }: Props) {
  const versionHintId = useId(), rateHintId = useId();
  const [recipe, setRecipe] = useState<PackageRecipe>('agentReachWheelV1'), [version, setVersion] = useState(''), [runtimePath, setRuntimePath] = useState(''), [rate, setRate] = useState('0');
  const [directories, setDirectories] = useState<Record<DirectoryKind, DestinationDraft>>(() => ({ workingDirectory: destinationDraft(), downloadDirectory: destinationDraft(), destinationPath: destinationDraft() }));
  const [plan, setPlan] = useState<PackagePreview | null>(null), [result, setResult] = useState<PackageResult | null>(null), [sessions, setSessions] = useState<PackageSession[] | null>(null), [selected, setSelected] = useState<PackageSession | null>(null), [recordsOpen, setRecordsOpen] = useState(false), [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [commitResult, setCommitResult] = useState<PackageCommitResult | null>(null), [committedId, setCommittedId] = useState<string | null>(null);
  const mounted = useRef(true), epoch = useRef(0), lock = useRef(false), consumed = useRef(false);
  const context = JSON.stringify([visible, readOnly, disabled, archivePath, downloadId, resourceId, expectedRevision, defaultPaths.workingDirectory, defaultPaths.downloadDirectory, defaultPaths.destinationPath]);
  const current = useRef({ context, visible, readOnly, disabled }); current.current = { context, visible, readOnly, disabled };
  const callbacks = useRef({ onBusyChange, onInstalled, onStaged }); callbacks.current = { onBusyChange, onInstalled, onStaged };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; callbacks.current.onBusyChange?.(false); }; }, []);
  useLayoutEffect(() => { epoch.current++; consumed.current = false; setPlan(null); setError(''); setNotice(''); setCommitResult(null); }, [context]);
  const writable = visible && !readOnly && !disabled, blocked = busy || !writable;
  const rateResult = downloadRate(rate), validRate = rateResult.error === null;
  const sourceReady = recipe !== 'agentReachWheelV1' || !!archivePath && !!downloadId;
  const versionReady = /^\d+\.\d+\.\d+(?:[.\-+][a-z\d]+)*$/i.test(version.trim());
  const versionExample = recipe === 'agentReachWheelV1' ? '1.6.0' : '0.0.83', versionInvalid = version.trim() !== '' && !versionReady;
  const formReady = sourceReady && versionReady && !!runtimePath.trim() && validRate && (Object.keys(directoryNames) as DirectoryKind[]).every(kind => destinationReady(directories[kind], defaultPaths[kind] || ''));
  const scopeMatches = !!selected && selected.resourceId === (resourceId || null);
  function active(generation: number, key: string) { return mounted.current && generation === epoch.current && current.current.context === key && current.current.visible; }
  function invalidate() { epoch.current++; consumed.current = false; setPlan(null); setResult(null); setCommitResult(null); setError(''); setNotice(''); }
  async function perform<T>(label: string, command: string, args: Record<string, unknown>, receive: (value: T) => void, writes = false) {
    if (lock.current || !current.current.visible || current.current.disabled || writes && current.current.readOnly) return;
    const generation = epoch.current, key = context;
    lock.current = true; setBusy(true); callbacks.current.onBusyChange?.(true); setError('');
    try { const value = await action<T>(label, command, args); if (active(generation, key)) receive(value); }
    catch (cause) { if (active(generation, key)) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { lock.current = false; if (mounted.current) setBusy(false); callbacks.current.onBusyChange?.(false); }
  }
  async function choose(kind: DirectoryKind | 'runtime') {
    if (blocked || lock.current) return;
    const generation = epoch.current, key = context; lock.current = true; setBusy(true); callbacks.current.onBusyChange?.(true);
    try {
      const path = await open(kind === 'runtime' ? { title: recipe === 'agentReachWheelV1' ? '选择已安装的 Python 程序' : '选择已安装的 Node 程序', directory: false, multiple: false, filters: [{ name: '程序', extensions: ['exe'] }] } : { title: kind === 'destinationPath' ? '选择新运行目录的父文件夹' : `选择${directoryNames[kind]}`, directory: true, multiple: false });
      if (typeof path !== 'string' || !active(generation, key) || current.current.readOnly) return;
      invalidate();
      if (kind === 'runtime') setRuntimePath(path);
      else { const suffix = `${recipe === 'agentReachWheelV1' ? 'agent-reach' : 'playwright-mcp'}-${versionReady ? version.trim() : 'new'}`; const target = kind === 'destinationPath' ? path.replace(/[\\/]$/, '') + (path.includes('\\') ? '\\' : '/') + suffix : path; setDirectories(previous => ({ ...previous, [kind]: { mode: 'custom', path: target } })); }
    } catch (cause) { if (active(generation, key)) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { lock.current = false; if (mounted.current) setBusy(false); callbacks.current.onBusyChange?.(false); }
  }
  function prepare() {
    if (blocked || lock.current || !formReady) return;
    invalidate();
    const args = { recipe, version: version.trim(), runtimePath: runtimePath.trim(), workDirectory: directories.workingDirectory.path.trim(), downloadDirectory: directories.downloadDirectory.path.trim(), destinationPath: directories.destinationPath.path.trim(), bytesPerSecond: rateResult.bytesPerSecond, ...(recipe === 'agentReachWheelV1' ? { archivePath, downloadId } : {}), ...(resourceId ? { resourceId, expectedRevision } : {}) };
    void perform<unknown>('预览官方软件包准备范围', previewActions.prepare, args, value => {
      const received = packagePreview(value, 'prepare');
      if (received.recipe !== recipe || received.version !== version.trim() || received.resourceId !== (resourceId || null) || !samePackagePath(received.targetPath!, args.destinationPath) || !samePackagePath(received.workingDirectory!, args.workDirectory) || !samePackagePath(received.downloadDirectory!, args.downloadDirectory) || received.bytesPerSecond !== args.bytesPerSecond) throw new Error('准备预览与本次所选来源或位置不一致，请重新核对。');
      setPlan(received);
    }, true);
  }
  function records() {
    if (lock.current || !visible || disabled) return;
    invalidate(); setRecordsOpen(true);
    void perform<unknown>('读取已有软件包准备记录', 'resource_package_sessions', {}, value => { const list = packageSessions(value); setSessions(list); setPage(0); if (selected) setSelected(list.find(item => item.id === selected.id) || null); });
  }
  function previewStep(phase: Exclude<PackagePhase, 'prepare'>) {
    if (blocked || lock.current || !selected || !scopeMatches) return;
    const session = selected; invalidate();
    void perform<unknown>(`预览${phaseNames[phase]}`, previewActions[phase], { sessionId: session.id }, value => setPlan(packagePreview(value, phase, session)), true);
  }
  function apply() {
    if (blocked || lock.current || consumed.current || !plan?.canApply) return;
    const original = plan; consumed.current = true; setPlan(null);
    if (original.phase === 'commit') {
      const session = selected; if (!session) return;
      void perform<unknown>('登记或保存已准备的运行目录', applyActions.commit, { previewId: original.id }, value => {
        const received = packageCommitResult(value, original, session); setCommitResult(received);
        setNotice(received.complete ? received.staged ? '候选已准备，等待验证和切换。当前运行版本保持不变。' : '运行目录已登记，运行能力仍需验证。' : '登记尚未完整完成；运行目录与处理记录保留，请核对下方结果。');
        if (received.complete) setCommittedId(session.id);
        if (received.complete && received.registered && received.resource) callbacks.current.onInstalled(received.resource);
        if (received.complete && received.staged && received.resource && resourceId === received.resource.id) callbacks.current.onStaged?.(received.resource);
      }, true);
      return;
    }
    const phase = original.phase;
    void perform<unknown>(phaseNames[phase], applyActions[phase], { previewId: original.id }, value => {
      const received = packageResult(value, phase), session = received.session;
      if (session.recipe !== original.recipe || original.sessionId && session.id !== original.sessionId || original.version && session.version !== original.version || original.targetPath && !samePackagePath(session.destinationPath, original.targetPath)) throw new Error('返回记录与本次确认的准备范围不一致，请读取已有记录核对实际结果。');
      setSelected(session); setResult(received); setSessions(previous => previous ? [session, ...previous.filter(item => item.id !== session.id)] : previous);
      setNotice(received.complete ? original.phase === 'prepare' ? '依赖已解析，下载前请核对精确文件。' : original.phase === 'download' || original.phase === 'resume' ? '所选文件已下载并校验，尚未准备运行目录。' : '运行目录已准备，请单独预览登记或保存候选；尚未验证运行能力。' : '本次未完整完成，已完成部分和保留位置见下方。');
    }, true);
  }
  const displayedReceipt = commitResult?.receipt || result?.receipt;
  const steps: { phase: Exclude<PackagePhase, 'prepare'>; label: string; enabled: boolean }[] = selected ? [
    { phase: 'download', label: '预览依赖下载', enabled: !selected.downloadComplete && !selected.materialized && selected.status === 'resolved' },
    { phase: 'resume', label: '核对续传范围', enabled: !selected.downloadComplete && !selected.materialized && ['downloading', 'downloadInterrupted', 'failed'].includes(selected.status) },
    { phase: 'materialize', label: '预览运行目录', enabled: selected.downloadComplete && !selected.materialized && !['materializing', 'materializationIncomplete'].includes(selected.status) },
    ...(selected.materialized ? [{ phase: 'commit' as const, label: selected.resourceId ? '预览保存候选' : '预览登记运行目录', enabled: committedId !== selected.id }] : []),
  ] : [];
  const nextStep = steps.find(step => step.enabled) || (selected?.materialized ? steps.find(step => step.phase === 'commit') : steps[0]);
  if (!visible) return null;
  return <section className="resource-github runtime-package-install" aria-label="官方软件包准备" aria-busy={busy}>
    {error && <p className="resource-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!readOnly && <form aria-label="软件包准备参数" onSubmit={event => { event.preventDefault(); prepare(); }} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }}><fieldset disabled={blocked}><div className="resource-github-fields">
      <label>官方软件<select aria-label="官方软件" value={recipe} onChange={event => { invalidate(); setRecipe(event.target.value as PackageRecipe); setRuntimePath(''); }}><option value="agentReachWheelV1">Agent Reach</option><option value="edgeMcpNpmV1">Playwright MCP</option></select></label><label>精确版本<input aria-label="软件包精确版本" aria-invalid={versionInvalid || undefined} aria-describedby={versionInvalid ? versionHintId : undefined} value={version} placeholder={`例如 ${versionExample}，不使用 latest`} onChange={event => { invalidate(); setVersion(event.target.value); }} />{versionInvalid && <small id={versionHintId} className="runtime-package-field-error">请填写精确版本，例如 {versionExample}；不能使用 latest。</small>}</label>
      <label className="resource-full">现有{recipe === 'agentReachWheelV1' ? ' Python' : ' Node'} 程序<div className="resource-folder-input"><input aria-label="软件包运行程序" value={runtimePath} spellCheck={false} onChange={event => { invalidate(); setRuntimePath(event.target.value); }} placeholder="选择已安装的程序，不另行安装运行环境" /><button className="button" type="button" onClick={() => void choose('runtime')}>选择程序</button></div></label>
    </div>{recipe === 'agentReachWheelV1' ? sourceReady ? <p className="resource-path">已下载的官方发行包：{archivePath}</p> : <p role="status">请先从 GitHub 下载 Agent Reach 的官方 wheel，再准备运行目录。本地文件名不能代替来源核对。</p> : <p className="muted">从官方 npm 读取精确版本及必要依赖，不安装浏览器，不改变现有 Edge 登录资料。</p>}
      {(Object.keys(directoryNames) as DirectoryKind[]).some(kind => !defaultPaths[kind]) && <p className="muted" role="status">未配置的目录没有默认位置，请分别选择文件夹或手动填写。本次不会自动使用管理器目录。</p>}
      {(Object.keys(directoryNames) as DirectoryKind[]).map(kind => <DirectoryChoice key={kind} kind={kind} value={directories[kind]} defaultPath={defaultPaths[kind] || ''} busy={blocked} change={value => { invalidate(); setDirectories(previous => ({ ...previous, [kind]: value })); }} choose={() => void choose(kind)} />)}
      <label>下载限速（MiB/s）<input aria-label="软件包下载限速" type="number" min="0" step="any" inputMode="decimal" value={rate} aria-invalid={!validRate} aria-describedby={rateHintId} onChange={event => { invalidate(); setRate(event.target.value); }} /><small id={rateHintId} className={rateResult.error ? 'error-text' : 'muted'}>{rateResult.error || '可填写小数；0 表示不限速。'}</small></label>
      <div className="resource-detail-actions"><button className="button" type="submit" disabled={!formReady}>预览准备范围</button></div>
    </fieldset></form>}
    <div className="resource-detail-actions"><button className="button" type="button" disabled={busy || disabled} onClick={records}><RefreshCw size={15} />{recordsOpen ? '刷新准备记录' : '查看准备记录'}</button>{recordsOpen && <button className="button" type="button" disabled={busy} onClick={() => setRecordsOpen(false)}>收起记录</button>}</div>
    {recordsOpen && <section aria-label="已有软件包准备记录">{sessions === null ? <p>记录尚未读取成功。</p> : sessions.length === 0 ? <p>没有准备记录。</p> : <><ul>{sessions.slice(page * 20, page * 20 + 20).map(session => <li key={session.id}><button className="text-button" type="button" disabled={busy} onClick={() => { invalidate(); setSelected(session); }}>{packageNames[session.recipe]} · {session.version}</button><span className="muted"> · {packageSessionLabel(session)}</span></li>)}</ul><nav className="resource-download-pages" aria-label="软件包记录分页"><span>{sessions.length} 条记录</span><div className="resource-detail-actions"><button className="button" type="button" disabled={busy || page === 0} onClick={() => setPage(value => value - 1)}>上一页</button><button className="button" type="button" disabled={busy || (page + 1) * 20 >= sessions.length} onClick={() => setPage(value => value + 1)}>下一页</button></div></nav></>}</section>}
    {selected && <section className="resource-repair-result" aria-label="当前软件包准备记录"><h3>{packageNames[selected.recipe]} · {selected.version}</h3><p role="status">{packageSessionLabel(selected)}{selected.materialized ? '；准备完成不代表已经实际调用。' : '；查看记录不会继续下载或安装。'}</p><dl><dt>运行目录</dt><dd className="resource-path">{selected.destinationPath}</dd><dt>下载目录</dt><dd className="resource-path">{selected.downloadDirectory}</dd><dt>准备工作目录</dt><dd className="resource-path">{selected.workingDirectory}</dd></dl>{selected.error && <p className="resource-error" role="alert">{selected.error}</p>}
      {!readOnly && scopeMatches && nextStep && <div className="runtime-package-next-step"><button className="button primary" type="button" disabled={blocked || !nextStep.enabled} onClick={() => previewStep(nextStep.phase)}>{nextStep.label}</button><details><summary>其他准备步骤</summary><div className="resource-detail-actions">{steps.filter(step => step.phase !== nextStep.phase).map(step => <button className="button" type="button" key={step.phase} disabled={blocked || !step.enabled} onClick={() => previewStep(step.phase)}>{step.label}</button>)}</div></details></div>}{['materializing', 'materializationIncomplete'].includes(selected.status) && <p>运行目录准备尚未完整结束，现有目录原位保留，不会重复安装。重新准备时请选择全新运行目录。</p>}{!readOnly && !scopeMatches && <p>这条记录属于其他工具，请从对应工具继续核对。</p>}
    </section>}
    {plan && <section className="resource-effect-preview" aria-label="软件包本次影响清单"><h3>确认{phaseNames[plan.phase]}</h3><dl><dt>软件</dt><dd>{packageNames[plan.recipe]}{plan.version ? ` · ${plan.version}` : ''}</dd>{plan.targetPath && <><dt>新运行目录</dt><dd className="resource-path">{plan.targetPath}</dd></>}{plan.workingDirectory && <><dt>工作目录</dt><dd className="resource-path">{plan.workingDirectory}</dd></>}{plan.downloadDirectory && <><dt>下载目录</dt><dd className="resource-path">{plan.downloadDirectory}</dd></>}{plan.downloadBytes !== undefined && <><dt>已知下载量</dt><dd>{packageBytes(plan.downloadBytes)}</dd></>}{plan.maximumArtifactBytes !== undefined && <><dt>单个文件上限</dt><dd>{packageBytes(plan.maximumArtifactBytes)}</dd></>}{plan.bytesPerSecond !== undefined && <><dt>依赖文件限速</dt><dd>{downloadRateLabel(plan.bytesPerSecond)}</dd></>}</dl>
      {plan.networkPurpose && <p>{plan.networkPurpose} · {plan.hosts.join('、')}</p>}{plan.resolverMayDownload && <p role="status">解析可能下载 wheel 并保存在所选工作目录；解析阶段的下载不受上述限速约束。</p>}
      {plan.assets.length > 0 && <details open><summary>所需软件包与依赖（{plan.assets.length}）</summary><ul>{plan.assets.map((asset, index) => <li key={`${asset.filename}:${index}`}><strong>{asset.name}</strong><p>{asset.filename} · {packageBytes(asset.bytes)}</p><p className="resource-path">{asset.source}</p><details><summary>校验摘要</summary><code>{asset.digest || '未提供'}</code></details></li>)}</ul></details>}
      {plan.licenses.length > 0 && <details><summary>保留的许可证（{plan.licenses.length}）</summary><ul>{plan.licenses.map(path => <li className="resource-path" key={path}>{path}</li>)}</ul></details>}
      {plan.partialFiles.length > 0 && <details open><summary>已有下载文件（{plan.partialFiles.length}）</summary><ul>{plan.partialFiles.map((file, index) => <li key={index}><span>{file.complete ? '已完整下载' : '尚未完整'} · {packageBytes(file.bytes)}</span><p className="resource-path">{file.path}</p>{file.error && <p>{file.error}</p>}</li>)}</ul></details>}
      {plan.files && <details open><summary>本次登记的文件（{plan.files.length}）</summary><ul>{plan.files.map(file => <li className="resource-path" key={file.path}>{file.path}{file.role === 'license' ? ' · 许可证' : ''}</li>)}</ul></details>}{plan.mode && <p>{plan.mode === 'candidate' ? '只保存候选记录；当前版本保持不变，后续单独验证和切换。' : '将已准备的运行目录加入管理；本步不启动工具。'}</p>}
      {[...plan.effects, ...plan.warnings].map((message, index) => <p key={index}>{message}</p>)}<p className="muted">峰值空间尚未确定；下载、准备目录与能力实测分别记录，不自动启动工具。</p><div className="resource-detail-actions"><button className="button primary" type="button" disabled={blocked || !plan.canApply || consumed.current} onClick={apply}>{plan.mode === 'candidate' ? '确认保存候选' : confirmation[plan.phase]}</button><button className="button" type="button" disabled={busy} onClick={invalidate}>取消本次确认</button></div>
    </section>}
    {displayedReceipt && <section className="resource-repair-result" aria-label="本次软件包准备结果"><p role="status">{commitResult ? commitResult.complete ? commitResult.staged ? '候选已准备，等待验证和切换。' : '已登记，能力待验证。' : '登记未完整完成；运行目录和记录保持。' : result?.complete ? '目录已准备，管理登记尚未完成。' : '准备未完整完成；现有文件与错误保持可查看。'}</p>{(commitResult?.error || displayedReceipt.error) && <p className="resource-error" role="alert">{commitResult?.error || displayedReceipt.error}</p>}<p className="resource-path">{displayedReceipt.root}</p><details><summary>文件与许可证（{displayedReceipt.files.length}）</summary><ul>{displayedReceipt.files.map(file => <li key={file.path}><span className="resource-path">{file.path}</span>{file.role === 'license' && <small> · 许可证</small>}</li>)}</ul></details>{(displayedReceipt.createdPaths.length > 0 || displayedReceipt.temporaryPaths.length > 0) && <details><summary>已生成及保留的位置</summary><ul>{[...new Set([...displayedReceipt.createdPaths, ...displayedReceipt.temporaryPaths])].map(path => <li className="resource-path" key={path}>{path}</li>)}</ul></details>}</section>}
  </section>;
}
