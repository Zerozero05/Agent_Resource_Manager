import { useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { Download, FolderOpen } from 'lucide-react';

type Action = <T>(label: string, action: string, args: Record<string, unknown>) => Promise<T>;
type Asset = { id: number; name: string; size: number; digest?: string | null; url: string; updatedAt: string };
type Release = { id: number; tag: string; name: string; url: string; publishedAt: string; prerelease: boolean; assets: Asset[] };
type Releases = { repository: string; author: string; releases: Release[] };
type DownloadRecord = { id: string; status: string; assetName: string; repository: string; version: string; targetPath: string; partialPath: string; receivedBytes: number; totalBytes: number; updatedAt: string };
type DownloadPage = { downloads: DownloadRecord[]; total: number; offset: number; limit: number };
type DownloadPlan = { id: string; kind: 'resourceDownload'; repository: string; version: string; author: string; releaseId: number; assetId: number; assetName: string; downloadUrl: string; targetPath: string; downloadBytes: number; expectedSha256?: string | null; alreadyComplete?: boolean; canApply: boolean; warnings: string[] };
export type GithubDownload = { format?: 'zip' | 'pythonWheel'; archivePath: string; downloadId: string; source: { repository: string; version: string; verification: string; author?: string }; files: { path: string; bytes: number; license: boolean }[]; unpackedBytes: number };
const bytes = (value: number) => value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MiB` : `${(value / 1024).toFixed(1)} KiB`;
const downloadStatus: Record<string, string> = { prepared: '待下载', pending: '待下载', downloading: '下载尚未收尾，需核对', partial: '部分完成', interrupted: '中断待核对', failed: '下载失败', cancelled: '已取消', completed: '已下载', complete: '已下载' };

export function ResourceGithub({ action, disabled = false, packageFormat = 'zip', onDownloaded, onReset, onBusyChange }: { action: Action; disabled?: boolean; packageFormat?: 'zip' | 'reachWheel'; onDownloaded: (value: GithubDownload) => void; onReset: () => void; onBusyChange: (value: boolean) => void }) {
  const [repository, setRepository] = useState(packageFormat === 'reachWheel' ? 'https://github.com/panniantong/agent-reach' : ''), [tag, setTag] = useState('');
  const [catalogue, setCatalogue] = useState<Releases | null>(null), [releaseId, setReleaseId] = useState(''), [assetId, setAssetId] = useState('');
  const [directory, setDirectory] = useState(''), [limit, setLimit] = useState('0');
  const [plan, setPlan] = useState<DownloadPlan | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [downloads, setDownloads] = useState<DownloadPage | null>(null), [historyOpened, setHistoryOpened] = useState(false), [resumeId, setResumeId] = useState('');
  const lock = useRef(false), epoch = useRef(0), mounted = useRef(true);
  const busyCallback = useRef(onBusyChange); busyCallback.current = onBusyChange;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; busyCallback.current(false); }; }, []);
  const release = catalogue?.releases.find(item => String(item.id) === releaseId);
  const asset = release?.assets.find(item => String(item.id) === assetId);
  const supported = !!asset && (packageFormat === 'reachWheel'
    ? /^https:\/\/github\.com\/panniantong\/agent-reach\/?$/i.test(catalogue?.repository || '') && asset.name === `agent_reach-${release?.tag.replace(/^v/, '')}-py3-none-any.whl` && !!asset.digest
    : /\.zip$/i.test(asset.name));
  const rate = Number(limit), validRate = limit.trim() !== '' && Number.isFinite(rate) && rate >= 0 && Number.isSafeInteger(Math.round(rate * 1024 * 1024));
  function invalidate() { epoch.current++; setPlan(null); setResumeId(''); setNotice(''); setError(''); onReset(); }
  function resetSource() { invalidate(); setCatalogue(null); setReleaseId(''); setAssetId(''); }
  async function request<T>(label: string, command: string, args: Record<string, unknown>, receive: (value: T) => void) {
    if (disabled || lock.current) return;
    const generation = epoch.current;
    lock.current = true; setBusy(true); onBusyChange(true); setError('');
    try { const value = await action<T>(label, command, args); if (mounted.current && generation === epoch.current) receive(value); }
    catch (cause) { if (mounted.current && generation === epoch.current) setError(String(cause)); }
    finally { lock.current = false; if (mounted.current) { setBusy(false); onBusyChange(false); } }
  }
  function query() {
    if (!repository.trim()) return;
    resetSource();
    void request<Releases>('查询 GitHub 发行版本', 'resource_github_releases', { repository: repository.trim(), ...(tag.trim() ? { tag: tag.trim() } : {}) }, value => {
      setCatalogue(value); setNotice(value.releases.length ? '选择具体版本与发行文件，再预览下载。' : '没有可用发行版本，请核对来源或固定版本。');
    });
  }
  async function chooseDirectory() {
    if (busy || disabled) return;
    const generation = epoch.current;
    try { const selected = await open({ directory: true, multiple: false, title: '选择本次发行包下载位置' }); if (mounted.current && generation === epoch.current && typeof selected === 'string') { invalidate(); setDirectory(selected); } }
    catch (cause) { if (mounted.current && generation === epoch.current) setError(String(cause)); }
  }
  function preview() {
    if (!catalogue || !release || !asset || !supported || !directory.trim() || !validRate) return;
    invalidate();
    void request<DownloadPlan>('预览发行文件下载', 'preview_resource_download', { repository: catalogue.repository, releaseId: release.id, assetId: asset.id, downloadDirectory: directory.trim(), bytesPerSecond: Math.round(rate * 1024 * 1024) }, setPlan);
  }
  function loadDownloads(offset = downloads?.offset ?? 0) {
    if (lock.current || disabled) return;
    epoch.current++; setHistoryOpened(true); setPlan(null); setResumeId('');
    void request<DownloadPage>('读取已有下载记录', 'resource_downloads', { offset, limit: 20 }, setDownloads);
  }
  function previewResume(record: DownloadRecord) {
    if (busy || disabled) return;
    resetSource(); setRepository(record.repository); setTag(record.version); setResumeId(record.id);
    void request<DownloadPlan>('核对已有下载与续传范围', 'preview_resource_resume', { downloadId: record.id }, setPlan);
  }
  function download() {
    if (!plan?.canApply) return;
    const selectedPlan = plan;
    void request<GithubDownload>(selectedPlan.alreadyComplete ? '核对已有完整发行文件' : '下载已确认的发行文件', 'apply_resource_download', { previewId: selectedPlan.id }, value => {
      setPlan(null); setResumeId(''); setDownloads(null); setHistoryOpened(false);
      if (packageFormat === 'zip' && value.format === 'pythonWheel' || packageFormat === 'reachWheel' && value.format !== 'pythonWheel') {
        setError('该下载属于另一种安装方式，请在对应来源中核对使用。已下载文件保留。'); return;
      }
      onDownloaded(value); setNotice(packageFormat === 'reachWheel' ? '官方 wheel 已下载并校验。请在下方预览依赖和专用运行环境。' : '发行包已下载并校验。请在下方选择必要运行文件和安装位置。');
    });
  }
  return <section className="resource-github" aria-label="从 GitHub 下载发行包" aria-busy={busy}>
    <p className="muted">查询版本不会下载程序。下载前选择保存位置，下载后再核对必要文件；不获取整仓源码。</p>
    {error && <div className="resource-error" role="alert">{error}</div>}
    <div className="resource-detail-actions"><button className="button" type="button" disabled={busy || disabled} aria-expanded={historyOpened} onClick={() => loadDownloads()}>继续已有下载</button></div>
    {historyOpened && <section className="resource-download-history" aria-label="已有下载记录">
      <div className="resource-editor-title"><h3>已有下载</h3><div className="resource-detail-actions"><button className="button" type="button" disabled={busy || disabled} onClick={() => loadDownloads()}>刷新记录</button><button className="button" type="button" disabled={busy || disabled} onClick={() => setHistoryOpened(false)}>收起记录</button></div></div>
      <p className="muted">记录不会自动重启下载。先核对文件和来源，再确认继续；实际进度以核对结果为准。</p>
      {downloads === null ? <p>{busy ? '正在读取记录…' : '记录尚未读取成功，请刷新重试。'}</p> : downloads.downloads.length === 0 ? <p>{downloads.total ? '本页没有记录，可返回上一页。' : '没有可继续的下载记录。'}</p> : <ul aria-label="下载记录列表" key={downloads.offset}>{downloads.downloads.map(record => <li key={record.id}>
        <div className="resource-download-record-heading"><strong>{record.assetName}</strong><span>{downloadStatus[record.status] || '状态待核对'}</span></div>
        <p>{record.repository} · {record.version}</p>
        <p>已接收 {bytes(record.receivedBytes)} / {bytes(record.totalBytes)}{record.totalBytes > 0 ? ` · ${Math.min(100, Math.max(0, Math.round(record.receivedBytes / record.totalBytes * 100)))}%` : ''}</p>
        {record.totalBytes > 0 && <progress max={record.totalBytes} value={Math.min(record.totalBytes, Math.max(0, record.receivedBytes))} aria-label={`${record.assetName} 已接收进度`} />}
        <p className="resource-path">保存位置：{record.targetPath}</p>
        {record.partialPath && <p className="resource-path muted">未完成文件：{record.partialPath}</p>}
        <div className="resource-download-record-footer"><time dateTime={record.updatedAt}>记录时间：{Number.isNaN(Date.parse(record.updatedAt)) ? '未提供' : new Date(record.updatedAt).toLocaleString()}</time><button className="button" type="button" disabled={busy || disabled} onClick={() => previewResume(record)}>{record.status === 'complete' || record.status === 'completed' ? '核对已下载文件' : '核对并继续'}</button></div>
      </li>)}</ul>}
      {downloads && <nav className="resource-download-pages" aria-label="下载记录分页"><span role="status">{downloads.downloads.length ? `第 ${downloads.offset + 1}–${downloads.offset + downloads.downloads.length} 条，共 ${downloads.total} 条` : `共 ${downloads.total} 条`}</span><div className="resource-detail-actions"><button className="button" type="button" disabled={busy || disabled || downloads.offset === 0} onClick={() => loadDownloads(Math.max(0, downloads.offset - downloads.limit))}>上一页</button><button className="button" type="button" disabled={busy || disabled || downloads.offset + downloads.limit >= downloads.total} onClick={() => loadDownloads(downloads.offset + downloads.limit)}>下一页</button></div></nav>}
    </section>}
    <form onSubmit={event => { event.preventDefault(); query(); }} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }}>
      <fieldset disabled={busy || disabled}>
        <div className="resource-github-fields">
          <label className="resource-github-source">GitHub 仓库或发行链接<input required value={repository} placeholder="https://github.com/作者/仓库" onChange={event => { resetSource(); setRepository(event.target.value); }} /></label>
          <label>固定版本（可选）<input value={tag} placeholder="例如 v1.2.0" onChange={event => { resetSource(); setTag(event.target.value); }} /></label>
        </div>
        <div className="resource-detail-actions"><button className="button" type="submit" disabled={!repository.trim()}>{busy ? '正在处理…' : '查询发行版本'}</button></div>
      </fieldset>
    </form>
    {catalogue && <form onSubmit={event => { event.preventDefault(); preview(); }} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }}>
      <fieldset disabled={busy || disabled}>
          <p className="resource-path muted">来源：{catalogue.repository} · 作者：{catalogue.author || '未提供'}</p>
          {catalogue.releases.length > 0 && <div className="resource-github-fields">
            <label>发行版本<select value={releaseId} onChange={event => { invalidate(); setReleaseId(event.target.value); setAssetId(''); }}><option value="">请选择版本</option>{catalogue.releases.map(item => <option key={item.id} value={item.id}>{item.tag}{item.prerelease ? ' · 预发布' : ''}{item.name && item.name !== item.tag ? ` · ${item.name}` : ''}</option>)}</select></label>
            <label>发行文件<select value={assetId} disabled={!release} onChange={event => { invalidate(); setAssetId(event.target.value); }}><option value="">请选择发行文件</option>{release?.assets.map(item => <option key={item.id} value={item.id}>{item.name} · {bytes(item.size)}</option>)}</select></label>
          </div>}
          {release && !release.assets.length && <p>此版本没有附带发行文件，不会自动改为下载源码。</p>}
          {asset && <p className="muted">文件大小：{bytes(asset.size)}。{supported ? (packageFormat === 'reachWheel' ? '已选择官方通用 Python wheel；下载后核对包内记录，不直接执行。' : '当前安装流程支持 ZIP；请按项目说明核对 Windows 版本、架构和依赖。') : '当前安装流程尚不支持此文件，请选择对应来源、版本和格式的发行包。'}</p>}
          {supported && <>
            <label>下载保存目录<div className="resource-folder-input"><input value={directory} placeholder="选择本次下载使用的现有目录" onChange={event => { invalidate(); setDirectory(event.target.value); }} /><button className="button" type="button" onClick={() => void chooseDirectory()}><FolderOpen size={16} />选择目录</button></div></label>
            <label className="resource-download-limit">下载限速（MiB/s，0 为不限速）<input type="number" min="0" max="1024" step="any" value={limit} onChange={event => { invalidate(); setLimit(event.target.value); }} /></label>
            {!validRate && <p role="alert">请输入大于或等于 0 的有效限速。</p>}
            <div className="resource-detail-actions"><button className="button" type="submit" disabled={!directory.trim() || !validRate}>预览下载</button></div>
          </>}
      </fieldset>
    </form>}
    {notice && <p role="status">{notice}</p>}
    {plan && <section className="resource-effect-preview" aria-label="下载影响清单"><h3>{plan.alreadyComplete ? '核对已有完整文件' : resumeId ? '确认继续已有下载' : '确认本次下载'}</h3><dl><dt>来源与版本</dt><dd>{plan.repository} · {plan.version}</dd><dt>发布作者</dt><dd>{plan.author || '未提供'}</dd><dt>发行文件</dt><dd>{plan.assetName}</dd><dt>下载地址</dt><dd>{plan.downloadUrl}</dd><dt>保存位置</dt><dd className="resource-path">{plan.targetPath}</dd><dt>发行文件大小</dt><dd>{bytes(plan.downloadBytes)}</dd><dt>上游校验摘要</dt><dd>{plan.expectedSha256 || '上游未提供；本地摘要不能证明与上游摘要一致。'}</dd></dl><p className="muted">{plan.alreadyComplete ? '此步核对本地已有文件，不再次下载。' : '包内范围须下载后读取，暂不把下载量当作最终安装占用。'}此步不会运行程序或安装脚本。</p>{plan.warnings.map((warning, index) => <p key={index}>{warning}</p>)}<div className="resource-detail-actions"><button className="button primary" type="button" disabled={busy || disabled || !plan.canApply} onClick={download}><Download size={16} />{plan.alreadyComplete ? '使用已完成文件' : resumeId ? '确认继续此文件' : '确认下载此文件'}</button></div></section>}
  </section>;
}
