import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import type { Resource } from '../src/resources.ts';
import type { ResourceSourceData, SourceBinding, SourceHealth, SourcePreview } from '../src/ResourceSource.tsx';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
let code = ts.transpileModule(await readFile(new URL('../src/ResourceSource.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText.replace(/import\s+['"][^'"]+\.css['"];?/g, '');
code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, specifier: string) => `from ${JSON.stringify(import.meta.resolve(specifier))}`);
const { ResourceSource } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const host = document.getElementById('root')!;
let cleanup = () => {};
afterEach(async () => { await act(async () => cleanup()); cleanup = () => {}; });
const oldRepo = 'https://github.com/original/tool', newRepo = 'https://github.com/current/tool', checkedAt = '2026-10-30T01:02:03Z';
const resource = (revision = 4): Resource => ({ id: 'one', name: '工具', kind: 'cli', rootPath: 'D:/synthetic/tool', repository: oldRepo, version: 'installed-v1', alias: '个人别名', notes: '个人备注', enabled: true, ownership: 'external', revision, managementScope: 'register', actions: [], capabilities: [], createdAt: '', updatedAt: '' });
const binding = (repository = newRepo, asset = false): SourceBinding => ({ repository, repositoryId: 21, verifiedAt: checkedAt, asset: asset ? { releaseId: 31, assetId: 41, tag: 'source-v9', assetName: 'windows.zip', size: 1024, digest: null, url: `${repository}/releases/download/source-v9/windows.zip`, updatedAt: checkedAt } : null });
const snapshot = (revision = 4): ResourceSourceData => ({ id: 'one', resourceRevision: revision, repository: oldRepo, installedVersion: 'installed-v1', installationSource: { repository: 'https://github.com/installation/tool', version: 'installed-v1', archiveSha256: 'synthetic-sha', downloadSource: null }, binding: null, history: [], mappingStatus: 'repositoryOnly', requiresVerification: false });
const packageSource = () => ({ recipe: 'edgeMcpNpmV1', version: '0.0.83', planHash: 'b'.repeat(64), artifacts: [{ bytes: 1234, sha256: 'a'.repeat(64), origin: { kind: 'npmRegistry', package: '@playwright/mcp', version: '0.0.83', tarball: 'https://registry.npmjs.org/@playwright/mcp/-/mcp-0.0.83.tgz', integrity: `sha512-${'A'.repeat(86)}==` } }] });
const preview = (asset = false, revision = 4): SourcePreview => ({ previewId: 'preview-one', kind: 'resourceSource', id: 'one', resourceRevision: revision, previous: snapshot(revision), next: binding(newRepo, asset), mappingStatus: asset ? 'releaseAsset' : 'repositoryOnly', canApply: true, warnings: ['本地能力需重新核验'] });
const applied = (): ResourceSourceData => ({ ...snapshot(5), repository: newRepo, binding: binding(), requiresVerification: true });
const catalogue = () => ({ repository: newRepo, author: 'current', releases: [{ id: 31, tag: 'source-v9', name: 'Release', url: `${newRepo}/releases/tag/source-v9`, publishedAt: checkedAt, prerelease: false, assets: [{ id: 41, name: 'windows.zip', size: 1024, url: `${newRepo}/releases/download/source-v9/windows.zip`, updatedAt: checkedAt }, { id: 42, name: 'unavailable.zip', size: 2048, url: null, unavailableReason: '无法核对下载地址' }] }] });
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)!;
const input = () => host.querySelector<HTMLInputElement>('[aria-label="新的 GitHub 来源"]')!;
const region = (label: string) => host.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
async function click(label: string) { assert(button(label), `Missing ${label}`); await act(async () => button(label).click()); }
async function change(value: string) { await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input(), value); input().dispatchEvent(new dom.window.Event('input', { bubbles: true })); }); }
async function choose(label: string, value: string) { await act(async () => { const select = host.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!; select.value = value; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); }); }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(handler: (command: string, args: any) => Promise<unknown> = async () => snapshot()) {
  const root = createRoot(host); cleanup = () => root.unmount(); const calls: { command: string; args: any }[] = []; let changed = 0;
  const action = async (_label: string, command: string, args: any) => { calls.push({ command, args }); return handler(command, args); };
  return { calls, changed: () => changed, render: async (props = {}) => act(async () => root.render(createElement(ResourceSource, { resource: resource(), action, onChanged: () => { changed++; }, ...props }))) };
}

test('package installation displays its fixed origins instead of a fictional ZIP and health stays scoped to the repository', async () => {
  const value = { ...snapshot(), installationSource: { repository: 'https://github.com/microsoft/playwright-mcp', version: '0.0.83', archiveSha256: '', downloadSource: null, runtimePackage: packageSource() } };
  const f = fixture(async command => command === 'resource_source_health' ? { ...value, health: { status: 'reachable', message: '来源当前可访问', checkedAt } } : value);
  await f.render(); await click('来源与健康');
  const installed = region('原安装来源');
  for (const text of ['Playwright MCP · npm 配方', '0.0.83', '@playwright/mcp', 'SHA-256', 'npm integrity', 'a'.repeat(16)]) assert(installed.textContent?.includes(text), text);
  assert(!installed.textContent?.includes('安装包摘要：未记录'));
  assert.equal(installed.querySelector('a')!.getAttribute('href'), 'https://registry.npmjs.org/@playwright/mcp/-/mcp-0.0.83.tgz');
  await click('检查来源健康'); assert(region('来源健康结果').textContent?.includes('仓库可访问')); assert(region('来源健康结果').textContent?.includes('未联网核验以上软件包资产'));
  assert.equal(f.changed(), 0); assert(!f.calls.some(call => /apply|install|invoke/.test(call.command)));
});

test('source reads only after expansion and distinguishes current mapping, installed version and original installation evidence', async () => {
  const value = { ...snapshot(), repository: newRepo, binding: binding(newRepo, true), requiresVerification: true, mappingStatus: 'releaseAsset', history: [{ changedAt: checkedAt, repository: oldRepo, binding: null, capabilities: [] }] };
  const f = fixture(async () => value); await f.render(); await f.render(); assert.equal(f.calls.length, 0);
  await click('来源与健康'); assert.deepEqual(f.calls, [{ command: 'resource_source', args: { id: 'one' } }]);
  assert(region('当前来源关联').textContent!.includes('已安装版本：installed-v1'));
  assert(region('当前来源关联').textContent!.includes('发行标签：source-v9'));
  assert(!region('当前来源关联').textContent!.includes('来源尚待核对'));
  assert(region('原安装来源').textContent!.includes('https://github.com/installation/tool')); assert(region('原安装来源').textContent!.includes('synthetic-sha'));
  assert(host.querySelector('.resource-source-history')!.textContent!.includes(oldRepo)); await f.render(); assert.equal(f.calls.length, 1);
});

test('Basic exposes saved sources and explicit refresh without network probes or mutation controls', async () => {
  const f = fixture(); await f.render({ readOnly: true }); await click('来源与健康');
  assert(region('当前来源关联')); assert.equal(input(), null); assert.equal(button('检查来源健康'), undefined); assert.equal(button('预览来源关联'), undefined);
  await click('刷新来源信息'); assert.equal(f.calls.length, 2); assert(f.calls.every(call => call.command === 'resource_source'));
});

test('a registered version without installation evidence remains explicitly unverified', async () => {
  const f = fixture(async () => ({ ...snapshot(), installationSource: null })); await f.render(); await click('来源与健康');
  assert(region('当前来源关联').textContent!.includes('安装版本登记值（未核实）：installed-v1'));
  assert(region('原安装来源').textContent!.includes('未记录安装来源')); assert(!region('当前来源关联').textContent!.includes('已安装版本：'));
});

test('health categories and timestamps preserve uncertainty and never turn network failure into deletion', async () => {
  let status: SourceHealth['status'] = 'network';
  const f = fixture(async command => command === 'resource_source' ? snapshot() : { ...snapshot(), health: { status, message: '合成检查说明', checkedAt } });
  await f.render(); await click('来源与健康');
  const labels: [SourceHealth['status'], string][] = [['network', '网络连接失败'], ['unavailable', '来源当前不可访问'], ['authentication', '需要身份验证'], ['permission', '访问权限不足'], ['rateLimited', '请求频率受限'], ['changed', '来源映射已变化'], ['error', '检查未完成'], ['unconfigured', '尚未关联来源'], ['reachable', '来源可访问']];
  for (const [next, label] of labels) { status = next; await click('检查来源健康'); assert(region('来源健康结果').textContent!.includes(label)); assert.equal(region('来源健康结果').querySelector('time')!.dateTime, checkedAt); }
  assert(!host.textContent!.includes('已删除')); assert.equal(f.changed(), 0);
  assert(f.calls.filter(call => call.command === 'resource_source_health').every(call => call.args.id === 'one' && call.args.expectedRevision === 4));
});

test('repository-only rebind requires preview and explicit confirmation; repeated confirmation submits once and preserves installation evidence', async () => {
  const pending = deferred<ResourceSourceData>();
  const f = fixture(async command => command === 'resource_source' ? snapshot() : command === 'preview_resource_source' ? preview() : pending.promise);
  await f.render(); await click('来源与健康'); await change(` ${newRepo} `); await click('预览来源关联');
  assert.deepEqual(f.calls.at(-1), { command: 'preview_resource_source', args: { id: 'one', expectedRevision: 4, repository: newRepo } });
  assert(region('原关联').textContent!.includes(oldRepo)); assert(region('新关联').textContent!.includes(newRepo)); assert.equal(f.changed(), 0);
  await act(async () => { button('确认保存来源关联').click(); button('确认保存来源关联').click(); });
  assert.equal(f.calls.filter(call => call.command === 'apply_resource_source').length, 1); assert.equal(input().disabled, true);
  await act(async () => pending.resolve(applied()));
  assert.equal(f.changed(), 1); assert.equal(region('来源关联预览'), null); assert(region('当前来源关联').textContent!.includes(newRepo));
  assert(region('当前来源关联').textContent!.includes('已安装版本：installed-v1')); assert(region('原安装来源').textContent!.includes('synthetic-sha'));
  assert(f.calls.every(call => ['resource_source', 'preview_resource_source', 'apply_resource_source'].includes(call.command)));
});

test('release mapping uses an explicitly selected concrete asset and excludes unavailable assets without downloading', async () => {
  const f = fixture(async command => command === 'resource_source' ? snapshot() : command === 'resource_github_releases' ? catalogue() : preview(true));
  await f.render(); await click('来源与健康'); await change(newRepo); await choose('来源关联范围', 'releaseAsset');
  assert.equal(button('预览来源关联').disabled, true); await click('查询来源发行文件');
  assert.deepEqual(f.calls.at(-1), { command: 'resource_github_releases', args: { repository: newRepo } });
  assert.equal(host.querySelector<HTMLSelectElement>('[aria-label="来源发行版本"]')!.value, '');
  await choose('来源发行版本', '31'); assert.equal(button('预览来源关联').disabled, true);
  assert.equal(host.querySelector<HTMLOptionElement>('[aria-label="来源发行文件"] option[value="42"]')!.disabled, true);
  await choose('来源发行文件', '41'); await click('预览来源关联');
  assert.deepEqual(f.calls.at(-1), { command: 'preview_resource_source', args: { id: 'one', expectedRevision: 4, repository: newRepo, releaseId: 31, assetId: 41 } });
  assert(region('新关联').textContent!.includes('windows.zip')); assert(region('新关联').textContent!.includes('source-v9'));
  await choose('来源发行版本', ''); assert.equal(region('来源关联预览'), null); assert.equal(button('预览来源关联').disabled, true);
  assert(!f.calls.some(call => /download|install/.test(call.command)));
});

test('changing a draft discards a delayed preview and an already displayed preview', async () => {
  const pending = deferred<SourcePreview>(); let previews = 0;
  const f = fixture(async command => command === 'resource_source' ? snapshot() : ++previews === 1 ? pending.promise : preview());
  await f.render(); await click('来源与健康'); await change(newRepo); await click('预览来源关联'); await change('https://github.com/other/tool');
  await act(async () => pending.resolve(preview())); assert.equal(region('来源关联预览'), null); assert.equal(input().value, 'https://github.com/other/tool');
  await change(newRepo); await click('预览来源关联'); assert(region('来源关联预览')); await change(oldRepo); assert.equal(region('来源关联预览'), null);
});

test('same-turn duplicate previews share a lock without invalidating the first preview', async () => {
  const pending = deferred<SourcePreview>(); const f = fixture(async command => command === 'resource_source' ? snapshot() : pending.promise);
  await f.render(); await click('来源与健康'); await change(newRepo);
  await act(async () => { button('预览来源关联').click(); button('预览来源关联').click(); });
  assert.equal(f.calls.filter(call => call.command === 'preview_resource_source').length, 1);
  await act(async () => pending.resolve(preview())); assert(region('来源关联预览'));
});

test('resource revision changes invalidate delayed previews, preserve drafts and coalesce a fresh read', async () => {
  const pending = deferred<SourcePreview>(); let reads = 0;
  const f = fixture(async command => command === 'resource_source' ? snapshot(++reads === 1 ? 4 : 6) : pending.promise);
  await f.render(); await click('来源与健康'); await change(newRepo); await click('预览来源关联');
  await f.render({ resource: resource(5) }); await f.render({ resource: resource(6) }); assert.equal(reads, 1);
  await act(async () => pending.resolve(preview())); assert.equal(reads, 2); assert.equal(region('来源关联预览'), null); assert.equal(input().value, newRepo);
  assert.equal(button('预览来源关联').disabled, false);
});

test('hidden views perform no reads and ignore pending replies before one catch-up read when shown', async () => {
  const pending = deferred<ResourceSourceData>(); let reads = 0;
  const f = fixture(async () => ++reads === 1 ? pending.promise : snapshot(6));
  await f.render({ visible: false }); await click('来源与健康'); assert.equal(reads, 0);
  await f.render(); await click('来源与健康'); await f.render({ visible: false, resource: resource(5) }); await f.render({ visible: false, resource: resource(6) });
  await act(async () => pending.resolve(snapshot())); assert.equal(region('当前来源关联'), null); assert.equal(reads, 1);
  await f.render({ visible: true, resource: resource(6) }); assert.equal(reads, 2); assert(region('当前来源关联'));
  await f.render({ visible: true, resource: resource(6) }); assert.equal(reads, 2);
});

test('read failures retain source data and input and wait for an explicit retry', async () => {
  let reads = 0; const f = fixture(async () => { if (++reads > 1) throw new Error('Synthetic offline'); return snapshot(); });
  await f.render(); await click('来源与健康'); await change(newRepo); await click('刷新来源信息');
  assert(region('当前来源关联').textContent!.includes(oldRepo)); assert.equal(input().value, newRepo); assert(host.querySelector('[role="alert"]')!.textContent!.includes('Synthetic offline'));
  await f.render(); assert.equal(reads, 2);
});

test('CAS failure keeps the draft, disables confirmation and uses the newly read revision after explicit refresh', async () => {
  let reads = 0;
  const f = fixture(async command => { if (command === 'resource_source') return snapshot(++reads === 1 ? 4 : 5); if (command === 'preview_resource_source') return preview(false, reads === 1 ? 4 : 5); throw new Error('资源已变化，请重新读取来源并预览'); });
  await f.render(); await click('来源与健康'); await change(newRepo); await click('预览来源关联'); await click('确认保存来源关联');
  assert.equal(input().value, newRepo); assert.equal(region('来源关联预览'), null); assert.equal(button('预览来源关联').disabled, true); assert.equal(f.changed(), 0);
  await click('刷新来源信息'); assert.equal(button('预览来源关联').disabled, false); await click('预览来源关联'); assert.equal(f.calls.at(-1)!.args.expectedRevision, 5);
});

test('foreign preview and apply replies cannot change the current source or announce success', async () => {
  let foreignPreview = true;
  const f = fixture(async command => command === 'resource_source' ? snapshot() : command === 'preview_resource_source' ? { ...preview(), id: foreignPreview ? 'other' : 'one' } : { ...applied(), id: 'other' });
  await f.render(); await click('来源与健康'); await change(newRepo); await click('预览来源关联');
  assert.equal(region('来源关联预览'), null); assert.equal(f.changed(), 0); assert.equal(input().value, newRepo);
  foreignPreview = false; await click('预览来源关联'); await click('确认保存来源关联');
  assert(region('当前来源关联').textContent!.includes(oldRepo)); assert(host.querySelector('[role="alert"]')!.textContent!.includes('不属于当前工具')); assert.equal(f.changed(), 0); assert.equal(host.querySelector('[role="status"]'), null);
});

test('switching resource identities isolates delayed responses and does not copy the old draft', async () => {
  const pending = deferred<ResourceSourceData>();
  const f = fixture(async (_command, args) => args.id === 'one' ? pending.promise : { ...snapshot(), id: 'two', repository: newRepo });
  await f.render(); await click('来源与健康'); await f.render({ resource: { ...resource(), id: 'two', repository: newRepo } });
  assert.equal(button('来源与健康').getAttribute('aria-expanded'), 'false'); await click('来源与健康');
  await act(async () => pending.resolve(snapshot())); assert(region('当前来源关联').textContent!.includes(newRepo)); assert.equal(input().value, newRepo);
});

test('late apply after resource changes is not installed and a fresh current snapshot is read without replay', async () => {
  const pending = deferred<ResourceSourceData>(); let reads = 0;
  const f = fixture(async command => command === 'resource_source' ? { ...snapshot(++reads === 1 ? 4 : 6), repository: reads === 1 ? oldRepo : 'https://github.com/latest/tool' } : command === 'preview_resource_source' ? preview() : pending.promise);
  await f.render(); await click('来源与健康'); await change(newRepo); await click('预览来源关联'); await click('确认保存来源关联'); await f.render({ resource: resource(6) });
  await act(async () => pending.resolve(applied()));
  assert.equal(f.changed(), 0); assert.equal(reads, 2); assert(region('当前来源关联').textContent!.includes('https://github.com/latest/tool'));
  assert.equal(f.calls.filter(call => call.command === 'apply_resource_source').length, 1); assert.equal(input().value, newRepo);
});

test('a delayed release catalogue is discarded when the repository input changes', async () => {
  const pending = deferred<unknown>(); const f = fixture(async command => command === 'resource_source' ? snapshot() : pending.promise);
  await f.render(); await click('来源与健康'); await change(newRepo); await choose('来源关联范围', 'releaseAsset'); await click('查询来源发行文件'); await change(oldRepo);
  await act(async () => pending.resolve(catalogue())); assert.equal(host.querySelector('[aria-label="来源发行版本"]'), null); assert.equal(button('预览来源关联').disabled, true);
});

test('a failed apply preserves selected release and asset inputs for a new review', async () => {
  const f = fixture(async command => {
    if (command === 'resource_source') return snapshot();
    if (command === 'resource_github_releases') return catalogue();
    if (command === 'preview_resource_source') return preview(true);
    throw new Error('Synthetic network interruption');
  });
  await f.render(); await click('来源与健康'); await change(newRepo); await choose('来源关联范围', 'releaseAsset'); await click('查询来源发行文件'); await choose('来源发行版本', '31'); await choose('来源发行文件', '41'); await click('预览来源关联'); await click('确认保存来源关联');
  assert.equal(input().value, newRepo); assert.equal(host.querySelector<HTMLSelectElement>('[aria-label="来源发行版本"]')!.value, '31'); assert.equal(host.querySelector<HTMLSelectElement>('[aria-label="来源发行文件"]')!.value, '41');
  assert(region('当前来源关联').textContent!.includes(oldRepo)); assert.equal(f.changed(), 0); assert(host.querySelector('[role="alert"]')!.textContent!.includes('Synthetic network interruption'));
});

test('version observations are read on demand in Basic and never fetch or apply a release', async () => {
  const f = fixture(async command => command === 'resource_source' ? snapshot() : {
    id: 'one', message: '版本读取，不证明运行能力', installedVersion: 'installed-v1',
    check: { status: 'checked', message: '未下载安装', checkedAt, nextCheckAt: '2026-10-31T01:02:03Z', latest: { version: 'v2', url: `${oldRepo}/releases/tag/v2` } },
  });
  await f.render({ readOnly: true }); assert.equal(f.calls.length, 0);
  await click('来源与健康'); assert.equal(f.calls.length, 1);
  await click('查看最近版本检查'); assert.deepEqual(f.calls[1], { command: 'resource_version_check_status', args: { id: 'one' } });
  assert(region('最近版本检查').textContent!.includes('v2'));
  assert(region('最近版本检查').textContent!.includes('installed-v1'));
  assert.equal(f.changed(), 0); assert.equal(f.calls.length, 2);
});

test('a hidden source pane discards a late version observation and waits for explicit reread', async () => {
  const pending = deferred<unknown>();
  const f = fixture(async command => command === 'resource_source' ? snapshot() : pending.promise);
  await f.render(); await click('来源与健康'); await click('查看最近版本检查');
  await f.render({ visible: false });
  await act(async () => pending.resolve({ id: 'one', message: 'stale version', check: null }));
  assert.equal(region('最近版本检查'), null);
  await f.render({ visible: true });
  assert.equal(f.calls.filter(call => call.command === 'resource_version_check_status').length, 1);
});
