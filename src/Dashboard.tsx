import { useMemo, type ReactNode } from 'react';
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

function DashboardSection({ label, icon: Icon, title, detail, action, onAction, children }: {
  label: string;
  icon: typeof Box;
  title: string;
  detail?: string | number;
  action: string;
  onAction: () => void;
  children: ReactNode;
}) {
  return <section className="dashboard-section" aria-label={label}>
    <header>
      <h2><Icon size={17} aria-hidden="true" />{title}{detail !== undefined && <span className="dashboard-caption">{detail}</span>}</h2>
      <button type="button" className="dashboard-section-action" onClick={onAction}>{action}<ArrowRight size={14} aria-hidden="true" /></button>
    </header>
    <div className="dashboard-section-body">{children}</div>
  </section>;
}

/** Reads the same snapshots as the library and task service; this view owns no polling. */
export function Dashboard(props: Props) {
  const { skills, categories, sources, tasks, tools, ready, canAdd, onView, onSkill, onCategory, onTask, onHistory, onSources, onRetryTools, onAdd } = props;
  const attention = useMemo(() => queryLibrary(skills.filter(needsAttention), { sort: 'status' }), [skills]);
  const favorites = useMemo(() => skills.filter(skill => skill.favorite).slice(0, 4), [skills]);
  const { activeTasks, recentTasks } = useMemo(() => {
    const visible = tasks.filter(task => !task.hidden).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { activeTasks: visible.filter(task => !terminalTask(task)), recentTasks: visible.filter(terminalTask).slice(0, 5) };
  }, [tasks]);
  const colors = useMemo(() => categoryColors(categories), [categories]);
  const categoryById = useMemo(() => new Map(categories.map(category => [category.id, category])), [categories]);
  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const skill of skills) {
      const id = skill.categoryId && categoryById.has(skill.categoryId) ? skill.categoryId : 'uncategorized';
      counts.set(id, (counts.get(id) || 0) + 1);
    }
    return [...categories.map(category => ({ id: category.id, name: category.name, count: counts.get(category.id) || 0 })), { id: 'uncategorized', name: '未分类', count: counts.get('uncategorized') || 0 }];
  }, [skills, categories, categoryById]);
  const orderedSources = useMemo(() => [...sources].sort((a, b) => Number(!!b.error) - Number(!!a.error)).slice(0, 4), [sources]);
  const metrics = [
    { label: 'Skills', value: ready ? skills.length : '—', hint: ready ? '' : '正在读取', icon: Box, action: () => onView('skills'), tone: 'info' },
    { label: '工具', value: tools.loaded ? tools.resources.length : '—', hint: tools.loading ? '正在读取' : tools.error ? '读取失败' : tools.stale && tools.loaded ? '上次读取结果' : tools.loaded ? '' : '尚未读取', icon: Layers3, action: () => onView('tools'), tone: 'accent' },
    { label: '待处理 Skill', value: ready ? attention.length : '—', hint: ready ? '' : '正在读取', icon: ListTodo, action: () => onView('changes'), tone: attention.length ? 'warn' : 'neutral' },
    { label: '后台任务', value: activeTasks.length, hint: '', icon: Clock3, action: onHistory, tone: activeTasks.length ? 'accent' : 'neutral' },
  ];

  return <div className="dashboard" aria-label="资源总览">
    <div className="dashboard-metrics" role="group" aria-label="资源统计">
      {metrics.map(metric => <button type="button" className="dashboard-metric" key={metric.label} data-tone={metric.tone} onClick={metric.action}>
        <span className="dashboard-metric-label"><metric.icon size={17} aria-hidden="true" /><span>{metric.label}</span></span>
        <span className="dashboard-metric-value"><strong>{metric.value}</strong>{metric.hint && <span className="dashboard-caption">{metric.hint}</span>}</span>
        <ArrowRight className="dashboard-metric-arrow" size={15} aria-hidden="true" />
      </button>)}
    </div>

    {tools.error && <div className="dashboard-read-error">
      <span role="status">工具目录读取失败</span>
      <button type="button" onClick={onRetryTools} disabled={tools.loading}>{tools.loading ? '正在读取…' : '重试'}</button>
      <details><summary>原因</summary><p>{tools.error}</p></details>
    </div>}

    <div className="dashboard-columns">
      <DashboardSection label="需要处理" title="需要处理" icon={ListTodo} action="查看变化" onAction={() => onView('changes')}>
        {!ready ? <p className="dashboard-empty" role="status">正在读取资源…</p>
          : !skills.length ? <div className="dashboard-empty dashboard-empty-action">
            <p>尚未添加 Skill</p>
            <button type="button" className="button primary" disabled={!canAdd} onClick={onAdd}>添加本地目录</button>
          </div>
          : !attention.length ? <p className="dashboard-empty dashboard-empty-clear"><CircleCheck size={17} aria-hidden="true" />当前没有待处理的 Skill</p>
          : <ul className="dashboard-list">{attention.slice(0, 5).map(skill => {
            const group = changesGroup(skill);
            const reason = changeReason(skill);
            return <li key={skill.id}>
              <button type="button" className="dashboard-resource" onClick={() => onSkill(skill.id, 'files')}>
                <span><strong>{skill.alias || skill.displayName || skill.name}</strong><small title={reason}>{reason}</small></span>
                <span className={`badge ${group === 'problem' ? 'red' : 'amber'}`}>{group === 'problem' ? '检查异常' : group === 'changed' ? '有变化' : '待核对'}</span>
              </button>
            </li>;
          })}</ul>}
      </DashboardSection>

      <DashboardSection label="收藏资源" title="收藏" icon={Star} action="全部收藏" onAction={() => onCategory('favorites')}>
        {favorites.length ? <ul className="dashboard-favorites">{favorites.map(skill => {
          const name = skill.alias || skill.displayName || skill.name;
          return <li key={skill.id}><button type="button" onClick={() => onSkill(skill.id)}>
            <strong title={name}>{name}</strong>
            <CategoryChip category={categoryById.get(skill.categoryId || '')} color={colors.get(skill.categoryId || '')} />
          </button></li>;
        })}</ul> : <p className="dashboard-empty">{ready ? '暂无收藏' : '正在读取收藏…'}</p>}
      </DashboardSection>

      <DashboardSection label="任务进度" title="正在运行" icon={Clock3} detail={activeTasks.length} action="操作记录" onAction={onHistory}>
        {activeTasks.length ? <ul className="dashboard-list">{activeTasks.slice(0, 5).map(task => <li className="dashboard-task" key={task.id}>
          <button type="button" onClick={() => onTask(task)}><strong>{task.label}</strong><span>{taskStatus[task.status] || task.status}</span></button>
          <p>{task.cancelRequested ? '正在取消' : task.stage}</p>
          {task.progress && task.progress.total > 0 && <progress aria-label={`${task.label}进度`} max={task.progress.total} value={task.progress.completed} />}
        </li>)}</ul> : <p className="dashboard-empty">暂无后台任务</p>}
      </DashboardSection>

      <DashboardSection label="GitHub 来源状态" title="GitHub 来源" icon={Github} action="管理来源" onAction={onSources}>
        {orderedSources.length ? <ul className="dashboard-list">{orderedSources.map(source => <li key={source.id}>
          <button type="button" className="dashboard-resource" onClick={onSources}>
            <span><strong>{source.repo}</strong><small title={source.error}>{source.error ? source.error : source.lastChecked ? `最近检查 ${timeLabel(source.lastChecked)}` : '尚未检查'}</small></span>
            {source.error && <span className="badge red">检查失败</span>}
          </button>
        </li>)}</ul> : <p className="dashboard-empty">{ready ? '尚未添加 GitHub 来源' : '正在读取来源…'}</p>}
      </DashboardSection>

      <DashboardSection label="近期操作" title="近期操作" icon={Clock3} detail={recentTasks.length === 5 ? '最近 5 项' : undefined} action="全部记录" onAction={onHistory}>
        {recentTasks.length ? <ul className="dashboard-list">{recentTasks.map(task => <li key={task.id}>
          <button type="button" className="dashboard-resource" onClick={() => onTask(task)}>
            <span><strong>{task.label}</strong><small>{timeLabel(task.finishedAt || task.createdAt)}</small></span>
            <span className={`badge ${task.status === 'failed' ? 'red' : task.status === 'succeeded' ? 'green' : 'neutral'}`}>{taskStatus[task.status] || task.status}</span>
          </button>
        </li>)}</ul> : <p className="dashboard-empty">暂无已结束的操作</p>}
      </DashboardSection>

      <DashboardSection label="Skill 分类分布" title="分类" icon={Box} action="浏览 Skills" onAction={() => onCategory('all')}>
        <ul className="dashboard-categories">{groups.map(group => <li key={group.id}>
          <button type="button" data-category-color={colors.get(group.id) || 'slate'} onClick={() => onCategory(group.id)}>
            <span className="dashboard-category-title"><span>{group.name}</span><strong>{group.count}</strong></span>
            <span className="dashboard-bar" aria-hidden="true"><span style={{ width: `${skills.length ? group.count / skills.length * 100 : 0}%` }} /></span>
          </button>
        </li>)}</ul>
      </DashboardSection>
    </div>
  </div>;
}