import type { ManagerTask } from './tasks';

export type ProblemCause = { code: string; label: string; next: string };
export function problemCause(task: Pick<ManagerTask, 'status' | 'error'>): ProblemCause {
  const text = task.error || '';
  if (/429|rate.?limit|限流|请求过于频繁/i.test(text)) return { code: 'rate_limit', label: '请求受到限流', next: '等待限制解除后再检查，不连续重试。' };
  if (/401|403|unauthori[sz]ed|forbidden|credential|权限|凭据|登录/i.test(text)) return { code: 'access', label: '访问或登录需要核对', next: '返回对应界面核对权限；登录和验证码由本人完成。' };
  if (/timeout|timed out|network|connect|DNS|TLS|超时|网络|连接失败/i.test(text)) return { code: 'network', label: '网络连接未完成', next: '在网络设置检查连接，恢复后再重试原操作。' };
  if (/revision|stale|conflict|修订|已变化|发生变化|冲突|过期/i.test(text)) return { code: 'changed', label: '信息已变化', next: '重新读取当前内容并核对差异，再决定是否继续。' };
  if (/404|not found|missing|不存在|找不到|缺失/i.test(text)) return { code: 'missing', label: '位置或来源暂不可用', next: '核对原位置或来源；不可访问不代表已删除。' };
  if (/暂停|维护窗口|maintenance/i.test(text)) return { code: 'maintenance', label: '维护暂缓', next: '检查维护暂停和时间窗口，恢复后重新核对任务。' };
  if (task.status === 'interrupted') return { code: 'interrupted', label: '上次任务中断', next: '先核对当前结果，避免重复提交已完成的部分。' };
  if (task.status === 'partial') return { code: 'partial', label: '操作部分完成', next: '查看各项结果，核对保留内容后再处理未完成部分。' };
  return { code: 'other', label: '操作需要检查', next: '查看该项记录中的具体原因，再返回对应界面处理。' };
}
export type ProblemGroup = { key: string; sourceId?: string; cause: ProblemCause; tasks: ManagerTask[] };
export type FeedbackNotice = { id: number; tone: 'success' | 'error' | 'info'; message: string; skillId?: string; scope?: string; count?: number; baseMessage?: string };
export function appendProblemNotice(previous: readonly FeedbackNotice[], incoming: FeedbackNotice): FeedbackNotice[] {
  const cause = problemCause({ status: 'failed', error: incoming.message });
  const duplicate = incoming.tone === 'error' ? previous.find(item => item.tone === 'error' && (
    incoming.scope && cause.code !== 'other' ? item.scope === incoming.scope && problemCause({ status: 'failed', error: item.baseMessage || item.message }).code === cause.code
      : item.skillId === incoming.skillId && (item.baseMessage || item.message) === incoming.message
  )) : undefined;
  const count = (duplicate?.count || (duplicate ? 1 : 0)) + 1;
  const item = { ...incoming, count, baseMessage: incoming.message, message: incoming.tone === 'error' ? `${incoming.message}${count > 1 ? `（同类提示 ${count} 次，逐项记录仍保留）` : ''} ${cause.next}` : incoming.message };
  const all = [item, ...previous.filter(old => old !== duplicate)];
  return [...all.filter(value => value.tone === 'error'), ...all.filter(value => value.tone !== 'error')].slice(0, 100);
}
export function problemGroups(tasks: readonly ManagerTask[], sourceBySkill: Readonly<Record<string, string>> = {}): ProblemGroup[] {
  const groups = new Map<string, ProblemGroup>();
  for (const task of tasks) {
    if (task.hidden || !['failed', 'partial', 'interrupted'].includes(task.status)) continue;
    const sourceId = task.origin.sourceId || (task.origin.skillId ? sourceBySkill[task.origin.skillId] : undefined);
    const identity = sourceId ? ['source', sourceId] : task.origin.resourceId ? ['tool', task.origin.resourceId] : task.origin.skillId ? ['skill', task.origin.skillId] : task.origin.clientId ? ['client', task.origin.clientId] : ['task', task.id];
    const cause = problemCause(task), key = JSON.stringify([...identity, cause.code]);
    const group = groups.get(key) || { key, sourceId, cause, tasks: [] };
    group.tasks.push(task); groups.set(key, group);
  }
  return [...groups.values()];
}

function stage(task: ManagerTask): string {
  if (task.status === 'queued') return '等待执行';
  if (task.status === 'succeeded') return '完成';
  if (/下载|download/i.test(task.stage)) return '下载';
  if (/保存|提交|写入/i.test(task.stage)) return '保存或提交';
  if (/读取|检查|核对/i.test(task.stage)) return '读取或核对';
  if (/预览|确认/i.test(task.stage)) return '预览或确认';
  return ({ running: '执行中', partial: '部分完成', failed: '未完成', cancelled: '取消', interrupted: '中断' } as Record<string, string>)[task.status] || '未分类';
}
const percentile = (values: number[], ratio: number) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * ratio) - 1] : null;

/** Only explicit non-sensitive fields enter the copyable text. Never export
 * free-form errors/stages/labels, paths, repositories, settings or task results. */
export function diagnosticSummary({ version, basicMode, tasks, skillCount, sourceErrors, generatedAt }: {
  version: string; basicMode: boolean; tasks: readonly ManagerTask[]; skillCount: number; sourceErrors: number; generatedAt: string;
}): string {
  const visible = tasks.filter(task => !task.hidden), issues = visible.filter(task => ['failed', 'partial', 'interrupted'].includes(task.status));
  const elapsed = visible.flatMap(task => {
    const end = Date.parse(task.finishedAt || ''), start = Date.parse(task.startedAt || '');
    return Number.isFinite(end) && Number.isFinite(start) && end >= start ? [end - start] : [];
  });
  const safeVersion = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version) ? version : '未核实';
  const lines = [
    'Agent 资源管理器 · 诊断摘要', `生成时间：${generatedAt}`, `程序自报版本：${safeVersion}`, `运行模式：${basicMode ? '基本模式（只读）' : '普通模式'}`,
    `已登记 Skill：${skillCount}；来源异常：${sourceErrors}`,
    `保留任务：${visible.length}；进行中：${visible.filter(task => ['queued', 'running'].includes(task.status)).length}；需核对：${issues.length}`,
    `有完整起止时间的任务：${elapsed.length}；任务耗时中位数：${percentile(elapsed, .5) ?? '未记录'} ms；P95：${percentile(elapsed, .95) ?? '未记录'} ms`,
    '任务耗时包含处理和等待外部服务，不代表启动速度或界面响应。原生界面性能：此摘要未采样。',
    '问题类别与记录阶段：',
    ...issues.map((task, index) => `  ${index + 1}. ${problemCause(task).label}；阶段：${stage(task)}；${problemCause(task).next}`),
    ...(issues.length ? [] : ['  当前保留记录没有失败、部分完成或中断项。']),
    '摘要不包含账号、凭据、仓库名、路径、原始错误、调用参数或文件内容；仅复制到本机剪贴板，不上传。',
  ];
  return lines.join('\n');
}
