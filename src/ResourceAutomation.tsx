import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import type { Resource } from './resources';
import { downloadRate, downloadRateInput, downloadRateLabel as rateLabel } from './download-rate';

type Action = <T>(label: string, action: string, args: Record<string, unknown>) => Promise<T>;
type PackageSource = { recipe: 'agentReachWheelV1' | 'edgeMcpNpmV1'; packageName: string; registry: string; runtimePath: string; runtimeSha256: string; runtimeBindingHash: string; permittedPackages?: string[] };
type PackageScope = PackageSource & { workDirectory: string; workDirectoryId: string; bytesPerSecond: number };
type Scope = { repository: string; repositoryId: number; candidateParentPath: string; downloadDirectory: string; channel: string; assetName: string; files: Record<string, string>; pinnedVersion?: string | null; skippedVersions?: string[]; runtimePackage?: PackageScope | null };
type Attempt = { id: string; resourceId: string; version: string; status: string; phase: string; updatedAt: string; result?: { changed?: boolean; switched?: boolean; postSwitchVerified?: boolean; rolledBack?: boolean; authorizationAdvanced?: boolean; archivePath?: string; candidatePath?: string } | null };
type Status = { resourceId: string; resourceRevision: number; policyMode: string; authorization: { revision: number; enabled: boolean; scope?: Scope | null } | null; currentScope: { repository: string; repositoryId: number; installedVersion?: string | null; assetName: string; files: Record<string, string>; pinnedVersion?: string | null; skippedVersions?: string[]; runtimePackage?: PackageSource | null } | null; effective: boolean; blockedReason: string; attempts?: Attempt[] };
type Plan = { id: string; kind: 'resourceAutomation'; resourceId: string; resourceRevision: number; enabled: boolean; scope: Scope | null; canApply: boolean; permissions: string[]; warnings: string[] };
const labels: Record<string, string> = { runtime: '运行文件', privateDependency: '专用依赖', license: '许可证' };
const keyOf = (resource: Resource) => JSON.stringify([resource.id, resource.revision, resource.rootPath, resource.repository, resource.version, resource.enabled]);
const phaseNames: Record<string, string> = { release: '读取发行信息', download: '下载发行文件', stage: '准备候选', resolve: '解析官方依赖', packageDownload: '下载或续传依赖', materialize: '准备独立运行目录', packageCommit: '登记候选版本', verify: '候选隔离验证', switch: '切换及核验入口', complete: '收尾完成' };
const attemptNames: Record<string, string> = { completed: '已完成', stopped: '已停止', running: '尚无结束回执' };
const recipeNames: Record<PackageSource['recipe'], string> = { agentReachWheelV1: 'Agent Reach · Python wheel', edgeMcpNpmV1: 'Playwright MCP · npm' };

function PackageRuntime({ source, repository }: { source: PackageSource; repository: string }) {
  return <div className="resource-automation-package"><strong>{recipeNames[source.recipe]}</strong><dl><dt>软件包</dt><dd>{source.packageName}</dd>{source.recipe === 'agentReachWheelV1' && <><dt>主包来源</dt><dd className="resource-path">{repository.replace(/\/$/, '')}/releases</dd></>}<dt>{source.recipe === 'agentReachWheelV1' ? '依赖索引' : '官方 registry'}</dt><dd className="resource-path">{source.registry}</dd><dt>共享运行环境</dt><dd className="resource-path">{source.runtimePath}<small title={source.runtimeSha256}>SHA-256：{source.runtimeSha256.slice(0, 16)}…</small></dd></dl><details><summary>运行环境绑定</summary><code className="resource-path">{source.runtimeBindingHash}</code>{source.permittedPackages ? <><p>允许的软件包 {source.permittedPackages.length}</p><ul>{source.permittedPackages.map(name => <li className="resource-path" key={name}>{name}</li>)}</ul></> : <p>允许的软件包：尚未提供。</p>}</details></div>;
}

function AttemptSummary({ attempt }: { attempt: Attempt }) {
  const result = attempt.result, time = new Date(attempt.updatedAt), completed = attempt.status === 'completed' && result?.switched && result.postSwitchVerified;
  return <section className="resource-source-content" aria-label="最近自动更新记录">
    <div className="resource-editor-title"><h4>最近自动更新</h4><span>{attemptNames[attempt.status] || '结果待核对'}</span></div>
    <p><strong>{attempt.version}</strong> · {phaseNames[attempt.phase] || '阶段待核对'}{Number.isFinite(time.getTime()) && <> · <time dateTime={attempt.updatedAt}>{time.toLocaleString()}</time></>}</p>
    {completed ? <p>本次入口已切换，切换后核验通过。</p> : result?.rolledBack ? <p>本次入口切换已撤回；原目录和候选目录保留。</p> : result?.switched ? <p role="alert">最近回执记录入口已切换，核验未完成；请查看对应任务。</p> : attempt.status === 'stopped' ? <p>后续阶段已停止，不会因刷新或重启重复应用。继续前请先核对对应任务，再重新预览许可。</p> : <p>目前只有阶段记录，不能据此确认任务仍在运行；请查看对应任务。</p>}
    {completed && result?.authorizationAdvanced === false && <p role="alert">本次更新已完成，后续自动许可尚未推进；请重新核对许可范围。</p>}
    {(result?.archivePath || result?.candidatePath) && <details><summary>文件位置</summary><dl>{result.archivePath && <><dt>发行包</dt><dd className="resource-path">{result.archivePath}</dd></>}{result.candidatePath && <><dt>候选位置</dt><dd className="resource-path">{result.candidatePath}</dd></>}</dl></details>}
  </section>;
}

function ScopeFiles({ files, packageMode = false }: { files: Record<string, string>; packageMode?: boolean }) {
  const [limit, setLimit] = useState(100);
  useEffect(() => { setLimit(100); }, [files]);
  const entries = Object.entries(files);
  return <details className="resource-automation-files"><summary>{packageMode ? '当前安装基线范围' : '精确运行范围'}（{entries.length}）</summary><ul>{entries.slice(0, limit).map(([path, role]) => <li key={path}><span className="resource-path">{path}</span><small>{labels[role] || role}</small></li>)}</ul>{entries.length > limit && <button className="button" type="button" onClick={() => setLimit(previous => previous + 100)}>再显示 100 项（剩余 {entries.length - limit}）</button>}</details>;
}

export function ResourceAutomation({ resource, action, onChanged, visible = true, readOnly = false }: { resource: Resource; action: Action; onChanged: (value: Resource) => void; visible?: boolean; readOnly?: boolean }) {
  const [opened, setOpened] = useState(false), [busy, setBusy] = useState(false), [status, setStatus] = useState<Status | null>(null);
  const [enabled, setEnabled] = useState(false), [parent, setParent] = useState(''), [downloads, setDownloads] = useState(''), [asset, setAsset] = useState('');
  const [work, setWork] = useState(''), [rate, setRate] = useState('0');
  const rateNoteId = useId();
  const [plan, setPlan] = useState<Plan | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const key = keyOf(resource), epoch = useRef(0), lock = useRef(false), mounted = useRef(true), openedRef = useRef(false), origin = useRef<HTMLButtonElement>(null);
  const acceptedKey = useRef<string | null>(null);
  const current = useRef({ key, visible, readOnly, resource }); current.current = { key, visible, readOnly, resource };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; }; }, []);
  useLayoutEffect(() => { epoch.current++; setPlan(null); setStatus(null); setError(''); if (acceptedKey.current !== key || !visible || readOnly) setNotice(''); }, [key, visible, readOnly]);
  const stale = status !== null && (status.resourceId !== resource.id || status.resourceRevision !== resource.revision);
  const recentAttempt = status?.attempts?.find(attempt => attempt.resourceId === resource.id);
  const blocked = busy || !visible || readOnly;
  const packageSource = status?.currentScope?.runtimePackage;
  const packageMode = !!packageSource, rateResult = downloadRate(rate);
  const incomplete = enabled && (!status?.currentScope || !parent.trim() || !downloads.trim() || (packageMode ? !work.trim() || rateResult.error !== null : !asset.trim()));
  function active(generation: number, original: string) { const value = current.current; return mounted.current && openedRef.current && value.visible && !value.readOnly && value.key === original && generation === epoch.current; }
  function invalidate() { epoch.current++; setPlan(null); setError(''); setNotice(''); }
  async function request<T>(label: string, command: string, args: Record<string, unknown>, receive: (value: T) => void) {
    const value = current.current;
    if (!openedRef.current || lock.current || !value.visible || value.readOnly) return;
    const generation = epoch.current, original = value.key;
    lock.current = true; setBusy(true); setError('');
    try { const received = await action<T>(label, command, args); if (active(generation, original)) receive(received); }
    catch (cause) { if (active(generation, original)) { setPlan(null); setError(cause instanceof Error ? cause.message : String(cause)); } }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  function readStatus() {
    if (lock.current || !visible || readOnly) return;
    invalidate(); setStatus(null);
    void request<Status>('读取自动更新许可及当前范围', 'resource_automation_status', { resourceId: resource.id }, value => {
      setStatus(value); setEnabled(value.authorization?.enabled === true); setParent(value.authorization?.scope?.candidateParentPath || ''); setDownloads(value.authorization?.scope?.downloadDirectory || ''); setAsset(value.authorization?.scope?.assetName || value.currentScope?.assetName || '');
      setWork(value.authorization?.scope?.runtimePackage?.workDirectory || ''); setRate(downloadRateInput(value.authorization?.scope?.runtimePackage?.bytesPerSecond ?? 0));
    });
  }
  function begin() { if (blocked || lock.current) return; openedRef.current = true; setOpened(true); readStatus(); }
  function close() { if (lock.current) return; invalidate(); openedRef.current = false; setOpened(false); origin.current?.focus(); }
  async function choose(field: 'parent' | 'downloads' | 'work') {
    if (blocked || lock.current) return;
    const generation = epoch.current, original = key;
    lock.current = true; setBusy(true);
    try { const path = await open({ directory: true, multiple: false, title: field === 'parent' ? '选择管理器目录之外的候选持久父目录' : field === 'work' ? '选择软件包准备工作目录' : '选择明确授权的下载目录' }); if (active(generation, original) && typeof path === 'string') { invalidate(); if (field === 'parent') setParent(path); else if (field === 'work') setWork(path); else setDownloads(path); } }
    catch (cause) { if (active(generation, original)) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  function preview() {
    if (blocked || lock.current || !status || stale || incomplete) return;
    invalidate();
    void request<Plan>('预览自动更新授权范围', 'preview_resource_automation', { resourceId: resource.id, expectedRevision: resource.revision, enabled, ...(enabled ? { candidateParentPath: parent.trim(), downloadDirectory: downloads.trim(), channel: 'stable', ...(packageMode ? { workDirectory: work.trim(), bytesPerSecond: rateResult.bytesPerSecond } : { assetName: asset.trim() }), selectedFiles: Object.keys(status.currentScope!.files), fileRoles: status.currentScope!.files } : {}) }, value => {
      if (value.kind !== 'resourceAutomation' || value.resourceId !== resource.id || value.resourceRevision !== resource.revision || value.enabled !== enabled) { setError('许可预览对应的工具或选择已变化，请重新读取。'); return; }
      setPlan(value);
    });
  }
  function apply() {
    if (blocked || lock.current || stale || !plan?.canApply || plan.resourceId !== resource.id || plan.resourceRevision !== resource.revision) return;
    const selected = plan;
    void request<{ resource: Resource; authorization: { enabled: boolean }; saved: boolean; automaticApplied: boolean }>('保存已确认的自动更新许可', 'apply_resource_automation', { previewId: selected.id }, value => {
      setPlan(null);
      if (!value.saved || value.automaticApplied || value.resource.id !== resource.id || value.resource.revision < current.current.resource.revision) { setError('许可保存结果需要重新核对，未宣称已启用自动执行。'); return; }
      acceptedKey.current = keyOf(value.resource); onChanged(value.resource); setStatus(null);
      setNotice(value.authorization.enabled ? '明确授权已保存。本次没有下载、安装或切换；自动执行仍须逐步重核全部条件。' : '后续自动更新许可已撤销。当前文件和入口保持，已进入关键提交的任务会安全收尾。');
    });
  }
  if (!visible || readOnly) return null;
  return <div className="resource-repair resource-automation">
    <button className="button" type="button" ref={origin} disabled={blocked} aria-expanded={opened} onClick={opened ? close : begin}>自动更新许可</button>
    {opened && <section className="resource-lifecycle-panel" aria-label={`自动更新许可 ${resource.name}`} aria-busy={busy}>
      <div className="resource-editor-title"><h3>自动更新许可</h3><div className="resource-detail-actions"><button className="button" type="button" disabled={blocked} onClick={readStatus}>刷新许可</button><button className="button" type="button" disabled={blocked} onClick={close}>收起许可</button></div></div>
      <p className="muted">版本检查不代表允许应用。请单独核对来源、位置及运行范围；保存许可不会立即执行更新。</p>
      {error && <p className="resource-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      {stale && <p role="alert">工具目录已变化，请刷新工具信息后再授权。</p>}
      {status && <>
        <p role="status">{status.effective ? '当前许可条件有效，实际执行前仍会重新核对。' : status.blockedReason || '尚未具备自动应用条件。'}</p>
        {recentAttempt && <AttemptSummary attempt={recentAttempt} />}
        <form onSubmit={event => { event.preventDefault(); preview(); }} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }}><fieldset disabled={blocked || stale}>
          <label className="resource-checkbox"><span><input type="checkbox" checked={enabled} disabled={!status.currentScope && !enabled} onChange={event => { invalidate(); setEnabled(event.target.checked); }} /> 允许在明确范围内自动下载和应用</span></label>
          {enabled && status.currentScope && <>
            <div className="resource-automation-source"><dl><dt>已核来源</dt><dd className="resource-path">{status.currentScope.repository}</dd><dt>仓库身份</dt><dd>{status.currentScope.repositoryId}</dd><dt>当前版本</dt><dd>{status.currentScope.installedVersion || '未知'}</dd><dt>当前安装</dt><dd className="resource-path">{resource.rootPath}</dd><dt>发行渠道</dt><dd>稳定版</dd></dl>{packageSource && <PackageRuntime source={packageSource} repository={status.currentScope.repository} />}</div>
            <div className="resource-automation-fields">
              <label>候选持久父目录<div className="resource-folder-input"><input aria-label="自动更新候选父目录" value={parent} placeholder="选择管理器目录之外的位置" onChange={event => { invalidate(); setParent(event.target.value); }} /><button className="button" type="button" onClick={() => void choose('parent')}>选择候选位置</button></div></label>
              {packageMode && <label>准备工作目录<div className="resource-folder-input"><input aria-label="自动更新准备工作目录" value={work} placeholder="选择已存在的目录" onChange={event => { invalidate(); setWork(event.target.value); }} /><button className="button" type="button" onClick={() => void choose('work')}>选择工作位置</button></div></label>}
              <label>下载目录<div className="resource-folder-input"><input aria-label="自动更新下载目录" value={downloads} onChange={event => { invalidate(); setDownloads(event.target.value); }} /><button className="button" type="button" onClick={() => void choose('downloads')}>选择下载位置</button></div></label>
              {packageMode ? <label>下载限速（MiB/s）<input aria-label="自动更新下载限速" type="number" min="0" step="any" inputMode="decimal" value={rate} aria-invalid={rateResult.error !== null} aria-describedby={rateNoteId} onChange={event => { invalidate(); setRate(event.target.value); }} /><small id={rateNoteId} className={rateResult.error ? 'error-text' : 'muted'}>{rateResult.error || '可填写小数；0 表示不限速。'}</small></label> : <label>精确 ZIP 发行文件名<input value={asset} onChange={event => { invalidate(); setAsset(event.target.value); }} /></label>}
            </div>
            <ScopeFiles files={status.currentScope.files} packageMode={packageMode} />
            <p className="muted">{packageMode ? '按固定配方准备后续稳定版本的运行文件、专用依赖和许可证。当前清单用于基线核对；不授权配置、凭据、共享运行环境变化或数据迁移。' : '范围沿用已核安装文件及用途；不接受通配符、增加文件、新权限、共享依赖变化或数据迁移。'}</p>
            {status.currentScope.pinnedVersion && <p>锁定版本：{status.currentScope.pinnedVersion}；其他版本不会自动应用。</p>}{!!status.currentScope.skippedVersions?.length && <p>跳过版本：{status.currentScope.skippedVersions.join('、')}</p>}
          </>}
          <div className="resource-detail-actions"><button className="button primary" type="submit" disabled={!status || stale || incomplete}>预览本次许可</button></div>
        </fieldset></form>
      </>}
      {plan && <section className="resource-effect-preview" aria-label="自动更新许可影响清单"><h4>{plan.enabled ? '确认明确授权的范围' : '确认撤销后续自动更新许可'}</h4>
        {plan.enabled && plan.scope && <><dl><dt>来源及身份</dt><dd className="resource-path">{plan.scope.repository} · {plan.scope.repositoryId}</dd><dt>候选目录父位置</dt><dd className="resource-path">{plan.scope.candidateParentPath}</dd>{plan.scope.runtimePackage && <><dt>准备工作位置</dt><dd className="resource-path">{plan.scope.runtimePackage.workDirectory}</dd></>}<dt>下载位置</dt><dd className="resource-path">{plan.scope.downloadDirectory}</dd>{plan.scope.runtimePackage ? <><dt>下载限速</dt><dd>{rateLabel(plan.scope.runtimePackage.bytesPerSecond)}</dd><dt>发行渠道</dt><dd>稳定版</dd></> : <><dt>渠道及资产</dt><dd>稳定版 · {plan.scope.assetName}</dd></>}</dl>{plan.scope.runtimePackage && <PackageRuntime source={plan.scope.runtimePackage} repository={plan.scope.repository} />}<ScopeFiles files={plan.scope.files} packageMode={!!plan.scope.runtimePackage} /></>}
        <ul>{plan.permissions.map((permission, index) => <li key={index}>{permission}</li>)}</ul>{plan.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
        <div className="resource-detail-actions"><button className="button primary" type="button" disabled={blocked || !plan.canApply} onClick={apply}>{plan.enabled ? '确认保存自动更新许可' : '确认撤销自动更新许可'}</button><button className="button" type="button" disabled={blocked} onClick={() => setPlan(null)}>取消本次许可确认</button></div>
      </section>}
    </section>}
  </div>;
}
