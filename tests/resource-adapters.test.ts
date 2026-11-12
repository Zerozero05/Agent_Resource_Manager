import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
let code = ts.transpileModule(await readFile(new URL('../src/ResourceAdapters.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, specifier: string) => `from ${JSON.stringify(import.meta.resolve(specifier))}`);
const { ResourceAdapters } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const host = document.getElementById('root')!;
let cleanup = () => {};
function root() { const view = createRoot(host); cleanup = () => view.unmount(); return view; }
afterEach(async () => { await act(async () => cleanup()); cleanup = () => {}; });
const path = 'D:/synthetic/agent-reach';
const plan = (adapter = 'agentReach') => ({ id: 'preview-fixed', kind: 'resourceAdapter', adapter, name: adapter === 'agentReach' ? 'Agent Reach' : adapter === 'edgeControl' ? 'Edge Control' : 'DragonCodexBoot', rootPath: path, resourceId: null, resourceRevision: null, detectedVersion: '1.6.0', versionEvidence: '本地版本元数据；未执行程序', repository: adapter === 'dragonCodexBoot' ? null : 'https://github.com/synthetic/tool', sourceVerified: false, license: 'MIT', actions: adapter === 'dragonCodexBoot' ? [] : [{ id: 'version', label: '读取 CLI 版本', executable: path + '/Scripts/agent-reach.exe', workingDirectory: path, args: [{ type: 'literal', value: 'version' }] }], preserved: ['data/', '现有登录会话'], warnings: ['只读取本地元数据，尚未实际调用。'], canApply: true, deleteGrant: false, automaticUpdateGrant: false, filesChanged: false });
const receipt = () => ({ resource: { id: 'adopted-resource', rootPath: path, name: 'Existing', kind: 'cli', version: '1.6.0', alias: '', notes: '', enabled: true, ownership: 'external', managementScope: 'invoke', revision: 1, actions: [], capabilities: [], createdAt: '', updatedAt: '' }, complete: true, adopted: true, executed: false, filesChanged: false, ownership: 'external', sourceVerified: false });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(override?: (command: string, args: any) => Promise<unknown> | undefined) {
  const calls: { command: string; args: any }[] = [], changes: any[] = [];
  const action = async (_label: string, command: string, args: any) => { calls.push({ command, args }); const value = override?.(command, args); if (value) return value; if (command === 'preview_resource_adapter') return plan(args.adapter); if (command === 'apply_resource_adapter') return receipt(); throw new Error(command); };
  return { calls, changes, action, onChanged: (value: any) => changes.push(value) };
}
const button = (label: string) => Array.from(host.querySelectorAll('button')).find(item => item.textContent === label)!;
async function click(element: Element) { await act(async () => { assert(element); element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); }); }
async function select(adapter: string) { await act(async () => { const element = host.querySelector('select')!; element.value = adapter; element.dispatchEvent(new dom.window.Event('change', { bubbles: true })); }); }
async function input(value: string) { const element = host.querySelector('input')!; await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new dom.window.Event('input', { bubbles: true })); }); }
async function mount(props: any, extra: any = {}) { const view = root(); await act(async () => view.render(createElement(ResourceAdapters, { rootPath: path, ...props, ...extra }))); return view; }
async function show() { await click(button('接管现有工具')); }

test('adoption has no startup scans, no implicit saves, and hidden/basic mode exposes no controls', async () => {
  const f = fixture(), view = await mount(f); assert.equal(f.calls.length, 0);
  await show(); assert.equal(f.calls.length, 0);
  await act(async () => view.render(createElement(ResourceAdapters, { rootPath: path + '-new', ...f }))); assert.equal(f.calls.length, 0);
  await act(async () => view.render(createElement(ResourceAdapters, { rootPath: path, ...f, visible: false }))); assert.equal(host.childElementCount, 0);
  await act(async () => view.render(createElement(ResourceAdapters, { rootPath: path, ...f, readOnly: true }))); assert.equal(host.childElementCount, 0); assert.equal(f.calls.length, 0);
});

test('explicit preview shows exact fixed actions; saving sends only the one-time preview ID', async () => {
  const f = fixture(); await mount(f); await show(); await click(button('预览接管'));
  assert.deepEqual(f.calls, [{ command: 'preview_resource_adapter', args: { adapter: 'agentReach', rootPath: path } }]);
  assert(host.textContent?.includes('原位保留')); assert(host.textContent?.includes('version')); assert.equal(f.changes.length, 0);
  await click(button('保存接管')); assert.deepEqual(f.calls.at(-1), { command: 'apply_resource_adapter', args: { previewId: 'preview-fixed' } }); assert.equal(f.changes[0].id, 'adopted-resource');
  assert(host.textContent?.includes('原文件与登录状态保持')); assert(!button('保存接管'));
});

for (const permission of ['sourceVerified', 'deleteGrant', 'automaticUpdateGrant', 'filesChanged']) test(`unexpected ${permission} does not become an approved preview`, async () => {
  const f = fixture(async () => ({ ...plan(), [permission]: true })); await mount(f); await show(); await click(button('预览接管'));
  assert(host.querySelector('[role="alert"]')!.textContent?.includes('权限状态异常')); assert(!button('保存接管')); assert.equal(f.changes.length, 0);
});

test('real public-read adapter parameters can be previewed and adopted without executing a call', async () => {
  const publicRead = { id: 'reach-read', label: '读取公共网页', executable: path + '/Scripts/agent-reach.exe', workingDirectory: path,
    args: [{ type: 'literal', value: 'web' }, { type: 'literal', value: 'read' }, { type: 'parameter', name: 'url' }],
    parameters: [{ name: 'url', label: '公开网页 URL', kind: 'text', required: true, maxLength: 4096 }] };
  const f = fixture(command => command === 'preview_resource_adapter' ? { ...plan(), actions: [...plan().actions, publicRead] } : receipt());
  await mount(f); await show(); await click(button('预览接管'));
  assert(!host.querySelector('[role="alert"]')); assert(host.textContent?.includes('参数：公开网页 URL'));
  await click(button('保存接管'));
  assert.deepEqual(f.calls.map(call => call.command), ['preview_resource_adapter', 'apply_resource_adapter']);
  assert.equal(f.changes.length, 1);
});

test('a parameter reference without a declared supported parameter cannot be adopted', async () => {
  const invalid = { ...plan().actions[0], args: [{ type: 'parameter', name: 'missing' }], parameters: [] };
  const f = fixture(() => ({ ...plan(), actions: [invalid] }));
  await mount(f); await show(); await click(button('预览接管'));
  assert(host.querySelector('[role="alert"]')); assert(!button('保存接管')); assert.equal(f.changes.length, 0);
});

test('duplicate preview/save clicks do not create repeat actions', async () => {
  const pending = deferred<unknown>(), saving = deferred<unknown>();
  const f = fixture(command => command === 'preview_resource_adapter' ? pending.promise : saving.promise); await mount(f); await show();
  await act(async () => { button('预览接管').click(); button('预览接管')?.click(); }); assert.equal(f.calls.length, 1);
  await act(async () => pending.resolve(plan())); const save = button('保存接管');
  await act(async () => { save.click(); save.click(); }); assert.equal(f.calls.length, 2);
  await act(async () => saving.resolve(receipt())); assert.equal(f.changes.length, 1);
});

test('a changed root discards late preview and requires a new explicit read', async () => {
  const pending = deferred<unknown>(), f = fixture(async () => pending.promise), view = await mount(f); await show(); await click(button('预览接管'));
  await act(async () => view.render(createElement(ResourceAdapters, { rootPath: path + '-other', ...f })));
  await act(async () => pending.resolve(plan())); assert(!button('保存接管')); assert.equal(f.changes.length, 0); assert.equal(f.calls.length, 1);
});

for (const transition of [{ visible: false }, { readOnly: true }]) test(`late receipt after ${Object.keys(transition)[0]} does not mutate a hidden view`, async () => {
  const pending = deferred<unknown>(); const f = fixture(command => command === 'apply_resource_adapter' ? pending.promise : undefined), view = await mount(f); await show(); await click(button('预览接管')); await click(button('保存接管'));
  await act(async () => view.render(createElement(ResourceAdapters, { rootPath: path, ...f, ...transition })));
  await act(async () => pending.resolve(receipt())); assert.equal(host.childElementCount, 0); assert.equal(f.changes.length, 0);
  await act(async () => view.render(createElement(ResourceAdapters, { rootPath: path, ...f }))); assert(!button('保存接管')); assert.equal(f.calls.length, 2);
});

test('adapter changes clear authority, Edge can use or explicitly select existing Node, and Dragon offers no startup action', async () => {
  const f = fixture(); await mount(f); await show(); await click(button('预览接管')); await select('edgeControl'); assert(!button('保存接管'));
  assert.equal(host.querySelector('option[value="edgeControl"]')?.textContent, 'Playwright MCP');
  await click(button('预览接管')); assert.deepEqual(f.calls.at(-1)!.args, { adapter: 'edgeControl', rootPath: path });
  await input('D:/synthetic/node.exe'); assert(!button('保存接管')); await click(button('预览接管')); assert.equal(f.calls.at(-1)!.args.nodePath, 'D:/synthetic/node.exe');
  await select('dragonCodexBoot'); await click(button('预览接管')); assert.deepEqual(f.calls.at(-1)!.args, { adapter: 'dragonCodexBoot', rootPath: path });
  assert(host.textContent?.includes('固定检查动作（0）')); assert(host.textContent?.includes('保留原生启动入口')); assert(!host.textContent?.includes('--help'));
});

test('collapse stays on its original disclosure button and invalidates the old confirmation', async () => {
  const f = fixture(); await mount(f); await show(); await click(button('预览接管')); const disclosure = button('接管现有工具');
  await click(disclosure); assert.equal(document.activeElement, disclosure); assert.equal(disclosure.getAttribute('aria-expanded'), 'false'); assert(!button('保存接管'));
  await click(disclosure); assert(!button('保存接管')); assert.equal(f.calls.length, 1);
});

test('partial or unsafe save receipt prompts a directory refresh instead of reporting success', async () => {
  const f = fixture(command => command === 'apply_resource_adapter' ? Promise.resolve({ ...receipt(), complete: false }) : undefined); await mount(f); await show(); await click(button('预览接管')); await click(button('保存接管'));
  assert(host.querySelector('[role="alert"]')!.textContent?.includes('核对实际结果')); assert.equal(f.changes.length, 0); assert(!button('保存接管'));
});

function existingEdge(revision = 7, ownership: 'external' | 'managed' = 'external') {
  const rootPath = 'D:/synthetic/edge-mcp', node = 'D:/synthetic/node/node.exe';
  return { ...receipt().resource, id: 'existing-edge', name: 'Edge Control', kind: 'mcp', rootPath, version: '0.0.84', revision, ownership,
    actions: ['edge-version', 'edge-help', 'edge-tabs', 'edge-snapshot'].map(id => ({ id, label: id, mode: 'task', executable: node, workingDirectory: rootPath, args: [{ type: 'literal', value: '--version' }], parameters: [], adapterBinding: { adapter: 'edgeControl' } })) };
}
function refreshPlan(resource = existingEdge()) {
  return { ...plan('edgeControl'), operation: 'refreshNode', rootPath: resource.rootPath, resourceId: resource.id, resourceRevision: resource.revision, detectedVersion: resource.version, actions: resource.actions,
    runtimeChange: { path: resource.actions[0].executable, previousSha256: 'a'.repeat(64), currentSha256: 'b'.repeat(64) } };
}
function refreshReceipt(resource = existingEdge()) {
  return { ...receipt(), operation: 'refreshNode', ownership: resource.ownership, resource: { ...resource, revision: resource.revision + 1 } };
}

test('existing fixed Edge actions expose an explicit read-only Node refresh and preserve ownership', async () => {
  const resource = existingEdge(7, 'managed');
  const f = fixture(command => command === 'preview_resource_adapter' ? Promise.resolve(refreshPlan(resource)) : Promise.resolve(refreshReceipt(resource)));
  const view = await mount(f, { resource, rootPath: resource.rootPath });
  assert.equal(f.calls.length, 0); await click(button('重新核对入口')); assert.equal(f.calls.length, 0);
  assert(host.querySelector('dd')?.textContent === 'Playwright MCP');
  assert.equal(host.querySelectorAll('input, select').length, 0); assert(host.textContent?.includes(resource.rootPath)); assert(host.textContent?.includes(resource.actions[0].executable));
  await click(button('预览入口变化'));
  assert.deepEqual(f.calls, [{ command: 'preview_resource_adapter', args: { operation: 'refreshNode', resourceId: resource.id, expectedRevision: 7 } }]);
  assert(host.textContent?.includes('a'.repeat(64))); assert(host.textContent?.includes('b'.repeat(64))); assert(host.textContent?.includes('4 项 → 4 项'));
  await click(button('保存入口核对'));
  assert.deepEqual(f.calls.at(-1), { command: 'apply_resource_adapter', args: { previewId: 'preview-fixed' } });
  assert.equal(f.changes.length, 1); assert.equal(f.changes[0].id, resource.id); assert.equal(f.changes[0].ownership, 'managed'); assert(!button('保存入口核对'));
  await act(async () => view.render(createElement(ResourceAdapters, { rootPath: resource.rootPath, resource: f.changes[0], ...f })));
  assert(host.textContent?.includes('入口核对已保存')); assert(!button('保存入口核对'));
});

test('generic, mixed or absent bindings do not expose a Node refresh entry', async () => {
  const f = fixture(), resource = existingEdge(), view = await mount(f, { resource: { ...resource, actions: [] }, rootPath: resource.rootPath });
  assert.equal(host.childElementCount, 0);
  for (const actions of [resource.actions.map(item => ({ ...item, adapterBinding: undefined })), [resource.actions[0], { ...resource.actions[1], executable: 'D:/other/node.exe' }], [resource.actions[0], { ...resource.actions[1], adapterBinding: { adapter: 'agentReach' } }]]) {
    await act(async () => view.render(createElement(ResourceAdapters, { rootPath: resource.rootPath, resource: { ...resource, actions }, ...f })));
    assert.equal(host.childElementCount, 0);
  }
  assert.equal(f.calls.length, 0);
});

for (const altered of [
  { operation: undefined }, { resourceId: 'other-edge' }, { resourceRevision: 8 }, { actions: [] },
  { runtimeChange: { path: 'D:/synthetic/node/node.exe', previousSha256: 'unknown', currentSha256: 'b'.repeat(64) } },
]) test(`mismatched refresh authority ${Object.keys(altered)[0]} cannot be saved`, async () => {
  const resource = existingEdge(), f = fixture(command => command === 'preview_resource_adapter' ? Promise.resolve({ ...refreshPlan(resource), ...altered }) : undefined);
  await mount(f, { resource, rootPath: resource.rootPath }); await click(button('重新核对入口')); await click(button('预览入口变化'));
  assert(host.querySelector('[role="alert"]')); assert(!button('保存入口核对')); assert.equal(f.calls.length, 1); assert.equal(f.changes.length, 0);
});

test('changed resource revision invalidates late refresh authority and keeps the disclosure stationary', async () => {
  const resource = existingEdge(), pending = deferred<unknown>(), f = fixture(() => pending.promise), view = await mount(f, { resource, rootPath: resource.rootPath });
  await click(button('重新核对入口')); const disclosure = button('重新核对入口'); await click(button('预览入口变化'));
  await act(async () => view.render(createElement(ResourceAdapters, { rootPath: resource.rootPath, resource: { ...resource, revision: 8 }, ...f })));
  await act(async () => pending.resolve(refreshPlan(resource))); assert(!button('保存入口核对')); assert.equal(f.changes.length, 0);
  assert.equal(button('重新核对入口'), disclosure); await click(disclosure); assert.equal(document.activeElement, disclosure); assert.equal(disclosure.getAttribute('aria-expanded'), 'false');
});

test('read-only or hidden refresh views discard a late saved receipt', async () => {
  const resource = existingEdge(), pending = deferred<unknown>();
  const f = fixture(command => command === 'preview_resource_adapter' ? Promise.resolve(refreshPlan(resource)) : pending.promise), view = await mount(f, { resource, rootPath: resource.rootPath });
  await click(button('重新核对入口')); await click(button('预览入口变化')); await click(button('保存入口核对'));
  await act(async () => view.render(createElement(ResourceAdapters, { rootPath: resource.rootPath, resource, ...f, visible: false, readOnly: true })));
  await act(async () => pending.resolve(refreshReceipt(resource))); assert.equal(host.childElementCount, 0); assert.equal(f.changes.length, 0);
});
