import test from 'node:test';
import assert from 'node:assert/strict';
import { appendProblemNotice, diagnosticSummary, problemCause, problemGroups } from '../src/operation-problems.ts';
import type { ManagerTask } from '../src/tasks.ts';
const task = (id: string, extra: Partial<ManagerTask> = {}): ManagerTask => ({ id, action: 'check_now', label: id, status: 'failed', stage: '读取来源', createdAt: '2026-10-30T00:00:00Z', origin: {}, cancellable: false, error: 'HTTP 429', ...extra });

test('common-source causes group without conflating unrelated identities or deleting original records', () => {
  const tasks = [task('a', { origin: { skillId: 'one' } }), task('b', { origin: { skillId: 'two' } }), task('c', { origin: { sourceId: 'another' } }), task('d', { origin: { sourceId: 'source' }, error: 'HTTP 401' })];
  const before = JSON.stringify(tasks), groups = problemGroups(tasks, { one: 'source', two: 'source' });
  assert.deepEqual(groups.map(group => group.tasks.map(item => item.id)), [['a', 'b'], ['c'], ['d']]);
  assert.equal(groups[0].cause.code, 'rate_limit'); assert.equal(groups[2].cause.code, 'access');
  assert.equal(JSON.stringify(tasks), before);
  assert.equal(problemGroups([task('unattributed-one'), task('unattributed-two')]).length, 2);
  assert.equal(problemGroups([task('a', { origin: { resourceId: 'one' } }), task('b', { origin: { resourceId: 'one' } })]).length, 1);
});

test('successful later work never silently hides failed partial or interrupted records', () => {
  const tasks = [task('a', { status: 'partial' }), task('b', { status: 'interrupted' }), task('c', { status: 'succeeded' }), task('d', { status: 'failed', hidden: true })];
  assert.deepEqual(problemGroups(tasks).flatMap(group => group.tasks.map(item => item.id)), ['a', 'b']);
  for (const [error, code] of [['HTTP 403', 'access'], ['network timeout', 'network'], ['修订号已变化', 'changed'], ['路径不存在', 'missing'], ['维护暂停', 'maintenance']]) assert.equal(problemCause({ status: 'failed', error }).code, code);
  assert.equal(problemCause({ status: 'partial' }).code, 'partial');
  assert.equal(problemCause({ status: 'interrupted' }).code, 'interrupted');
});

test('diagnostic text excludes all free-form user and credential fields while retaining useful classifications', () => {
  const value = task('SECRET-ID', { label: 'SECRET-LABEL', stage: '下载 D:/private/SECRET-FILE', error: 'HTTP 401 https://user:SECRET-PASSWORD@example.test?token=SECRET-TOKEN', origin: { sourceId: 'SECRET-REPO', skillId: 'SECRET-SKILL' }, result: { token: 'SECRET-RESULT', path: 'D:/private/SECRET-RESULT' } });
  const summary = diagnosticSummary({ version: '0.2.11', basicMode: true, tasks: [value], skillCount: 4, sourceErrors: 1, generatedAt: '2026-10-30T01:00:00Z' });
  assert(!summary.includes('SECRET')); assert(!summary.includes('D:/')); assert(!summary.includes('example.test'));
  assert(summary.includes('基本模式')); assert(summary.includes('访问或登录需要核对')); assert(summary.includes('阶段：下载'));
  assert(summary.includes('原生界面性能：此摘要未采样')); assert(!summary.includes('任务耗时中位数：0'));
});

test('task timing uses valid observed spans only and does not claim UI performance', () => {
  const tasks = [100, 200, 300, 400].map((milliseconds, index) => task(String(index), { status: 'succeeded', startedAt: '2026-10-30T00:00:00Z', finishedAt: new Date(Date.parse('2026-10-30T00:00:00Z') + milliseconds).toISOString() }));
  tasks.push(task('invalid', { startedAt: 'not-a-date', finishedAt: '2026-10-30T00:00:00Z' }));
  const summary = diagnosticSummary({ version: '0.2.11', basicMode: false, tasks, skillCount: 0, sourceErrors: 0, generatedAt: 'now' });
  assert(summary.includes('完整起止时间的任务：4')); assert(summary.includes('中位数：200 ms；P95：400 ms'));
  assert(summary.includes('不代表启动速度或界面响应'));
});

test('duplicate feedback coalesces by known source and cause while important errors remain visible', () => {
  let notices = appendProblemNotice([], { id: 1, tone: 'error', message: '项目一 HTTP 429', skillId: 'one', scope: 'source:shared' });
  notices = appendProblemNotice(notices, { id: 2, tone: 'error', message: '项目二 HTTP 429', skillId: 'two', scope: 'source:shared' });
  assert.equal(notices.length, 1); assert.equal(notices[0].count, 2); assert(notices[0].message.includes('逐项记录仍保留'));
  assert(notices[0].message.includes('等待限制解除'));
  notices = appendProblemNotice(notices, { id: 3, tone: 'success', message: '另一操作成功' });
  assert.equal(notices[0].tone, 'error'); assert.equal(notices[1].tone, 'success');
  notices = appendProblemNotice(notices, { id: 4, tone: 'error', message: 'HTTP 429', scope: 'source:other' });
  assert.equal(notices.filter(item => item.tone === 'error').length, 2);
  let unknown = appendProblemNotice([], { id: 5, tone: 'error', message: '未知问题甲', skillId: 'one' });
  unknown = appendProblemNotice(unknown, { id: 6, tone: 'error', message: '未知问题乙', skillId: 'one' });
  assert.equal(unknown.length, 2);
  unknown = appendProblemNotice(unknown, { id: 7, tone: 'error', message: '未知问题乙', skillId: 'one' });
  assert.equal(unknown.length, 2); assert.equal(unknown[0].count, 2);
});
