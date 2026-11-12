import { useEffect, useRef, useState } from 'react';
import './configuration-transfer.css';

type Item = { kind: string; id: string; data: Record<string, unknown> };
type Row = { key: string; kind: string; id: string; name: string; status: 'new' | 'same' | 'conflict' | 'blocked'; reason?: string; path?: string; pathStatus?: string; references?: { key: string; kind: string; id: string; status: 'local' | 'incoming' | 'unresolved' }[]; effect: string; current: unknown; incoming: unknown };
type Preview = { previewId: string; revision: number; document?: { formatVersion: number; items: Item[] }; items?: Row[]; path?: string };
type Action = <T>(label: string, command: string, args: Record<string, unknown>) => Promise<T>;
type Props = { action: Action; chooseImport: () => Promise<string | null>; chooseExport: () => Promise<string | null>; revision: number; readOnly?: boolean; visible?: boolean; onImported?: (state: unknown) => void };
const labels: Record<string, string> = { settings: '使用偏好', category: '分类', source: 'GitHub 来源', skill: '技能关联', tool: '工具关联', root: '导入目录', ignoredPaths: '忽略目录', annotation: '别名与备注', view: '常用筛选', template: '调用模板', scene: '场景', relation: '依赖关系' };
const statuses = { new: '新增关联', same: '相同，保持', conflict: '不同，可选择替换', blocked: '保留本机，需单独核对' };

export function ConfigurationTransfer({ action, chooseImport, chooseExport, revision, readOnly = false, visible = true, onImported }: Props) {
  const [preview, setPreview] = useState<Preview | null>(null), [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [page, setPage] = useState(0);
  const pending = useRef(false), generation = useRef(0), allowed = useRef(false);
  allowed.current = visible && !readOnly;
  useEffect(() => () => { generation.current++; allowed.current = false; }, []);
  useEffect(() => { if (!visible || readOnly) generation.current++; }, [visible, readOnly]);
  const stale = preview !== null && preview.revision !== revision;
  const rows = preview?.items || [], pageCount = Math.max(1, Math.ceil(rows.length / 50));
  const currentPage = Math.min(page, pageCount - 1), shown = rows.slice(currentPage * 50, (currentPage + 1) * 50);
  async function run(work: (current: () => boolean) => Promise<void>) {
    if (!allowed.current || pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    const request = ++generation.current;
    const current = () => request === generation.current && allowed.current;
    try { await work(current); } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pending.current = false; setBusy(false); }
  }
  function show(value: Preview) {
    setPreview(value); setPage(0);
    setSelected(new Set((value.items || []).filter(row => row.status === 'new').map(row => row.key)));
  }
  function importPreview() {
    return run(async current => {
      const path = await chooseImport(); if (!path || !current()) return;
      const value = await action<Preview>('核对配置导入', 'preview_configuration_import', { path });
      if (current()) show(value);
    });
  }
  function exportPreview() {
    return run(async current => { const value = await action<Preview>('准备配置导出', 'preview_configuration_export', {}); if (current()) show(value); });
  }
  function saveExport() {
    if (!preview?.document || stale) return;
    const shownPreview = preview;
    return run(async current => {
      const path = await chooseExport(); if (!path || !current()) return;
      const result = await action<{ path: string }>('导出管理配置', 'export_configuration', { previewId: shownPreview.previewId, path });
      if (current()) { setPreview(null); setNotice(`配置已保存：${result.path}`); }
    });
  }
  function applyImport() {
    if (!preview?.items || !selected.size || stale) return;
    const shownPreview = preview, choices = [...selected];
    return run(async current => {
      const result = await action<{ applied: number; state: unknown }>('导入管理配置', 'apply_configuration_import', { previewId: shownPreview.previewId, selected: choices });
      if (current()) { onImported?.(result.state); setPreview(null); setSelected(new Set()); setNotice(`已导入 ${result.applied} 项管理信息，其余本机信息保持。`); }
    });
  }
  const disabled = !visible || readOnly || busy;
  return <section className="configuration-transfer" aria-label="配置导入导出">
    <div><h3>配置导入与导出</h3><p className="muted small-text">保存管理设置与关联。先预览，再选择文件位置；不包含工具文件、登录凭据、命令授权或安装归属。</p></div>
    <div className="configuration-actions"><button type="button" disabled={disabled} onClick={() => void exportPreview()}>预览导出配置</button><button type="button" disabled={disabled} onClick={() => void importPreview()}>选择配置文件</button></div>
    {readOnly && <p className="muted small-text">基本模式中仅查看已有信息；正常启动后可导入导出。</p>}
    {busy && <p role="status">正在处理配置…</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {notice && <p role="status" className="configuration-path">{notice}</p>}
    {preview && <div className="configuration-preview">
      {stale && <p role="alert">管理信息已变化，请重新预览后操作。当前选择保留供核对。</p>}
      {preview.document && <>
        <p>将导出 {preview.document.items.length} 项管理信息。文件含个人备注和本地路径，请核对以下内容。</p>
        <details><summary>查看完整导出内容</summary><textarea aria-label="配置导出预览" readOnly rows={12} spellCheck={false} value={JSON.stringify(preview.document, null, 2)} /></details>
        <div className="configuration-actions"><button type="button" disabled={disabled || stale} onClick={() => void saveExport()}>选择位置并导出</button></div>
      </>}
      {preview.items && <>
        <p className="configuration-path">来自：{preview.path}</p>
        <p className="small-text">已选 {selected.size} / {rows.length} 项。不同内容默认保留本机；文件中缺少的项目不删除。新资源保持停用，调用模板仍须匹配本机动作。</p>
        <div className="configuration-actions"><button type="button" disabled={disabled || stale} onClick={() => setSelected(new Set(rows.filter(row => row.status === 'new').map(row => row.key)))}>只选新增</button><button type="button" disabled={disabled || stale} onClick={() => setSelected(new Set())}>取消选择</button></div>
        <div className="configuration-items">{shown.map(row => <div className="configuration-item" key={row.key}>
          <label><input type="checkbox" aria-label={`导入 ${row.name}`} disabled={disabled || stale || !['new', 'conflict'].includes(row.status)} checked={selected.has(row.key)} onChange={event => setSelected(old => { const next = new Set(old); if (event.target.checked) next.add(row.key); else next.delete(row.key); return next; })} /><span><strong>{row.name}</strong><span className="muted small-text">{labels[row.kind] || row.kind} · {statuses[row.status]}</span></span></label>
          {row.reason && <p className="small-text">{row.reason}</p>}{row.path && <p className="configuration-path muted small-text">{row.path}{row.pathStatus === 'unavailable' ? ' · 当前不可用，仅保留关联' : ''}</p>}
          <details><summary>查看差异与处理范围</summary><p className="small-text">{row.effect}</p>{!!row.references?.length && <ul aria-label={`${row.name}的关联去向`}>{row.references.map(reference => <li key={reference.key}>{labels[reference.kind] || reference.kind} · {reference.id}：{reference.status === 'local' ? '沿用本机记录' : reference.status === 'incoming' ? selected.has(reference.key) ? '随所选项目导入' : '需一并选择导入' : '未找到对应记录，需单独核对'}</li>)}</ul>}<div className="configuration-comparison"><div><strong>本机</strong><pre>{JSON.stringify(row.current, null, 2)}</pre></div><div><strong>文件内容</strong><pre>{JSON.stringify(row.incoming, null, 2)}</pre></div></div></details>
        </div>)}</div>
        {pageCount > 1 && <div className="configuration-actions" aria-label="配置项目分页"><button type="button" disabled={busy || currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button><span>{currentPage + 1} / {pageCount}</span><button type="button" disabled={busy || currentPage + 1 === pageCount} onClick={() => setPage(currentPage + 1)}>下一页</button></div>}
        <div className="configuration-actions"><button type="button" disabled={disabled || stale || selected.size === 0} onClick={() => void applyImport()}>导入所选管理信息</button></div>
      </>}
      <button type="button" disabled={busy} onClick={() => { setPreview(null); setSelected(new Set()); setError(''); }}>关闭预览</button>
    </div>}
  </section>;
}
