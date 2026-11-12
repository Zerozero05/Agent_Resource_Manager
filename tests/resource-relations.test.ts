import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import type { RelationEndpoint, RelationSummary, ResourceRelation, ResourceRelationsSnapshot } from '../src/ResourceRelations.tsx';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const file = new URL('../src/ResourceRelations.tsx', import.meta.url);
let code = ts.transpileModule(await readFile(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText.replace(/import\s+['"][^'"]+\.css['"];?/g, '');
code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, specifier: string) => `from ${JSON.stringify(import.meta.resolve(specifier))}`);
const { ResourceRelations } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const host = document.getElementById('root')!;
let unmount = () => {};
afterEach(async () => { await act(async () => unmount()); unmount = () => {}; });
const summary = (kind: RelationEndpoint['kind'], id: string, name: string, extra: Partial<RelationSummary> = {}): RelationSummary => ({ kind, id, name, exists: true, ownership: 'external', shared: false, ...extra });
const owner = () => summary('tool', 'one', '当前工具');
const existing = () => summary('tool', 'runtime', '运行依赖', { ownership: 'managed', shared: true });
const candidate = () => summary('skill', 'one', '可添加 Skill', { ownership: 'unknown' });
const dependent = () => summary('skill', 'consumer', '使用者 Skill');
const edge = (id: string, dependent: RelationSummary, dependency: RelationSummary): ResourceRelation => ({ id, dependent, dependency, createdAt: '2026-10-30T00:00:00Z' });
const snapshot = (revision = 7): ResourceRelationsSnapshot => ({ revision, endpoint: owner(), dependencies: [edge('existing-edge', owner(), existing())], dependents: [edge('consumer-edge', dependent(), owner())], candidates: [owner(), existing(), candidate(), summary('tool', 'missing', '不可添加', { exists: false })] });
const key = (endpoint: RelationEndpoint) => JSON.stringify([endpoint.kind, endpoint.id]);
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label)!;
async function click(label: string) { assert(button(label), `Missing button ${label}`); await act(async () => button(label).click()); }
async function select(endpoint = candidate()) { await act(async () => { const target = host.querySelector<HTMLSelectElement>('[aria-label="选择依赖资源"]')!; target.value = key(endpoint); target.dispatchEvent(new dom.window.Event('change', { bubbles: true })); }); }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(handler?: (command: string, args: any) => Promise<ResourceRelationsSnapshot>) {
  const calls: { command: string; args: any }[] = [], root = createRoot(host); unmount = () => root.unmount();
  const action = async (_label: string, command: string, args: any) => {
    calls.push({ command, args }); return handler ? handler(command, args) : snapshot();
  };
  return { calls, render: async (props = {}) => act(async () => root.render(createElement(ResourceRelations, { endpoint: { kind: 'tool', id: 'one' }, action, revision: 100, ...props }))) };
}

test('collapsed relations have no I/O, expansion reads once and labels reflect actual ownership and shared flags', async () => {
  const f = fixture(); await f.render(); await f.render({ revision: 101 }); assert.equal(f.calls.length, 0);
  assert.equal(button('依赖关系').getAttribute('aria-expanded'), 'false'); await click('依赖关系');
  assert.deepEqual(f.calls, [{ command: 'resource_relations', args: { endpoint: { kind: 'tool', id: 'one' } } }]);
  assert(host.querySelector('[aria-label="依赖什么"]')!.textContent!.includes('运行依赖')); assert(host.querySelector('[aria-label="被谁使用"]')!.textContent!.includes('使用者 Skill'));
  assert(host.textContent!.includes('外部资源')); assert(host.textContent!.includes('有安装归属记录')); assert(!host.textContent!.includes('外部安装')); assert.equal(host.querySelectorAll('.relation-shared').length, 1);
  assert(host.textContent!.includes('不改动文件，也不授予删除权限')); await f.render({ revision: 101 }); assert.equal(f.calls.length, 1);
});

test('add accepts Skill/tool identities, excludes unavailable/current/existing targets, and uses relation CAS rather than state revision', async () => {
  const f = fixture(async (command, args) => command === 'resource_relations' ? snapshot() : { ...snapshot(8), dependencies: [...snapshot().dependencies, edge('new-edge', owner(), candidate())] });
  await f.render(); await click('依赖关系');
  const options = [...host.querySelectorAll<HTMLOptionElement>('select option')]; assert.deepEqual(options.map(option => option.value), ['', key(candidate())]);
  await select(); await click('添加关系');
  assert.deepEqual(f.calls.at(-1), { command: 'resource_relation_add', args: { dependent: { kind: 'tool', id: 'one' }, dependency: { kind: 'skill', id: 'one' }, expectedRevision: 7 } });
  assert(host.querySelector('[aria-label="依赖什么"]')!.textContent!.includes('可添加 Skill')); assert(host.textContent!.includes('归属未知')); assert.equal(host.querySelector<HTMLSelectElement>('select')!.value, '');
});

test('outgoing stale references can be removed with the current relation revision', async () => {
  const missing = snapshot(); missing.dependencies[0].dependency = { ...existing(), exists: false };
  const f = fixture(async command => command === 'resource_relations' ? missing : { ...snapshot(8), dependencies: [] });
  await f.render(); await click('依赖关系'); assert(host.querySelector('[aria-label="依赖什么"]')!.textContent!.includes('失效引用'));
  await click('移除关系');
  assert.deepEqual(f.calls.at(-1), { command: 'resource_relation_remove', args: { id: 'existing-edge', expectedRevision: 7 } });
  assert(host.querySelector('[aria-label="依赖什么"]')!.textContent!.includes('尚未记录依赖'));
});

test('removing a forgotten incoming dependent keeps the current page stable and rereads it exactly once', async () => {
  const forgotten = { ...dependent(), exists: false }, initial = { ...snapshot(), dependents: [edge('consumer-edge', forgotten, owner())] };
  const refreshed = deferred<ResourceRelationsSnapshot>(); let reads = 0;
  const f = fixture(async command => command === 'resource_relations'
    ? (++reads === 1 ? initial : refreshed.promise)
    : { ...snapshot(8), endpoint: forgotten, dependencies: [], dependents: [] });
  await f.render(); await click('依赖关系'); await select();
  assert(host.querySelector('[aria-label="被谁使用"]')!.textContent!.includes('失效引用'));
  assert.equal(button('移除来自使用者 Skill的管理关系').textContent, '移除关系');
  await click('移除来自使用者 Skill的管理关系');
  assert.deepEqual(f.calls, [
    { command: 'resource_relations', args: { endpoint: { kind: 'tool', id: 'one' } } },
    { command: 'resource_relation_remove', args: { id: 'consumer-edge', expectedRevision: 7 } },
    { command: 'resource_relations', args: { endpoint: { kind: 'tool', id: 'one' } } },
  ]);
  assert.equal(host.querySelector('.relation-endpoint strong')!.textContent, '当前工具');
  assert(host.querySelector('[aria-label="依赖什么"]')!.textContent!.includes('运行依赖'));
  assert.equal(host.querySelector<HTMLSelectElement>('select')!.value, key(candidate()));
  assert.equal(button('移除来自使用者 Skill的管理关系').disabled, true);
  await act(async () => refreshed.resolve({ ...snapshot(8), dependents: [] }));
  assert.equal(host.querySelector('.relation-endpoint strong')!.textContent, '当前工具');
  assert(host.querySelector('[aria-label="被谁使用"]')!.textContent!.includes('尚未记录使用者'));
  assert.equal(reads, 2); await f.render(); assert.equal(reads, 2);
});

test('incoming removal rejects a reply from any endpoint other than its dependent without replacing data or rereading', async () => {
  const f = fixture(async command => command === 'resource_relations' ? snapshot() : { ...snapshot(8), dependents: [] });
  await f.render(); await click('依赖关系'); await select(); await click('移除来自使用者 Skill的管理关系');
  assert.equal(host.querySelector('.relation-endpoint strong')!.textContent, '当前工具');
  assert(host.querySelector('[aria-label="被谁使用"]')!.textContent!.includes('使用者 Skill'));
  assert(host.querySelector('[role="alert"]')!.textContent!.includes('不属于该使用者'));
  assert.equal(host.querySelector('[role="status"]'), null);
  assert.equal(host.querySelector<HTMLSelectElement>('select')!.value, key(candidate()));
  assert.equal(button('移除来自使用者 Skill的管理关系').disabled, false);
  assert.equal(f.calls.filter(call => call.command === 'resource_relations').length, 1);
});

test('incoming removal conflicts preserve input and relations until explicit refresh supplies a new CAS revision', async () => {
  let reads = 0;
  const f = fixture(async command => { if (command === 'resource_relations') return snapshot(++reads === 1 ? 7 : 9); throw new Error('关系已变化，请刷新'); });
  await f.render(); await click('依赖关系'); await select(); await click('移除来自使用者 Skill的管理关系');
  assert.equal(host.querySelector<HTMLSelectElement>('select')!.value, key(candidate()));
  assert.equal(button('移除来自使用者 Skill的管理关系').disabled, true);
  assert(host.querySelector('[aria-label="被谁使用"]')!.textContent!.includes('使用者 Skill'));
  assert.equal(reads, 1); await click('刷新关系');
  assert.equal(button('移除来自使用者 Skill的管理关系').disabled, false);
  await click('移除来自使用者 Skill的管理关系');
  assert.deepEqual(f.calls.at(-1), { command: 'resource_relation_remove', args: { id: 'consumer-edge', expectedRevision: 9 } });
});

test('an incoming removal completed while hidden queues one current-endpoint read for the next visible render', async () => {
  const pending = deferred<ResourceRelationsSnapshot>(); let reads = 0;
  const f = fixture(async command => command === 'resource_relations'
    ? (++reads === 1 ? snapshot() : { ...snapshot(8), dependents: [] }) : pending.promise);
  await f.render(); await click('依赖关系'); await click('移除来自使用者 Skill的管理关系');
  await f.render({ visible: false, revision: 101 }); await f.render({ visible: false, revision: 102 });
  await act(async () => pending.resolve({ ...snapshot(8), endpoint: dependent(), dependencies: [], dependents: [] }));
  assert.equal(reads, 1); assert.equal(host.querySelector('.relation-endpoint strong')!.textContent, '当前工具');
  await f.render({ visible: true, revision: 103 });
  assert.equal(reads, 2); assert.deepEqual(f.calls.at(-1), { command: 'resource_relations', args: { endpoint: { kind: 'tool', id: 'one' } } });
  assert(host.querySelector('[aria-label="被谁使用"]')!.textContent!.includes('尚未记录使用者'));
  await f.render({ visible: true, revision: 103 }); assert.equal(reads, 2);
});

test('failed add preserves selection and existing data; a conflict blocks writes until refreshed', async () => {
  let reads = 0;
  const f = fixture(async command => { if (command === 'resource_relations') return snapshot(++reads === 1 ? 7 : 9); throw new Error('关系已变化，请刷新'); });
  await f.render(); await click('依赖关系'); await select(); await click('添加关系');
  assert.equal(host.querySelector<HTMLSelectElement>('select')!.value, key(candidate())); assert.equal(button('添加关系').disabled, true); assert(host.textContent!.includes('运行依赖'));
  await click('刷新关系'); assert.equal(button('添加关系').disabled, false); await click('添加关系'); assert.equal(f.calls.at(-1)!.args.expectedRevision, 9);
});

test('repeated add and remove clicks share one immediate write lock', async () => {
  const pending = deferred<ResourceRelationsSnapshot>(); const f = fixture(async command => command === 'resource_relations' ? snapshot() : pending.promise);
  await f.render(); await click('依赖关系'); await select();
  await act(async () => { button('添加关系').click(); button('移除关系').click(); button('移除来自使用者 Skill的管理关系').click(); button('添加关系').click(); });
  assert.equal(f.calls.filter(call => call.command !== 'resource_relations').length, 1); assert.equal(button('移除关系').disabled, true);
  await act(async () => pending.resolve({ ...snapshot(8), dependencies: [...snapshot().dependencies, edge('new', owner(), candidate())] }));
});

test('Basic shows both directions, stale references and labels without mutation controls', async () => {
  const value = snapshot(); value.dependents[0].dependent.exists = false;
  const f = fixture(async () => value); await f.render({ readOnly: true }); await click('依赖关系');
  assert(host.querySelector('[aria-label="被谁使用"]')!.textContent!.includes('失效引用'));
  assert(host.textContent!.includes('运行依赖')); assert.equal(host.querySelector('select'), null); assert.equal(button('移除关系'), undefined); assert.equal(button('添加关系'), undefined); assert.equal(host.querySelector('[aria-label="被谁使用"] button'), null);
  await click('刷新关系'); assert(f.calls.every(call => call.command === 'resource_relations'));
});

test('hidden panels do not read; returning visible coalesces all missed revisions into one read', async () => {
  const f = fixture(); await f.render({ visible: false }); await click('依赖关系'); assert.equal(f.calls.length, 0);
  await f.render(); await click('依赖关系'); assert.equal(f.calls.length, 1);
  await f.render({ visible: false, revision: 101 }); await f.render({ visible: false, revision: 102 }); await f.render({ visible: false, revision: 103 }); assert.equal(f.calls.length, 1);
  await f.render({ visible: true, revision: 103 }); assert.equal(f.calls.length, 2); await f.render({ visible: true, revision: 103 }); assert.equal(f.calls.length, 2);
});

test('in-flight reads do not install an older invalidation result and catch up once to the newest revision', async () => {
  const first = deferred<ResourceRelationsSnapshot>(), second = deferred<ResourceRelationsSnapshot>(); let reads = 0;
  const f = fixture(async () => ++reads === 1 ? first.promise : second.promise);
  await f.render(); await click('依赖关系'); await f.render({ revision: 101 }); await f.render({ revision: 102 }); assert.equal(reads, 1);
  const old = snapshot(); old.endpoint.name = '旧结果'; await act(async () => first.resolve(old)); assert.equal(reads, 2); assert(!host.textContent!.includes('旧结果'));
  const latest = snapshot(9); latest.endpoint.name = '最新结果'; await act(async () => second.resolve(latest)); assert(host.textContent!.includes('最新结果')); assert.equal(reads, 2);
});

test('a read resolving while hidden is ignored and one fresh read occurs on return', async () => {
  const pending = deferred<ResourceRelationsSnapshot>(); let reads = 0;
  const f = fixture(async () => ++reads === 1 ? pending.promise : snapshot(9));
  await f.render(); await click('依赖关系'); await f.render({ visible: false });
  const old = snapshot(); old.endpoint.name = '隐藏期间旧结果'; await act(async () => pending.resolve(old)); assert(!host.textContent!.includes('隐藏期间旧结果')); assert.equal(reads, 1);
  await f.render(); assert.equal(reads, 2); assert(host.textContent!.includes('当前工具'));
});

test('switching resource identities isolates pending responses even when the raw IDs match across kinds', async () => {
  const pending = deferred<ResourceRelationsSnapshot>();
  const f = fixture(async (_command, args) => args.endpoint.kind === 'tool' ? pending.promise : { ...snapshot(8), endpoint: candidate(), dependencies: [], dependents: [] });
  await f.render(); await click('依赖关系'); await f.render({ endpoint: { kind: 'skill', id: 'one' } }); assert.equal(button('依赖关系').getAttribute('aria-expanded'), 'false');
  await click('依赖关系'); await act(async () => pending.resolve(snapshot())); assert.equal(host.querySelector('.relation-endpoint strong')!.textContent, '可添加 Skill'); assert(!host.querySelector('[aria-label="依赖什么"]')!.textContent!.includes('运行依赖')); assert.equal(f.calls.length, 2);
});

test('read errors retain the last snapshot and input and wait for explicit retry', async () => {
  let reads = 0; const f = fixture(async () => { if (++reads > 1) throw new Error('Synthetic offline'); return snapshot(); });
  await f.render(); await click('依赖关系'); await select(); await click('刷新关系');
  assert(host.textContent!.includes('运行依赖')); assert.equal(host.querySelector<HTMLSelectElement>('select')!.value, key(candidate())); assert(host.textContent!.includes('Synthetic offline'));
  await f.render(); assert.equal(reads, 2);
});

test('foreign snapshot replies never replace this endpoint or clear an unsuccessful selected input', async () => {
  const foreign = { ...snapshot(8), endpoint: summary('tool', 'other', '错误资源') };
  const f = fixture(async command => command === 'resource_relations' ? snapshot() : foreign);
  await f.render(); await click('依赖关系'); await select(); await click('添加关系');
  assert(!host.textContent!.includes('错误资源')); assert.equal(host.querySelector<HTMLSelectElement>('select')!.value, key(candidate())); assert(host.textContent!.includes('不属于当前资源'));
});

test('a write overlapped by external invalidation reloads once instead of installing the stale reply', async () => {
  const pending = deferred<ResourceRelationsSnapshot>(); let reads = 0;
  const f = fixture(async command => { if (command !== 'resource_relations') return pending.promise; reads++; return { ...snapshot(reads === 1 ? 7 : 10), endpoint: { ...owner(), name: reads === 1 ? '当前工具' : '刷新后资源' } }; });
  await f.render(); await click('依赖关系'); await select(); await click('添加关系'); await f.render({ revision: 101 }); await f.render({ revision: 102 });
  const old = snapshot(8); old.endpoint.name = '迟到写结果'; await act(async () => pending.resolve(old));
  assert.equal(reads, 2); assert(host.textContent!.includes('刷新后资源')); assert(!host.textContent!.includes('迟到写结果'));
});

test('resource names render as text and missing current resources cannot gain new dependencies', async () => {
  const value = snapshot(); value.endpoint = { ...owner(), name: '<script>fake()</script>', exists: false };
  const f = fixture(async () => value); await f.render(); await click('依赖关系');
  assert(host.textContent!.includes('<script>fake()</script>')); assert.equal(host.querySelector('script'), null); assert.equal(button('添加关系').disabled, true);
});

test('late lower relation revisions do not overwrite a newer successful write', async () => {
  let reads = 0;
  const f = fixture(async command => {
    if (command !== 'resource_relations') return { ...snapshot(9), endpoint: { ...owner(), name: '写入后资源' } };
    return ++reads === 1 ? snapshot() : { ...snapshot(8), endpoint: { ...owner(), name: '过期数据' } };
  });
  await f.render(); await click('依赖关系'); await select(); await click('添加关系'); await click('刷新关系');
  assert.equal(host.querySelector('.relation-endpoint strong')!.textContent, '写入后资源'); assert(!host.textContent!.includes('过期数据'));
});

test('a pending write completed while hidden triggers no read until the panel becomes visible again', async () => {
  const pending = deferred<ResourceRelationsSnapshot>(); const f = fixture(async command => command === 'resource_relations' ? snapshot(9) : pending.promise);
  await f.render(); await click('依赖关系'); await select(); await click('添加关系'); await f.render({ visible: false, revision: 101 });
  await act(async () => pending.resolve(snapshot(10))); assert.equal(f.calls.filter(call => call.command === 'resource_relations').length, 1);
  await f.render({ visible: true, revision: 103 }); assert.equal(f.calls.filter(call => call.command === 'resource_relations').length, 2);
});
