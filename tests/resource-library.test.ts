import test from 'node:test';
import assert from 'node:assert/strict';
import { queryResourceLibrary, resourceLibraryDraft, resourceLibraryEntries } from '../src/resource-library.ts';
import type { Resource } from '../src/resources.ts';

const skill = { id: 'same', name: 'Reader', alias: '论文助手', notes: '定理核查', localPath: 'D:/synthetic/skill', categoryId: 'research', favorite: true, status: 'local_only' };
const tool: Resource = { id: 'same', name: 'Reader', alias: '网页阅读', notes: '网页内容', rootPath: 'D:/synthetic/tool', kind: 'mcp', enabled: true, ownership: 'external', managementScope: 'register', revision: 1, createdAt: '', updatedAt: '', actions: [], capabilities: [] };

test('same names and backend IDs keep their original distinct owners', () => {
  const entries = resourceLibraryEntries([skill], [tool]);
  assert.deepEqual(new Set(entries.map(entry => entry.id)), new Set(['skill:same', 'tool:same']));
  assert.equal(entries.find(entry => entry.owner === 'skill')!.location, skill.localPath);
  assert.equal(entries.find(entry => entry.owner === 'tool')!.resourceId, tool.id);
  assert.equal(resourceLibraryEntries([skill], [{ ...tool, kind: 'skill' }]).length, 2, 'registration kind must not merge records by name');
});

test('unified query retains aliases, notes and original paths across type filters', () => {
  assert.deepEqual(queryResourceLibrary([skill], [tool], { ...resourceLibraryDraft(), query: '定理' }).map(entry => entry.id), ['skill:same']);
  assert.deepEqual(queryResourceLibrary([skill], [tool], { ...resourceLibraryDraft(), query: 'synthetic/tool' }).map(entry => entry.id), ['tool:same']);
  assert.equal(queryResourceLibrary([skill], [tool], { ...resourceLibraryDraft(), kind: 'skills' }).length, 1);
  assert.equal(queryResourceLibrary([skill], [tool], { ...resourceLibraryDraft(), kind: 'tools' }).length, 1);
  assert.equal(queryResourceLibrary([skill], [tool], resourceLibraryDraft()).length, 2);
});

test('Skill categories narrow all resources but do not erase the tools filter state', () => {
  const selected = { ...resourceLibraryDraft(), category: 'research' };
  assert.deepEqual(queryResourceLibrary([skill], [tool], selected).map(entry => entry.id), ['skill:same']);
  assert.deepEqual(queryResourceLibrary([skill], [tool], { ...selected, kind: 'tools' }).map(entry => entry.id), ['tool:same']);
  assert.deepEqual(queryResourceLibrary([skill], [tool], { ...selected, category: 'favorites' }).map(entry => entry.id), ['skill:same']);
});

test('capability declarations do not imply verified availability or an actionable failure', () => {
  const unknown = { ...tool, capabilities: [{ id: 'read', label: '读取', status: 'unverified' }] };
  const failed = { ...tool, capabilities: [{ id: 'read', label: '读取', status: 'failed', reason: '连接失败' }] };
  const options = { ...resourceLibraryDraft(), attention: true };
  assert.equal(queryResourceLibrary([skill], [unknown], options).length, 0);
  assert.equal(queryResourceLibrary([skill], [failed], options)[0].statusDetail, '连接失败');
  assert.equal(queryResourceLibrary([skill], [{ ...failed, enabled: false }], options).length, 0);
  assert.equal(resourceLibraryEntries([], [unknown])[0].status, '已登记');
});

test('navigation draft validates page sizes and keeps independent reading IDs', () => {
  const reading = { key: 'saved', ids: ['skill:same', 'tool:same'] };
  const draft = resourceLibraryDraft({ page: -4, pageSize: 99 as 20, reading });
  assert.equal(draft.page, 1);
  assert.equal(draft.pageSize, 20);
  assert.notEqual(draft.reading!.ids, reading.ids);
});
