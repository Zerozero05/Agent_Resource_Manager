import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeResourceRuns, preserveResourceOrder, queryResources, repositoryHref, type Resource, type ResourceRun } from '../src/resources.ts';
const item = (id: string, extra: Partial<Resource> = {}): Resource => ({ id, name: id, kind: 'cli', rootPath: `D:\\tools\\${id}`, repository: null, version: null, alias: '', notes: '', enabled: true, ownership: 'external', revision: 1, managementScope: 'register', actions: [], capabilities: [], createdAt: '', updatedAt: '', ...extra });
test('resource search uses alias, purpose and source together without changing identities', () => {
  const data = [item('reader', { alias: '字幕助手', notes: '提取中文字幕', repository: 'https://github.com/example/video' }), item('browser', { kind: 'mcp' })];
  assert.deepEqual(queryResources(data, '字幕 example', '').map(row => row.id), ['reader']);
  assert.deepEqual(queryResources(data, '', 'mcp').map(row => row.id), ['browser']);
  assert.equal(data[0].name, 'reader');
});
test('refresh updates metadata in place, removes absent IDs and appends new IDs', () => {
  const previous = [item('a'), item('b'), item('removed')];
  const result = preserveResourceOrder(previous, [item('c'), item('b', { revision: 2, alias: 'changed' }), item('a')]);
  assert.deepEqual(result.map(row => row.id), ['a', 'b', 'c']);
  assert.equal(result[1].alias, 'changed');
  assert.equal(previous[1].revision, 1);
});
test('repository links never open executable schemes or credential-bearing URLs', () => {
  assert.equal(repositoryHref('https://github.com/example/tool'), 'https://github.com/example/tool');
  for (const value of ['javascript:alert(1)', 'file:///D:/tool.exe', 'https://github.com.evil.test/tool', 'https://secret@github.com/a/b', 'http://github.com/a/b', '', undefined]) assert.equal(repositoryHref(value), null);
});
test('active services survive history limits and delayed start responses never replace terminal states', () => {
  const run = (id: string, status: string, startedAt: string): ResourceRun => ({ runId: id, resourceId: 'tool', actionId: 'read', pid: 123, mode: 'service', status, startedAt });
  const service = run('long-lived', 'running', '2026-10-01T00:00:00Z');
  const history = Array.from({ length: 40 }, (_, index) => run(`done-${index}`, 'succeeded', `2026-10-28T00:00:${String(index).padStart(2, '0')}Z`));
  const result = mergeResourceRuns([service], history);
  assert.equal(result.length, 31); assert.equal(result[0].runId, 'long-lived');
  const stopped = { ...service, status: 'stopped', finishedAt: '2026-10-28T12:00:00Z' };
  assert.equal(mergeResourceRuns([stopped], [service])[0].status, 'stopped');
});
