import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommands, commandShortcut, queryCommands, ResourceCommandCatalogue } from '../src/commands.ts';
import type { Resource } from '../src/resources.ts';

const tool = (id: string, revision = 1): Resource => ({ id, name: 'Agent Reach', alias: '阅读助手', notes: '只读平台内容', kind: 'cli', rootPath: `D:/synthetic/${id}`, enabled: true, ownership: 'external', revision, managementScope: 'register', actions: [], capabilities: [{ name: 'YouTube', label: '字幕读取' }], createdAt: '', updatedAt: '' });
const registeredAction: Resource['actions'][number] = { id: 'find-videos', label: '搜索视频', mode: 'task', executable: 'bin/read.exe', workingDirectory: '.', args: [{ type: 'literal', value: 'search' }, { type: 'parameter', name: 'query' }], parameters: [{ name: 'query', label: '关键词', kind: 'text', required: true }] };

test('personal skill names and notes remain discoverable with the original identity', () => {
  const skill = { id: 'stable-id', name: 'original-skill', displayName: 'Original Display', alias: '阅读助手', notes: 'Hopf proof checking' };
  const commands = buildCommands([skill], []);
  for (const query of ['阅读助手 proof', 'original-skill', 'Original Display']) {
    const matches = queryCommands(commands, query);
    assert.equal(matches[0].label, '阅读助手');
    assert.deepEqual(matches[0].target, { kind: 'skill', id: 'stable-id', section: 'docs' });
    assert.equal(matches.length, 2);
  }
  assert.equal(skill.name, 'original-skill');
});

test('search matches resource names, aliases and explicit capability labels without declaring execution readiness', () => {
  const commands = buildCommands([{ id: 'skill', name: 'paper-read', displayName: '论文阅读', description: '动力系统文献' }], [tool('reach')]);
  assert.equal(queryCommands(commands, '阅读助手 字幕')[0].id, 'tool:reach');
  assert.equal(queryCommands(commands, 'Agent YouTube')[0].id, 'tool:reach');
  assert.equal(queryCommands(commands, '动力 文件')[0].id, 'skill:skill:files');
  assert.equal(queryCommands(commands, '主题 动效')[0].id, 'settings:display');
  assert(!commands.some(command => /运行成功|运行正常|已验证/.test(command.detail)));
  assert(commands.every(command => ['view', 'settings', 'skill', 'tool', 'history'].includes(command.target.kind)));
  assert.equal(queryCommands(commands, '不存在').length, 0);
});

test('matching preserves stable order while prioritizing exact and prefix labels', () => {
  const commands = buildCommands([{ id: 'first', name: 'read', description: 'read' }, { id: 'second', name: 'reader' }], []);
  assert.equal(queryCommands(commands, 'read')[0].id, 'skill:first:docs');
  assert.deepEqual(queryCommands(commands, ''), commands);
  assert.deepEqual(queryCommands(commands, 'READ'), queryCommands(commands, 'read'));
});

test('only registered actions become entries, identified by resource, action and revision without executable payloads', () => {
  const commands = buildCommands([], [
    { ...tool('reach', 4), actions: [registeredAction, { ...registeredAction, id: 'serve', label: '启动服务', mode: 'service' }] },
    { ...tool('other', 2), alias: '另一工具', actions: [registeredAction] },
  ]);
  const actions = commands.filter(command => command.target.kind === 'resource-action');
  assert.equal(actions.length, 3);
  assert.equal(new Set(actions.map(command => command.id)).size, 3);
  assert.deepEqual(queryCommands(commands, '搜索视频 阅读助手')[0].target, { kind: 'resource-action', id: 'reach', actionId: 'find-videos', expectedRevision: 4 });
  assert.equal(queryCommands(commands, 'find-videos Agent')[0].id, 'action:reach:find-videos');
  assert.match(queryCommands(commands, '启动服务 阅读助手')[0].detail, /服务动作.*核对后执行/);
  assert(actions.every(command => !command.disabledReason));
  assert(!JSON.stringify(actions).includes('bin/read.exe'));
  assert(!JSON.stringify(actions).includes('workingDirectory'));
  assert(queryCommands(commands, 'YouTube 字幕').every(command => command.target.kind === 'tool'));
  assert.equal(queryCommands(commands, 'powershell -Command').length, 0);
});

test('stopped and read-only actions stay searchable with a reason while ordinary navigation remains available', () => {
  const resource = { ...tool('reach'), enabled: false, actions: [registeredAction] };
  const stopped = buildCommands([], [resource]);
  assert.match(queryCommands(stopped, '搜索视频')[0].disabledReason || '', /已停用/);
  assert.equal(stopped.find(command => command.id === 'tool:reach')?.disabledReason, undefined);
  const readOnly = buildCommands([], [{ ...resource, enabled: true }], { readOnly: true });
  assert.match(queryCommands(readOnly, '搜索视频')[0].disabledReason || '', /基本模式/);
  assert(readOnly.filter(command => command.target.kind !== 'resource-action').every(command => !command.disabledReason));
  const changed = buildCommands([], [{ ...resource, enabled: true, revision: 2, actions: [] }]);
  assert.equal(queryCommands(changed, '搜索视频').length, 0);
});

test('only exact Ctrl+K handles the global shortcut; editing shortcuts and IME remain native', () => {
  const key = { key: 'k', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 75, defaultPrevented: false, repeat: false };
  assert(commandShortcut(key));
  for (const patch of [{ key: 'a' }, { key: 'z' }, { key: 'c' }, { altKey: true }, { shiftKey: true }, { metaKey: true }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { repeat: true }]) assert(!commandShortcut({ ...key, ...patch }));
});

test('scene eligibility limits future actions without hiding inventory or overriding manual disable', () => {
  const resource = { ...tool('reach'), actions: [registeredAction], sceneEligible: false, sceneReason: '当前场景不包含此工具' };
  const commands = buildCommands([], [resource]);
  assert.match(commands.find(command => command.target.kind === 'resource-action')?.disabledReason || '', /当前场景/);
  assert.equal(commands.find(command => command.id === 'tool:reach')?.disabledReason, undefined);
  const disabled = buildCommands([], [{ ...resource, enabled: false }]);
  assert.match(disabled.find(command => command.target.kind === 'resource-action')?.disabledReason || '', /已停用/);
  assert.equal(resource.enabled, true);
});

test('pane catalogue coalesces simultaneous reads, reports failure and retains usable cached data', async () => {
  const cache = new ResourceCommandCatalogue();
  let finish!: (result: { resources: Resource[] }) => void, calls = 0;
  const load = () => { calls++; return new Promise<{ resources: Resource[] }>(resolve => { finish = resolve; }); };
  const one = cache.read(load), two = cache.read(load);
  assert.equal(one, two); await Promise.resolve(); assert.equal(calls, 1);
  finish({ resources: [tool('reach')] }); await one;
  assert.equal(cache.getSnapshot().loaded, true); assert.equal(cache.getSnapshot().stale, false);
  cache.invalidate(4); assert(cache.getSnapshot().stale);
  await assert.rejects(cache.read(async () => { throw new Error('离线'); }), /离线/);
  assert.equal(cache.getSnapshot().resources[0].id, 'reach'); assert.match(cache.getSnapshot().error, /离线/);
  assert.equal(cache.getSnapshot().loading, false);
});

test('a stale list response cannot overwrite a more recent resource mutation', async () => {
  const cache = new ResourceCommandCatalogue();
  await cache.read(async () => ({ resources: [tool('reach')] }));
  let finish!: (result: { resources: Resource[] }) => void;
  const read = cache.read(() => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  cache.accept({ ...tool('reach', 2), alias: '新别名' });
  finish({ resources: [tool('reach')] });
  const result = await read;
  assert.equal(result.resources[0].alias, '新别名'); assert.equal(cache.getSnapshot().stale, true);
  await cache.read(async () => ({ resources: [tool('reach', 3)] }));
  cache.invalidate(10); await cache.read(async () => ({ resources: [tool('reach', 3)] }));
  cache.invalidate(9); assert.equal(cache.getSnapshot().stale, false);
});

test('first list completion merges concurrent writes and retains unrelated records from the complete list', async () => {
  const cache = new ResourceCommandCatalogue();
  let finish!: (result: { resources: Resource[] }) => void;
  const read = cache.read(() => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  cache.accept({ ...tool('reach', 2), alias: '本地新别名' });
  cache.accept(tool('registered-during-read'));
  finish({ resources: [tool('reach'), tool('existing-tool')] });
  const result = await read;
  assert.deepEqual(result.resources.map(resource => resource.id), ['reach', 'existing-tool', 'registered-during-read']);
  assert.equal(result.resources[0].alias, '本地新别名');
  assert.equal(cache.getSnapshot().loaded, true);
  assert.equal(cache.getSnapshot().stale, true);
  assert.equal(cache.getSnapshot().loading, false);
});

test('a newer revision in the list wins over an older concurrent write response', async () => {
  const cache = new ResourceCommandCatalogue();
  let finish!: (result: { resources: Resource[] }) => void;
  const read = cache.read(() => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  cache.accept({ ...tool('reach', 2), alias: '修订2' });
  finish({ resources: [{ ...tool('reach', 3), alias: '修订3' }, tool('existing-tool')] });
  const result = await read;
  assert.deepEqual(result.resources.map(resource => resource.id), ['reach', 'existing-tool']);
  assert.equal(result.resources[0].alias, '修订3');
  cache.accept({ ...tool('reach', 1), alias: '迟到的修订1' });
  assert.equal(cache.getSnapshot().resources[0].alias, '修订3');
});
