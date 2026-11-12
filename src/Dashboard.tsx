import { useMemo } from 'react';
import { ArrowRight, Box, CircleCheck, Clock3, Github, Layers3, ListTodo, Star } from 'lucide-react';
import { changeReason, changesGroup, needsAttention, queryLibrary, type LibraryItem } from './library';
import { categoryColors, type Category } from './categories';
import { CategoryChip } from './CategoryColor';
import { taskStatus, terminalTask, type ManagerTask } from './tasks';
import type { ResourceCatalogueState } from './commands';
import './dashboard.css';

type Source = { id: string; repo: string; lastChecked?: string; error?: string };
type Props = {
  skills: readonly LibraryItem[];
  categories: readonly Category[];
  sources: readonly Source[];
  tasks: readonly ManagerTask[];
  tools: ResourceCatalogueState;
  ready: boolean;
  canAdd: boolean;
  onView: (view: 'skills' | 'tools' | 'changes' | 'clients') => void;
  onSkill: (id: string, section?: 'docs' | 'files') => void;
  onCategory: (id: string) => void;
  onTask: (task: ManagerTask) => void;
  onHistory: () => void;
  onSources: () => void;
  onRetryTools: () => void;
  onAdd: () => void;
};

function timeLabel(value?: string) {
  if (!value) return '尚未检查';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false });
}

/** Reads the same snapshots as the library and task service; this view owns no polling. */
export function Dashboard(props: Props) {
  const { skills, categories, sources, tasks, tools, ready, canAdd, onView, onSkill, onCategory, onTask, onHistory, onSources, onRetryTools, onAdd } = props;
  const attention = useMemo(() => queryLibrary(skills.filter(needsAttention), { sort: 'status' }), [skills]);
  const favorites = useMemo(() => skills.filter(skill => skill.favorite), [skills]);
  const visibleTasks = useMemo(() => tasks.filter(task => !task.hidden).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [tasks]);
  const activeTasks = visibleTasks.filter(task => !terminalTask(task));
  const recentTasks = visibleTasks.filter(terminalTask).slice(0, 5);
  const colors = useMemo(() => categoryColors(categories), [categories]);
  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    const known = new Set(categories.map(category => category.id));
    for (const skill of skills) {
      const id = skill.categoryId && known.has(skill.categoryId) ? skill.categoryId : 'uncategorized';
      counts.set(id, (counts.get(id) || 0) + 1);
    }
    return [...categories.map(category => ({ id: category.id, name: category.name, count: counts.get(category.id) || 0 })), { id: 'uncategorized', name: '未分类', count: counts.get('uncategorized') || 0 }];
  }, [skills, categories]);
  const orderedSources = useMemo(() => [...sources].sort((a, b) => Number(!!b.error) - Number(!!a.error)), [sources]);
  const metrics = [
    { label: 'Skills', value: ready ? skills.length : '—', hint: ready ? '' : '正在读取', icon: Box, action: () => onView('skills'), tone: 'info' },
    { label: '工具', value: tools.loaded ? tools.resources.length : '—', hint: tools.loading ? '正在读取' : tools.error ? '读取失败' : tools.stale && tools.loaded ? '上次读取结果' : tools.loaded ? '' : '尚未读取', icon: Layers3, action: () => onView('tools'), tone: 'accent' },
    { label: '待处理 Skill', value: ready ? attention.length : '—', hint: ready ? '' : '正在读取', icon: ListTodo, action: () => onView('changes'), tone: 'warn' },
    { label: '后台任务', value: activeTasks.length, hint: '', icon: Clock3, action: onHistory, tone: 'good' },
  ];

  return <div className="dashboard" aria-label="资源总览">
    <div className="dashboard-metrics">{metrics.map(metric => <button type="button" className="dashboard-metric" key={metric.label} data-tone={metric.tone} onClick={metric.action}>
      <span className="dashboard-metric-label"><metric.icon size={18} aria-hidden="true" />{metric.label}<ArrowRight size={15} aria-hidden="true" /></span>
      <span className="dashboard-metric-value"><strong>{metric.value}</strong>{metric.hint && <span className="dashboard-caption">{metric.hint}</span>}</span>
    </button>)}</div>
    {tools.error && <div className="dashboard-read-error" role="status"><span>工具目录读取失败</span><button type="button" onClick={onRetryTools} disabled={tools.loading}>{tools.loading ? '正在读取…' : '重试'}</button><details><summary>原因</summary><p>{tools.error}</p></details></div>}
    <div className="dashboard-columns">
      <div className="dashboard-stack">
      <section className="dashboard-section" aria-label="需要处理">
        <header><h2>需要处理</h2><button type="button" onClick={() => onView('changes')}>查看全部<ArrowRight size={15} /></button></header>
        {!ready ? <p className="dashboard-empty" role="status">正在读取资源…</p> : !skills.length ? <div className="dashboard-empty"><Box size={24} /><p>添加本地 Skill，开始管理你的资源。</p><button type="button" className="button primary" disabled={!canAdd} onClick={onAdd}>添加本地目录</button></div> : !attention.length ? <div className="dashboard-empty"><CircleCheck size={25} /><p>当前没有待处理的 Skill</p></div> : <ul className="dashboard-list">{attention.slice(0, 5).map(skill => {
          const group = changesGroup(skill);
          const reason = changeReason(skill);
          return <li key={skill.id}><button type="button" className="dashboard-resource" onClick={() => onSkill(skill.id, 'files')}><span><strong>{skill.alias || skill.displayName || skill.name}</strong><small title={reason}>{reason}</small></span><span className={`badge ${group === 'problem' ? 'red' : 'amber'}`}>{group === 'problem' ? '检查异常' : group === 'changed' ? '有变化' : '待核对'}</span><ArrowRight size={16} aria-hidden="true" /></button></li>;
        })}</ul>}
      </section>
      <section className="dashboard-section" aria-label="任务进度">
        <header><h2>正在运行 <span className="dashboard-caption">{activeTasks.length}</span></h2><button type="button" onClick={onHistory}>操作记录<ArrowRight size={15} /></button></header>
        <ul className="dashboard-list">{activeTasks.slice(0, 5).map(task => <li className="dashboard-task" key={task.id}><button type="button" onClick={() => onTask(task)}><strong>{task.label}</strong><span>{taskStatus[task.status] || task.status}</span></button><p>{task.cancelRequested ? '正在取消' : task.stage}</p>{task.progress && task.progress.total > 0 && <progress aria-label={`${task.label}进度`} max={task.progress.total} value={task.progress.completed} />}</li>)}</ul>
        {!activeTasks.length && <p className="dashboard-empty">暂无后台任务</p>}
      </section>
      <section className="dashboard-section" aria-label="近期操作">
        <header><h2>近期操作 <span className="dashboard-caption">最近5项</span></h2><button type="button" onClick={onHistory}>全部记录<ArrowRight size={15} /></button></header>
        <ul className="dashboard-list">{recentTasks.map(task => <li key={task.id}><button type="button" className="dashboard-resource" onClick={() => onTask(task)}><span><strong>{task.label}</strong><small>{timeLabel(task.finishedAt || task.createdAt)}</small></span><span className={`badge ${task.status === 'failed' ? 'red' : task.status === 'succeeded' ? 'green' : 'neutral'}`}>{taskStatus[task.status] || task.status}</span></button></li>)}</ul>
        {!recentTasks.length && <p className="dashboard-empty">暂无已结束的操作</p>}
      </section>
      </div>
      <div className="dashboard-stack">
      <section className="dashboard-section" aria-label="收藏资源">
        <header><h2><Star size={17} />收藏</h2><button type="button" onClick={() => onCategory('favorites')}>查看全部<ArrowRight size={15} /></button></header>
        <ul className="dashboard-favorites">{favorites.slice(0, 4).map(skill => <li key={skill.id}><button type="button" onClick={() => onSkill(skill.id)}><strong title={skill.alias || skill.displayName || skill.name}>{skill.alias || skill.displayName || skill.name}</strong><CategoryChip category={categories.find(category => category.id === skill.categoryId)} color={colors.get(skill.categoryId || '')} /></button></li>)}</ul>
        {!favorites.length && <p className="dashboard-empty">{ready ? '在技能库点击星标，即可从这里快速打开。' : '正在读取收藏…'}</p>}
      </section>
      <section className="dashboard-section" aria-label="GitHub 来源状态">
        <header><h2><Github size={17} />GitHub 来源</h2><button type="button" onClick={onSources}>管理来源<ArrowRight size={15} /></button></header>
        <ul className="dashboard-list">{orderedSources.slice(0, 4).map(source => <li key={source.id}><button type="button" className="dashboard-resource" onClick={onSources}><span><strong>{source.repo}</strong><small title={source.error}>{source.error ? source.error : source.lastChecked ? `最近检查 ${timeLabel(source.lastChecked)}` : '尚未检查'}</small></span>{source.error && <span className="badge red">检查失败</span>}</button></li>)}</ul>
        {!sources.length && <p className="dashboard-empty">{ready ? '尚未添加 GitHub 来源' : '正在读取来源…'}</p>}
      </section>
      <section className="dashboard-section" aria-label="Skill 分类分布">
        <header><h2>分类</h2><button type="button" onClick={() => onCategory('all')}>浏览 Skills<ArrowRight size={15} /></button></header>
        <ul className="dashboard-categories">{groups.map(group => <li key={group.id}><button type="button" data-category-color={colors.get(group.id) || 'slate'} onClick={() => onCategory(group.id)}><span className="dashboard-category-title"><span>{group.name}</span><strong>{group.count}</strong></span><span className="dashboard-bar" aria-hidden="true"><span style={{ width: `${skills.length ? group.count / skills.length * 100 : 0}%` }} /></span></button></li>)}</ul>
      </section>
      </div>
    </div>
  </div>;
}
