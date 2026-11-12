import { useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Box, ChevronLeft, ChevronRight, Layers3, Search } from 'lucide-react';
import { categoryColors, type Category } from './categories';
import { CategoryChip } from './CategoryColor';
import { paginateLibrary } from './library';
import { reconcileLibraryReading } from './library-reading';
import { LibraryReadingBoundary } from './LibraryReadingBoundary';
import type { ResourceCatalogueState } from './commands';
import type { SavedView } from './management-data';
import { queryResourceLibrary, resourceLibraryDraft, resourceLibraryEntries, type ResourceLibraryDraft, type ResourceLibraryEntry, type ResourceLibraryKind, type ResourceLibrarySkill } from './resource-library';
import './resource-library.css';

type Props = {
  skills: readonly ResourceLibrarySkill[]; tools: ResourceCatalogueState; categories: readonly Category[];
  ready: boolean; initialDraft?: ResourceLibraryDraft; onDraft: (draft: ResourceLibraryDraft) => void;
  onOpen: (entry: ResourceLibraryEntry) => void; onRetry: () => void;
  savedViews: readonly SavedView[]; onSavedView: (id: string) => void;
  paneRoot: RefObject<HTMLElement | null>;
};

export function ResourceLibrary({ skills, tools, categories, ready, initialDraft, onDraft, onOpen, onRetry, savedViews, onSavedView, paneRoot }: Props) {
  const [draft, setDraft] = useState(() => resourceLibraryDraft(initialDraft));
  const readingRef = useRef(draft.reading);
  const searchId = useId();
  const all = useMemo(() => resourceLibraryEntries(skills, tools.resources), [skills, tools.resources]);
  const candidates = useMemo(() => queryResourceLibrary(skills, tools.resources, draft), [skills, tools.resources, draft.query, draft.kind, draft.category, draft.attention]);
  const key = JSON.stringify([draft.query, draft.kind, draft.category, draft.attention, draft.refresh]);
  const reading = useMemo(() => reconcileLibraryReading(readingRef.current, all.map(item => item.id), candidates.map(item => item.id), key), [all, candidates, key]);
  const rows = useMemo(() => {
    const byId = new Map(all.map(item => [item.id, item]));
    return reading.ids.flatMap(id => { const entry = byId.get(id); return entry ? [entry] : []; });
  }, [all, reading]);
  const page = paginateLibrary(rows, draft.page, draft.pageSize);
  const colors = useMemo(() => categoryColors(categories), [categories]);
  useLayoutEffect(() => {
    readingRef.current = reading;
    onDraft({ ...draft, page: page.page, reading: { key: reading.key, ids: reading.ids } });
    if (draft.page !== page.page) setDraft(previous => ({ ...previous, page: page.page }));
  }, [draft, reading, page.page, onDraft]);
  const patch = (value: Partial<ResourceLibraryDraft>) => setDraft(previous => ({ ...previous, page: 1, ...value }));
  const incomplete = !ready || !tools.loaded || tools.stale;

  return <section className="library-panel unified-library" aria-label="全部资源">
    <div className="unified-toolbar">
      <label className="unified-search" htmlFor={searchId}><Search size={18} aria-hidden="true" /><input id={searchId} aria-label="搜索全部资源" value={draft.query} onChange={event => patch({ query: event.target.value })} placeholder="搜索名称、别名、路径或用途" /></label>
      <div className="unified-types" role="group" aria-label="资源类型">{([['all', '全部'], ['skills', 'Skills'], ['tools', '工具']] as const).map(([kind, label]) => <button type="button" key={kind} aria-pressed={draft.kind === kind} onClick={() => patch({ kind: kind as ResourceLibraryKind })}>{label}</button>)}</div>
      <div className="unified-filters">
        {draft.kind !== 'tools' && <label>Skill 分类<select aria-label="筛选Skill分类" value={draft.category} onChange={event => patch({ category: event.target.value })}><option value="all">全部分类</option><option value="favorites">收藏</option><option value="uncategorized">未分类</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>}
        <label className="unified-attention"><input type="checkbox" checked={draft.attention} onChange={event => patch({ attention: event.target.checked })} />需要处理</label>
        {savedViews.length > 0 && <label>常用筛选<select aria-label="打开常用筛选" value="" onChange={event => onSavedView(event.target.value)}><option value="" disabled>选择已保存视图</option>{savedViews.map(view => <option key={view.id} value={view.id}>{view.name} · {view.view === 'skills' ? 'Skills' : '工具'}</option>)}</select></label>}
        {(draft.query || draft.category !== 'all' || draft.attention) && <button className="button ghost" type="button" onClick={() => patch({ query: '', category: 'all', attention: false })}>清除筛选</button>}
      </div>
    </div>
    <div className="unified-summary" role="status"><span>{page.total} 项{incomplete ? '已读取结果' : '结果'}</span>{tools.loading ? <span>正在读取工具…</span> : tools.error ? <span className="error-text">工具读取失败 <button type="button" onClick={onRetry}>重试</button></span> : tools.stale && tools.loaded ? <span>工具显示上次读取结果 <button type="button" onClick={onRetry}>刷新</button></span> : null}{reading.pending && <button type="button" onClick={() => patch({ refresh: draft.refresh + 1 })}>更新筛选结果</button>}</div>
    {tools.error && <details className="unified-error"><summary>查看读取失败原因</summary><p>{tools.error}</p></details>}
    <LibraryReadingBoundary root={paneRoot} scope={`resources:${key}:${page.page}:${draft.pageSize}`} items={page.items}>
      <ul className="unified-list">{page.items.map(entry => <li key={entry.id} data-skill-id={entry.id} className="unified-row">
        <span className="unified-symbol" aria-hidden="true">{entry.owner === 'skill' ? <Box size={20} /> : <Layers3 size={20} />}</span>
        <div className="unified-name"><button type="button" onClick={() => onOpen(entry)} title={entry.name}>{entry.name}</button>{entry.description && <p title={entry.description}>{entry.description}</p>}<details data-fold-key={`resource-library:${entry.id}:source`}><summary>{entry.type} · 来源与路径</summary>{entry.originalName !== entry.name && <p>{entry.originalName}</p>}<p className="monospace">{entry.location || '未记录路径'}</p></details></div>
        <div className="unified-meta">{entry.owner === 'skill' && <CategoryChip category={categories.find(category => category.id === entry.categoryId)} color={colors.get(entry.categoryId || '')} />}<span className={`badge ${entry.tone}`} title={entry.statusDetail}>{entry.status}</span><span className="unified-version" title={entry.version || '版本尚未核实'}>{entry.version || '版本未知'}</span></div>
        <button type="button" className="button ghost" onClick={() => onOpen(entry)}>详情<ChevronRight size={15} /></button>
      </li>)}</ul>
    </LibraryReadingBoundary>
    {!page.items.length && <div className="unified-empty"><Box size={24} /><strong>{!ready || tools.loading || !tools.loaded && !tools.error ? '正在读取资源' : tools.error ? '已读取范围内没有匹配资源' : all.length ? '没有匹配的资源' : '尚未登记资源'}</strong>{(draft.query || draft.category !== 'all' || draft.attention) && <button className="button" onClick={() => patch({ query: '', category: 'all', attention: false })}>清除筛选</button>}</div>}
    <nav className="unified-pagination" aria-label="资源分页"><span>{page.total ? `${page.start}–${page.end} / ${page.total}` : '0 项'}</span><label>每页<select aria-label="全部资源每页数量" value={draft.pageSize} onChange={event => patch({ pageSize: Number(event.target.value) as 20 | 50 | 100 })}>{[20, 50, 100].map(size => <option key={size} value={size}>{size} 项</option>)}</select></label><div><button className="icon-button" type="button" aria-label="上一页资源" disabled={page.page <= 1} onClick={() => patch({ page: page.page - 1 })}><ChevronLeft size={17} /></button><span>{page.page} / {page.pageCount}</span><button className="icon-button" type="button" aria-label="下一页资源" disabled={page.page >= page.pageCount} onClick={() => patch({ page: page.page + 1 })}><ChevronRight size={17} /></button></div></nav>
  </section>;
}
