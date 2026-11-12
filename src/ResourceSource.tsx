import { useEffect, useId, useRef, useState } from 'react';
import type { Resource } from './resources';
import './resources.css';

type Action = <T>(label: string, action: string, args: Record<string, unknown>) => Promise<T>;
type PackageOrigin = { kind: 'githubRelease'; source: { repository: string; version: string; assetName: string; downloadUrl: string } } | { kind: 'npmRegistry'; package: string; version: string; tarball: string; integrity: string } | { kind: 'pyPiWheel'; package: string; version: string; url: string };
export type RuntimePackageSource = { recipe: 'agentReachWheelV1' | 'edgeMcpNpmV1'; version: string; planHash: string; artifacts: { origin: PackageOrigin; bytes: number; sha256: string }[] };
function publicPackageUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { const url = new URL(value); return url.protocol === 'https:' && ['github.com', 'registry.npmjs.org', 'files.pythonhosted.org'].includes(url.hostname) && !url.username && !url.password && !url.port && !url.hash && !url.search; } catch { return false; }
}
export function isRuntimePackageSource(value: unknown): value is RuntimePackageSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as RuntimePackageSource;
  const text = (item: unknown): item is string => typeof item === 'string' && item.length > 0 && item.length <= 4096 && !/[\u0000-\u001f]/.test(item);
  return ['agentReachWheelV1', 'edgeMcpNpmV1'].includes(data.recipe) && text(data.version) && typeof data.planHash === 'string' && /^[a-f\d]{64}$/i.test(data.planHash) && Array.isArray(data.artifacts) && data.artifacts.length > 0 && data.artifacts.length <= 129 && data.artifacts.every(artifact => {
    if (!artifact || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || typeof artifact.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(artifact.sha256) || !artifact.origin || typeof artifact.origin !== 'object') return false;
    const origin = artifact.origin;
    if (origin.kind === 'githubRelease') return !!origin.source && text(origin.source.repository) && text(origin.source.version) && text(origin.source.assetName) && publicPackageUrl(origin.source.downloadUrl);
    if (origin.kind === 'npmRegistry') return text(origin.package) && text(origin.version) && publicPackageUrl(origin.tarball) && typeof origin.integrity === 'string' && /^sha512-[A-Za-z\d+/]+={0,2}$/.test(origin.integrity);
    return origin.kind === 'pyPiWheel' && text(origin.package) && text(origin.version) && publicPackageUrl(origin.url);
  });
}
export function PackageSourceSummary({ value, unverified = false }: { value: RuntimePackageSource; unverified?: boolean }) {
  return <section aria-label={unverified ? '未核验的软件包来源提示' : '固定软件包来源'}>
    <p><strong>{value.recipe === 'agentReachWheelV1' ? 'Agent Reach · Python wheel 配方' : 'Playwright MCP · npm 配方'}</strong> · {value.version}</p>
    {unverified && <p className="muted">来自资源目录的记录，尚未核验发布者或共享运行环境；登记不会恢复安装归属、执行或自动更新许可。</p>}
    <details><summary>固定资产来源（{value.artifacts.length}）</summary><ul>{value.artifacts.map((artifact, index) => {
      const origin = artifact.origin;
      const title = origin.kind === 'githubRelease' ? `${origin.source.assetName} · ${origin.source.version}` : `${origin.package} · ${origin.version}`;
      const url = origin.kind === 'githubRelease' ? origin.source.downloadUrl : origin.kind === 'npmRegistry' ? origin.tarball : origin.url;
      return <li key={index}><strong>{title}</strong><p className="resource-path"><a href={url} target="_blank" rel="noreferrer">{url}</a></p><small title={artifact.sha256}>SHA-256：{artifact.sha256.slice(0, 16)}… · {artifact.bytes.toLocaleString()} B</small>{origin.kind === 'npmRegistry' && <p className="resource-path" title={origin.integrity}>npm integrity：{origin.integrity.slice(0, 30)}…</p>}</li>;
    })}</ul></details>
  </section>;
}
export type SourceAsset = { releaseId: number; assetId: number; tag: string; assetName: string; size: number; digest: string | null; url: string; updatedAt: string };
export type SourceBinding = { repository: string; repositoryId: number; asset: SourceAsset | null; verifiedAt: string };
export type ResourceSourceData = {
  id: string; resourceRevision: number; repository: string | null; installedVersion: string | null;
  installationSource: { repository: string | null; version: string | null; archiveSha256: string; downloadSource: Record<string, unknown> | null; runtimePackage?: RuntimePackageSource | null; runtimePackageError?: string | null } | null;
  binding: SourceBinding | null; history: { changedAt: string; repository: string | null; binding: SourceBinding | null; capabilities: Record<string, unknown>[] }[];
  mappingStatus: 'repositoryOnly' | 'releaseAsset'; requiresVerification: boolean;
};
export type SourceHealth = { status: 'reachable' | 'unavailable' | 'authentication' | 'permission' | 'rateLimited' | 'network' | 'changed' | 'error' | 'unconfigured'; message: string; checkedAt: string };
type VersionObservation = { id: string; message: string; installedVersion?: string | null; check: { status: string; message: string; checkedAt: string; nextCheckAt: string; latest: { version: string; url: string } | null } | null };
export type SourcePreview = { previewId: string; kind: 'resourceSource'; id: string; resourceRevision: number; previous: ResourceSourceData; next: SourceBinding; mappingStatus: 'repositoryOnly' | 'releaseAsset'; canApply: boolean; warnings: string[] };
type ReleaseAsset = { id: number; name: string; size: number; url: string | null; digest?: string | null; updatedAt?: string; unavailableReason?: string };
type Releases = { repository: string; author: string; releases: { id: number; tag: string; name: string; url: string; publishedAt: string; prerelease: boolean; assets: ReleaseAsset[] }[] };
export type ResourceSourceProps = { resource: Resource; action: Action; onChanged: () => void; readOnly?: boolean; visible?: boolean };
const healthLabels: Record<SourceHealth['status'], string> = { reachable: '来源可访问', unavailable: '来源当前不可访问', authentication: '需要身份验证', permission: '访问权限不足', rateLimited: '请求频率受限', network: '网络连接失败', changed: '来源映射已变化', error: '检查未完成', unconfigured: '尚未关联来源' };
const dateLabel = (value: string) => Number.isNaN(Date.parse(value)) ? '未提供' : new Date(value).toLocaleString();

function Mapping({ repository, binding }: { repository: string | null; binding: SourceBinding | null }) {
  return <div className="resource-source-mapping"><span>{repository || '尚未关联仓库'}</span>{binding?.asset ? <span>发行标签：{binding.asset.tag} · 文件：{binding.asset.assetName}（发行 ID {binding.asset.releaseId}，文件 ID {binding.asset.assetId}）</span> : <span className="muted">仅仓库关联，未选择具体发行文件</span>}</div>;
}

export function ResourceSource(props: ResourceSourceProps) { return <SourceEditor key={props.resource.id} {...props} />; }

function SourceEditor({ resource, action, onChanged, readOnly = false, visible = true }: ResourceSourceProps) {
  const [opened, setOpened] = useState(false), [data, setData] = useState<ResourceSourceData | null>(null), [health, setHealth] = useState<SourceHealth | null>(null);
  const [versionCheck, setVersionCheck] = useState<VersionObservation | null>(null);
  const [repository, setRepository] = useState(resource.repository || ''), [mapping, setMapping] = useState<'repositoryOnly' | 'releaseAsset'>('repositoryOnly');
  const [catalogue, setCatalogue] = useState<Releases | null>(null), [releaseId, setReleaseId] = useState(''), [assetId, setAssetId] = useState('');
  const [plan, setPlan] = useState<{ value: SourcePreview; key: string; draft: number } | null>(null);
  const [phase, setPhase] = useState<'read' | 'readVersion' | 'health' | 'releases' | 'preview' | 'apply' | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [conflict, setConflict] = useState(false);
  const contentId = useId(), alive = useRef(true), lock = useRef(false), queuedRead = useRef(false), epoch = useRef(0), draftEpoch = useRef(0);
  const contextKey = JSON.stringify([resource.id, resource.revision, readOnly]);
  const current = useRef({ key: contextKey, visible, opened, readOnly, revision: resource.revision }); current.current = { key: contextKey, visible, opened, readOnly, revision: resource.revision };
  const actionRef = useRef(action), onChangedRef = useRef(onChanged), dataRef = useRef(data); actionRef.current = action; onChangedRef.current = onChanged;
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; }; }, []);
  function active() { return alive.current && current.current.visible && current.current.opened; }
  function invalidateDraft() { draftEpoch.current++; setPlan(null); setNotice(''); setError(''); }
  function accept(value: ResourceSourceData) {
    if (value.id !== resource.id) throw new Error('来源结果不属于当前工具，请刷新后重试。');
    if (value.resourceRevision < current.current.revision || dataRef.current && value.resourceRevision < dataRef.current.resourceRevision) throw new Error('来源信息已变化，请刷新后重试。');
    dataRef.current = value; setData(value); setConflict(false);
  }
  async function request<T>(nextPhase: NonNullable<typeof phase>, label: string, command: string, args: Record<string, unknown>, receive: (value: T) => void, draftScoped = false) {
    if (!active() || lock.current || (!['read', 'readVersion'].includes(nextPhase) && current.current.readOnly)) return;
    const key = current.current.key, started = epoch.current, draft = draftEpoch.current;
    const valid = () => active() && current.current.key === key && started === epoch.current && (!draftScoped || draft === draftEpoch.current);
    lock.current = true; setPhase(nextPhase); setError('');
    try { const value = await actionRef.current<T>(label, command, args); if (valid()) receive(value); }
    catch (cause) { if (valid()) { setError(String(cause)); if (/revision|conflict|变化|更改|冲突|过期/i.test(String(cause))) { setConflict(true); setPlan(null); } } }
    finally { lock.current = false; if (alive.current) setPhase(null); if (queuedRead.current && active()) void reload(); }
  }
  async function reload() {
    if (!active()) return;
    if (lock.current) { queuedRead.current = true; return; }
    queuedRead.current = false; setPlan(null);
    await request<ResourceSourceData>('read', '读取工具来源关联', 'resource_source', { id: resource.id }, value => { accept(value); setHealth(null); });
  }
  useEffect(() => {
    epoch.current++; setPlan(null); setHealth(null); setVersionCheck(null);
    if (visible && opened) void reload();
  }, [visible, opened, contextKey]);
  const release = catalogue?.releases.find(item => String(item.id) === releaseId), asset = release?.assets.find(item => String(item.id) === assetId);
  const blocked = !visible || readOnly || phase !== null || conflict || !data || data.resourceRevision < resource.revision;
  const visiblePlan = plan?.key === contextKey && plan.draft === draftEpoch.current ? plan.value : null;
  function changeRepository(value: string) { invalidateDraft(); setRepository(value); setCatalogue(null); setReleaseId(''); setAssetId(''); }
  function queryReleases() {
    if (blocked || lock.current || !repository.trim()) return;
    invalidateDraft(); setCatalogue(null); setReleaseId(''); setAssetId('');
    void request<Releases>('releases', '读取来源发行文件', 'resource_github_releases', { repository: repository.trim() }, value => setCatalogue(value), true);
  }
  function checkHealth() {
    if (blocked || lock.current) return;
    setPlan(null);
    void request<ResourceSourceData & { health: SourceHealth }>('health', '检查工具来源', 'resource_source_health', { id: resource.id, expectedRevision: data!.resourceRevision }, value => { accept(value); setHealth(value.health); });
  }
  function readVersionCheck() {
    if (!visible || lock.current) return;
    void request<VersionObservation>('readVersion', '读取最近版本检查', 'resource_version_check_status', { id: resource.id }, value => {
      if (value.id !== resource.id) throw new Error('版本检查不属于当前工具。');
      setVersionCheck(value);
    });
  }
  function preview() {
    if (blocked || lock.current || !repository.trim() || mapping === 'releaseAsset' && (!release || !asset || asset.unavailableReason || !asset.url)) return;
    invalidateDraft();
    void request<SourcePreview>('preview', '预览工具来源关联', 'preview_resource_source', { id: resource.id, expectedRevision: data!.resourceRevision, repository: repository.trim(), ...(mapping === 'releaseAsset' ? { releaseId: release!.id, assetId: asset!.id } : {}) }, value => {
      if (value.id !== resource.id || value.previous.id !== resource.id || value.resourceRevision !== data!.resourceRevision || value.previous.resourceRevision !== value.resourceRevision) throw new Error('来源预览与当前工具或版本不符，请刷新后重试。');
      setPlan({ value, key: contextKey, draft: draftEpoch.current });
    }, true);
  }
  function apply() {
    if (blocked || !visiblePlan?.canApply) return;
    void request<ResourceSourceData>('apply', '保存已确认的工具来源关联', 'apply_resource_source', { previewId: visiblePlan.previewId }, value => {
      accept(value); setPlan(null); setHealth(null); setNotice('来源关联已保存；已安装版本和本地文件保持不变。'); onChangedRef.current();
    }, true);
  }
  return <section className="resource-source" aria-label="工具来源关联">
    <button className="button" type="button" aria-expanded={opened} aria-controls={contentId} disabled={!visible || phase === 'apply'} onClick={() => setOpened(value => !value)}>来源与健康</button>
    {opened && <div id={contentId} className="resource-source-content" aria-busy={phase !== null}>
      <div className="resource-detail-actions"><button className="button" type="button" disabled={!visible || phase !== null} onClick={() => void reload()}>刷新来源信息</button>{!readOnly && <button className="button" type="button" disabled={blocked} onClick={checkHealth}>检查来源健康</button>}</div>
      {data && <>
        <section aria-label="当前来源关联"><h4>当前关联</h4><Mapping repository={data.repository} binding={data.binding} /><p>{data.installationSource ? '已安装版本' : '安装版本登记值（未核实）'}：{data.installedVersion || '尚未核实'}</p>{!data.binding && data.repository && <p className="muted">当前仅有登记信息，来源尚待核对。</p>}{data.requiresVerification && <p className="muted">来源关联不代表本地兼容性或运行能力已通过验证。</p>}{data.binding && <p className="muted">关联核对时间：<time dateTime={data.binding.verifiedAt}>{dateLabel(data.binding.verifiedAt)}</time></p>}</section>
        <section aria-label="原安装来源"><h4>原安装来源</h4>{data.installationSource ? data.installationSource.runtimePackage ? isRuntimePackageSource(data.installationSource.runtimePackage) ? <PackageSourceSummary value={data.installationSource.runtimePackage} /> : <p role="alert">软件包来源记录格式不完整，请重新核对。</p> : data.installationSource.runtimePackageError ? <p role="alert">软件包来源尚未完整核对：{data.installationSource.runtimePackageError}</p> : <><p>{data.installationSource.repository || '未记录仓库'} · 安装版本：{data.installationSource.version || '未记录'}</p><p className="muted">安装包摘要：{data.installationSource.archiveSha256 || '未记录'}</p></> : <p className="muted">未记录安装来源；当前关联不作为安装来源证明。</p>}</section>
        {data.history.length > 0 && <details className="resource-source-history"><summary>历史关联（{data.history.length}）</summary><ol>{data.history.map((item, index) => <li key={`${item.changedAt}:${index}`}><time dateTime={item.changedAt}>{dateLabel(item.changedAt)}</time><Mapping repository={item.repository} binding={item.binding} /></li>)}</ol></details>}
      </>}
      {health && <section aria-label="来源健康结果"><strong>{data?.installationSource?.runtimePackage && health.status === 'reachable' ? '仓库可访问' : healthLabels[health.status]}</strong><p>{health.message}</p>{data?.installationSource?.runtimePackage && <p className="muted">本次只检查 GitHub 仓库关联，未联网核验以上软件包资产是否仍可下载。</p>}<p className="muted">检查时间：<time dateTime={health.checkedAt}>{dateLabel(health.checkedAt)}</time></p></section>}
      <div className="resource-detail-actions"><button className="button" type="button" disabled={!visible || phase !== null} onClick={readVersionCheck}>查看最近版本检查</button></div>
      {versionCheck && <section aria-label="最近版本检查"><p>{versionCheck.message}</p>{versionCheck.check && <><strong>{versionCheck.check.latest ? `最近稳定版本：${versionCheck.check.latest.version}` : versionCheck.check.message}</strong><dl><dt>当前登记</dt><dd>{versionCheck.installedVersion || '未知'}</dd><dt>检查时间</dt><dd>{dateLabel(versionCheck.check.checkedAt)}</dd><dt>下次检查</dt><dd>{dateLabel(versionCheck.check.nextCheckAt)}</dd></dl><p>{versionCheck.check.message}</p></>}</section>}
      {!readOnly && data && <div className="resource-source-editor">
        <p className="muted">更改关联前先核对旧、新映射。这里只保存来源关联，不下载、不安装，也不更改已安装版本。</p>
        <label>新的 GitHub 来源<input aria-label="新的 GitHub 来源" value={repository} disabled={!visible || phase === 'apply'} onChange={event => changeRepository(event.target.value)} placeholder="https://github.com/作者/仓库" /></label>
        <label>关联范围<select aria-label="来源关联范围" value={mapping} disabled={!visible || phase === 'apply'} onChange={event => { invalidateDraft(); setMapping(event.target.value as typeof mapping); }}><option value="repositoryOnly">仅关联仓库</option><option value="releaseAsset">关联具体发行文件</option></select></label>
        {mapping === 'releaseAsset' && <>
          <button className="button" type="button" disabled={blocked || !repository.trim()} onClick={queryReleases}>查询来源发行文件</button>
          {catalogue && <><p className="muted">已查询：{catalogue.repository}</p><div className="resource-github-fields"><label>发行版本<select aria-label="来源发行版本" value={releaseId} disabled={!visible || phase === 'apply'} onChange={event => { invalidateDraft(); setReleaseId(event.target.value); setAssetId(''); }}><option value="">请选择发行版本</option>{catalogue.releases.map(item => <option value={item.id} key={item.id}>{item.tag}{item.prerelease ? ' · 预发布' : ''}</option>)}</select></label><label>发行文件<select aria-label="来源发行文件" value={assetId} disabled={!visible || phase === 'apply' || !release} onChange={event => { invalidateDraft(); setAssetId(event.target.value); }}><option value="">请选择具体文件</option>{release?.assets.map(item => <option value={item.id} key={item.id} disabled={!!item.unavailableReason || !item.url}>{item.name}{item.unavailableReason ? ` · ${item.unavailableReason}` : ''}</option>)}</select></label></div>{(!catalogue.releases.length || release && !release.assets.length) && <p>没有可选发行文件，请核对来源；不会自动选择其他文件。</p>}</>}
        </>}
        <button className="button" type="button" disabled={blocked || !repository.trim() || mapping === 'releaseAsset' && (!release || !asset || !!asset.unavailableReason || !asset.url)} onClick={preview}>预览来源关联</button>
      </div>}
      {visiblePlan && !readOnly && <section className="resource-effect-preview" aria-label="来源关联预览"><h4>确认来源关联变更</h4><div className="resource-source-comparison"><section aria-label="原关联"><h4>原关联</h4><Mapping repository={visiblePlan.previous.repository} binding={visiblePlan.previous.binding} /></section><section aria-label="新关联"><h4>新关联</h4><Mapping repository={visiblePlan.next.repository} binding={visiblePlan.next} /></section></div>{visiblePlan.warnings.map((warning, index) => <p key={index}>{warning}</p>)}<p>仅保存以上关联；不下载、不安装，不更改已安装版本。</p><button className="button primary" type="button" disabled={blocked || !visiblePlan.canApply} onClick={apply}>确认保存来源关联</button></section>}
      {!data && phase === 'read' && <p className="muted">正在读取来源信息…</p>}
      {conflict && <p className="muted">工具信息已变化，输入仍保留；请刷新来源信息后重新预览。</p>}
      {error && <p className="resource-error" role="alert">{error}</p>}{notice && <p className="resource-notice" role="status">{notice}</p>}
    </div>}
  </section>;
}
