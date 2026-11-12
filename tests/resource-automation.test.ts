import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const url = (source: string) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const dialog = url('export async function open(){return "D:/synthetic/chosen";}');
const rates = url(ts.transpileModule(await readFile(new URL('../src/download-rate.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
let code = ts.transpileModule(await readFile(new URL('../src/ResourceAutomation.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, specifier: string) => `from ${JSON.stringify(specifier === '@tauri-apps/plugin-dialog' ? dialog : specifier === './download-rate' ? rates : import.meta.resolve(specifier))}`);
const { ResourceAutomation } = await import(url(code));
const host = document.getElementById('root')!;
let cleanup = () => {};
function root() { const view = createRoot(host); cleanup = () => view.unmount(); return view; }
afterEach(async () => { await act(async () => cleanup()); cleanup = () => {}; });
const resource = (revision = 4) => ({ id: 'tool', name: '测试工具', kind: 'cli', rootPath: 'D:/synthetic/v1', repository: 'https://github.com/synthetic/tool', version: 'v1', alias: '原别名', notes: '原备注', enabled: true, ownership: 'managed', revision, managementScope: 'ownedFiles', actions: [], capabilities: [], createdAt: '', updatedAt: '' });
const files = { 'tool.exe': 'runtime', LICENSE: 'license' };
const scope = { repository: 'https://github.com/synthetic/tool', repositoryId: 11, candidateParentPath: 'D:/synthetic/versions', downloadDirectory: 'D:/synthetic/downloads', channel: 'stable', assetName: 'windows.zip', files, pinnedVersion: null, skippedVersions: [] };
const status = () => ({ resourceId: 'tool', resourceRevision: 4, policyMode: 'manual', authorization: null, currentScope: { repository: scope.repository, repositoryId: 11, installedVersion: 'v1', assetName: scope.assetName, files, pinnedVersion: null, skippedVersions: [] }, effective: false, blockedReason: '尚未明确授权自动下载或应用' });
const plan = (enabled = true) => ({ id: 'permission-plan', kind: 'resourceAutomation', resourceId: 'tool', resourceRevision: 4, enabled, scope: enabled ? scope : null, canApply: true, permissions: enabled ? ['仅下载精确匹配的稳定ZIP到已选目录', '仅在已选父目录创建新的候选运行目录', '隔离验证及提交前重核通过后才允许切换'] : ['停止后续自动下载与切换'], warnings: ['本次仅保存明确授权，不立即下载、安装或切换。', '不授权新权限、共享依赖变化或数据迁移。'] });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(override?: (command: string, args: any) => Promise<unknown> | undefined) {
  const calls: { command: string; args: any }[] = [], changes: any[] = [];
  const action = async (_label: string, command: string, args: any) => { calls.push({ command, args }); const value = override?.(command, args); if (value) return value; if (command === 'resource_automation_status') return status(); if (command === 'preview_resource_automation') return plan(args.enabled); if (command === 'apply_resource_automation') return { resource: resource(5), authorization: { enabled: true }, saved: true, automaticApplied: false }; throw new Error(command); };
  return { calls, changes, action, onChanged: (value: any) => changes.push(value) };
}
const button = (label: string) => Array.from(host.querySelectorAll('button')).find(item => item.textContent === label)!;
async function click(element: Element) { await act(async () => { assert(element); element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); }); }
async function change(label: string, value: string) { const input = Array.from(host.querySelectorAll('label')).find(item => item.textContent?.startsWith(label))!.querySelector('input')!; await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); }); }
async function mount(props: any, extra: any = {}) { const view = root(); await act(async () => view.render(createElement(ResourceAutomation, { resource: resource(), ...props, ...extra }))); return view; }
async function enableForm() { await click(button('自动更新许可')); await click(host.querySelector('input[type="checkbox"]')!); await change('候选持久父目录', scope.candidateParentPath); await change('下载目录', scope.downloadDirectory); }

test('authorization has no startup or prop-change I/O, and hidden/basic views expose no controls', async () => {
  const f = fixture(), view = await mount(f); assert.equal(f.calls.length, 0);
  await act(async () => view.render(createElement(ResourceAutomation, { resource: resource(6), ...f }))); assert.equal(f.calls.length, 0);
  await act(async () => view.render(createElement(ResourceAutomation, { resource: resource(), ...f, visible: false }))); assert.equal(host.childElementCount, 0);
  await act(async () => view.render(createElement(ResourceAutomation, { resource: resource(), ...f, readOnly: true }))); assert.equal(host.childElementCount, 0); assert.equal(f.calls.length, 0);
});

test('only preview plus explicit native confirmation saves exact source, paths, roles and stable-channel consent', async () => {
  const f = fixture(); await mount(f); await enableForm(); assert.equal(f.calls.length, 1); assert.equal(f.changes.length, 0);
  await click(button('预览本次许可'));
  assert.deepEqual(f.calls.at(-1), { command: 'preview_resource_automation', args: { resourceId: 'tool', expectedRevision: 4, enabled: true, candidateParentPath: scope.candidateParentPath, downloadDirectory: scope.downloadDirectory, channel: 'stable', assetName: 'windows.zip', selectedFiles: ['tool.exe', 'LICENSE'], fileRoles: files } });
  const preview = host.querySelector('[aria-label="自动更新许可影响清单"]')!;
  for (const value of [scope.repository, scope.candidateParentPath, scope.downloadDirectory, '稳定版', 'windows.zip', 'tool.exe', '许可证', '不授权新权限']) assert(preview.textContent?.includes(value), value);
  assert.equal(f.changes.length, 0); assert(!f.calls.some(item => item.command.startsWith('apply_')));
  await click(button('确认保存自动更新许可'));
  assert.deepEqual(f.calls.at(-1), { command: 'apply_resource_automation', args: { previewId: 'permission-plan' } }); assert.equal(f.changes.length, 1);
  assert(host.textContent?.includes('本次没有下载、安装或切换')); assert(!f.calls.some(item => /download|invoke|switch|install/.test(item.command)));
});

test('disable confirmation needs no directories or intact current scope and never sends enabled to apply', async () => {
  const f = fixture(command => command === 'resource_automation_status' ? Promise.resolve({ ...status(), authorization: { revision: 3, enabled: true, scope }, currentScope: null, blockedReason: '当前文件缺失，自动更新已暂停' }) : command === 'apply_resource_automation' ? Promise.resolve({ resource: resource(5), authorization: { enabled: false }, saved: true, automaticApplied: false }) : undefined);
  await mount(f); await click(button('自动更新许可')); await click(host.querySelector('input[type="checkbox"]')!); await click(button('预览本次许可'));
  assert.deepEqual(f.calls.at(-1)!.args, { resourceId: 'tool', expectedRevision: 4, enabled: false });
  await click(button('确认撤销自动更新许可')); assert.deepEqual(f.calls.at(-1)!.args, { previewId: 'permission-plan' }); assert(host.textContent?.includes('许可已撤销')); assert.equal(f.changes.length, 1);
});

test('unknown adapter or scope cannot be enabled, while version locks and skipped versions are explicit', async () => {
  const blocked = fixture(command => command === 'resource_automation_status' ? Promise.resolve({ ...status(), currentScope: null, blockedReason: '尚未提供安全适配器' }) : undefined);
  await mount(blocked); await click(button('自动更新许可')); assert(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled); assert(host.textContent?.includes('尚未提供安全适配器')); assert(!host.querySelector('[aria-label="自动更新许可影响清单"]'));
});

test('editing scope after preview discards confirmation and composing Enter cannot submit', async () => {
  const f = fixture(command => command === 'resource_automation_status' ? Promise.resolve({ ...status(), currentScope: { ...status().currentScope, pinnedVersion: 'v3', skippedVersions: ['v4'] } }) : undefined);
  await mount(f); await enableForm(); assert(host.textContent?.includes('锁定版本：v3')); assert(host.textContent?.includes('跳过版本：v4'));
  await click(button('预览本次许可')); await change('精确 ZIP 发行文件名', 'different.zip'); assert(!host.querySelector('[aria-label="自动更新许可影响清单"]'));
  const event = new dom.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }); await act(async () => host.querySelector('form')!.dispatchEvent(event)); assert(event.defaultPrevented);
  assert(!f.calls.some(item => item.command.startsWith('apply_'))); assert.equal(f.changes.length, 0);
});

test('duplicate confirms are one-use and stale save failure drops the permission preview', async () => {
  const pending = deferred<unknown>(); const f = fixture(command => command === 'apply_resource_automation' ? pending.promise : undefined);
  await mount(f); await enableForm(); await click(button('预览本次许可')); const confirm = button('确认保存自动更新许可'); await act(async () => { confirm.click(); confirm.click(); }); assert.equal(f.calls.filter(item => item.command === 'apply_resource_automation').length, 1);
  await act(async () => pending.reject(new Error('预览后原文件或来源已变化，授权未保存')));
  assert(!host.querySelector('[aria-label="自动更新许可影响清单"]')); assert(host.querySelector('[role="alert"]')!.textContent?.includes('授权未保存')); assert.equal(f.changes.length, 0);
});

for (const property of ['visible', 'readOnly']) test(`pending authorization result cannot update hidden/basic drafts (${property})`, async () => {
  const pending = deferred<unknown>(); const f = fixture(command => command === 'apply_resource_automation' ? pending.promise : undefined), view = await mount(f);
  await enableForm(); await click(button('预览本次许可')); await click(button('确认保存自动更新许可'));
  await act(async () => view.render(createElement(ResourceAutomation, { resource: resource(), ...f, [property]: property === 'visible' ? false : true })));
  await act(async () => pending.resolve({ resource: resource(5), authorization: { enabled: true }, saved: true, automaticApplied: false })); assert.equal(host.childElementCount, 0); assert.equal(f.changes.length, 0);
});

test('resource revision changes discard delayed preview and cannot reuse old confirmation', async () => {
  const pending = deferred<unknown>(); const f = fixture(command => command === 'preview_resource_automation' ? pending.promise : undefined), view = await mount(f);
  await enableForm(); await click(button('预览本次许可'));
  await act(async () => view.render(createElement(ResourceAutomation, { resource: resource(9), ...f })));
  await act(async () => pending.resolve(plan())); assert(!host.querySelector('[aria-label="自动更新许可影响清单"]')); assert.equal(f.changes.length, 0); assert.equal(f.calls.length, 2);
});

test('mismatched or blocked preview never exposes a usable permission confirmation', async () => {
  const f = fixture(command => command === 'preview_resource_automation' ? Promise.resolve({ ...plan(), resourceRevision: 99 }) : undefined);
  await mount(f); await enableForm(); await click(button('预览本次许可')); assert(!host.querySelector('[aria-label="自动更新许可影响清单"]')); assert(host.querySelector('[role="alert"]')!.textContent?.includes('工具或选择已变化')); assert.equal(f.changes.length, 0);
});

test('an accepted mode-only resource refresh retains the saved notice without claiming an update ran', async () => {
  const f = fixture(); const view = root(); const onChanged = (value: any) => { f.onChanged(value); view.render(createElement(ResourceAutomation, { resource: value, ...f, onChanged })); };
  await act(async () => view.render(createElement(ResourceAutomation, { resource: resource(), ...f, onChanged })));
  await enableForm(); await click(button('预览本次许可')); await click(button('确认保存自动更新许可'));
  assert(host.textContent?.includes('本次没有下载、安装或切换')); assert.equal(f.changes.length, 1); assert.equal(f.calls.length, 3);
});

test('a stopped metadata check stays visible without claiming files changed or replaying it', async () => {
  const attempt = { id: 'attempt-one', resourceId: 'tool', version: 'v2', status: 'stopped', phase: 'release', updatedAt: '2026-10-30T04:00:00Z', result: { changed: false } };
  const f = fixture(command => command === 'resource_automation_status' ? Promise.resolve({ ...status(), attempts: [attempt] }) : undefined);
  await mount(f); await click(button('自动更新许可'));
  const record = host.querySelector('[aria-label="最近自动更新记录"]')!;
  assert(record.textContent?.includes('已停止')); assert(record.textContent?.includes('读取发行信息')); assert(record.textContent?.includes('不会因刷新或重启重复应用'));
  assert(!record.textContent?.includes('入口已切换')); assert(!record.querySelector('button')); assert.equal(f.calls.length, 1); assert.equal(f.changes.length, 0);
  await click(button('刷新许可')); assert.equal(f.calls.length, 2); assert(f.calls.every(call => call.command === 'resource_automation_status'));
});

for (const [name, result, expected, absent] of [
  ['restored', { changed: true, switched: false, postSwitchVerified: false, rolledBack: true }, '入口切换已撤回', '切换后核验通过'],
  ['blocked rollback', { changed: true, switched: true, postSwitchVerified: false, rolledBack: false }, '核验未完成', '入口切换已撤回'],
] as const) test(`post-switch ${name} displays the actual receipt without inventing recovery`, async () => {
  const attempt = { id: 'attempt-two', resourceId: 'tool', version: 'v2', status: 'stopped', phase: 'switch', updatedAt: '2026-10-30T04:00:00Z', result: { ...result, archivePath: 'D:/synthetic/downloads/release.zip', candidatePath: 'D:/synthetic/versions/v2' } };
  const f = fixture(command => command === 'resource_automation_status' ? Promise.resolve({ ...status(), attempts: [attempt] }) : undefined);
  await mount(f); await click(button('自动更新许可')); const record = host.querySelector('[aria-label="最近自动更新记录"]')!;
  assert(record.textContent?.includes(expected)); assert(!record.textContent?.includes(absent)); assert(record.querySelector('details')?.textContent?.includes(attempt.result.archivePath));
  assert.equal(record.querySelector('details')?.open, false); assert.equal(f.calls.length, 1);
});

test('unfinished journals do not claim a live process and another resource journal is not displayed', async () => {
  const f = fixture(command => command === 'resource_automation_status' ? Promise.resolve({ ...status(), attempts: [
    { id: 'other', resourceId: 'other-tool', version: 'private-other-version', status: 'completed', phase: 'complete', updatedAt: '', result: { switched: true, postSwitchVerified: true } },
    { id: 'pending', resourceId: 'tool', version: 'v2', status: 'running', phase: 'stage', updatedAt: '', result: { changed: true } },
  ] }) : undefined);
  await mount(f); await click(button('自动更新许可')); const record = host.querySelector('[aria-label="最近自动更新记录"]')!;
  assert(record.textContent?.includes('尚无结束回执')); assert(record.textContent?.includes('不能据此确认任务仍在运行')); assert(!host.textContent?.includes('private-other-version')); assert(!record.querySelector('time'));
});

test('a successful switch with a stale later authorization reports both facts distinctly', async () => {
  const f = fixture(command => command === 'resource_automation_status' ? Promise.resolve({ ...status(), attempts: [{ id: 'done', resourceId: 'tool', version: 'v2', status: 'completed', phase: 'complete', updatedAt: '2026-10-30T04:00:00Z', result: { changed: true, switched: true, postSwitchVerified: true, authorizationAdvanced: false } }] }) : undefined);
  await mount(f); await click(button('自动更新许可')); const record = host.querySelector('[aria-label="最近自动更新记录"]')!;
  assert(record.textContent?.includes('切换后核验通过')); assert(record.querySelector('[role="alert"]')?.textContent?.includes('后续自动许可尚未推进')); assert.equal(f.calls.length, 1);
});

test('the original authorization toggle collapses in the same position without another read', async () => {
  const f = fixture(); await mount(f); const toggle = button('自动更新许可'); await click(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true'); await click(toggle);
  assert.equal(button('自动更新许可'), toggle); assert.equal(toggle.getAttribute('aria-expanded'), 'false'); assert(!host.querySelector('[aria-label="自动更新许可 测试工具"]')); assert.equal(f.calls.length, 1);
});

const packageSource = { recipe: 'edgeMcpNpmV1', packageName: '@playwright/mcp', registry: 'https://registry.npmjs.org', runtimePath: 'D:/synthetic/shared/node.exe', runtimeSha256: 'a'.repeat(64), runtimeBindingHash: 'b'.repeat(64) };
const packageScope = { ...scope, assetName: '@playwright/mcp', runtimePackage: { ...packageSource, workDirectory: 'D:/synthetic/work', workDirectoryId: 'owned-work-identity', bytesPerSecond: 2048 } };
const packageStatus = () => ({ ...status(), currentScope: { ...status().currentScope, assetName: packageScope.assetName, runtimePackage: packageSource } });

test('package permission uses server-derived recipe and runtime, explicit work and rate, and separate confirmation', async () => {
  const f = fixture(command => command === 'resource_automation_status' ? Promise.resolve(packageStatus()) : command === 'preview_resource_automation' ? Promise.resolve({ ...plan(), scope: packageScope }) : undefined);
  await mount(f); await enableForm();
  assert.equal(button('预览本次许可').disabled, true);
  assert(!Array.from(host.querySelectorAll('label')).some(label => label.textContent?.startsWith('精确 ZIP')));
  for (const value of [packageSource.packageName, packageSource.registry, packageSource.runtimePath, '当前安装基线范围']) assert(host.textContent?.includes(value), value);
  await change('准备工作目录', packageScope.runtimePackage.workDirectory); await change('下载限速（MiB/s）', '0.001953125');
  await click(button('预览本次许可'));
  assert.deepEqual(f.calls.at(-1), { command: 'preview_resource_automation', args: { resourceId: 'tool', expectedRevision: 4, enabled: true, candidateParentPath: scope.candidateParentPath, downloadDirectory: scope.downloadDirectory, channel: 'stable', workDirectory: packageScope.runtimePackage.workDirectory, bytesPerSecond: 2048, selectedFiles: ['tool.exe', 'LICENSE'], fileRoles: files } });
  assert.equal(f.changes.length, 0); assert(!f.calls.some(item => item.command === 'apply_resource_automation'));
  const preview = host.querySelector('[aria-label="自动更新许可影响清单"]')!;
  for (const value of [packageSource.packageName, packageSource.runtimePath, packageScope.runtimePackage.workDirectory, scope.candidateParentPath, scope.downloadDirectory, '0.001953125 MiB/s']) assert(preview.textContent?.includes(value), value);
  await click(button('确认保存自动更新许可'));
  assert.deepEqual(f.calls.at(-1), { command: 'apply_resource_automation', args: { previewId: 'permission-plan' } }); assert.equal(f.changes.length, 1);
});

test('package rate validates beside its field and never sends an invalid or implicit rate', async () => {
  const f = fixture(command => command === 'resource_automation_status' ? Promise.resolve(packageStatus()) : command === 'preview_resource_automation' ? Promise.resolve({ ...plan(), scope: { ...packageScope, runtimePackage: { ...packageScope.runtimePackage, bytesPerSecond: 0 } } }) : undefined);
  await mount(f); await enableForm(); await change('准备工作目录', packageScope.runtimePackage.workDirectory);
  const rate = host.querySelector<HTMLInputElement>('[aria-label="自动更新下载限速"]')!;
  for (const value of ['', '-1', 'NaN', '0.0000001', '1e-999', '8589934592']) {
    await change('下载限速（MiB/s）', value);
    assert.equal(rate.getAttribute('aria-invalid'), 'true', value);
    assert.equal(button('预览本次许可').disabled, true, value); assert.equal(f.calls.length, 1);
    const note = document.getElementById(rate.getAttribute('aria-describedby')!)!;
    assert(note.textContent?.includes(value === '8589934592' ? '过大' : ['0.0000001', '1e-999'].includes(value) ? '过小' : '非负数'));
  }
  await change('下载限速（MiB/s）', '0'); await click(button('预览本次许可'));
  assert.equal(f.calls.at(-1)?.args.bytesPerSecond, 0); assert(host.querySelector('[aria-label="自动更新许可影响清单"]')?.textContent?.includes('不限速'));
});

for (const bytes of [1, 2048, Number.MAX_SAFE_INTEGER]) test(`existing package rate ${bytes} B/s displays in MiB/s and round-trips without changing consent`, async () => {
  const originalScope = { ...packageScope, runtimePackage: { ...packageScope.runtimePackage, bytesPerSecond: bytes } };
  const f = fixture(command => command === 'resource_automation_status' ? Promise.resolve({ ...packageStatus(), authorization: { revision: 3, enabled: true, scope: originalScope } }) : command === 'preview_resource_automation' ? Promise.resolve({ ...plan(), scope: originalScope }) : undefined);
  await mount(f); await click(button('自动更新许可'));
  const rate = host.querySelector<HTMLInputElement>('[aria-label="自动更新下载限速"]')!;
  assert.equal(rate.value, String(bytes / 1048576)); assert.equal(rate.getAttribute('aria-invalid'), 'false');
  assert.equal(f.calls.length, 1); await click(button('预览本次许可'));
  assert.equal(f.calls.at(-1)?.args.bytesPerSecond, bytes);
  assert.deepEqual(f.calls.at(-1)?.args.fileRoles, files);
  assert.equal(f.calls.at(-1)?.args.candidateParentPath, scope.candidateParentPath);
  await click(button('确认保存自动更新许可'));
  assert.deepEqual(f.calls.at(-1), { command: 'apply_resource_automation', args: { previewId: 'permission-plan' } });
  assert.equal(f.changes.length, 1);
  assert(f.calls.every(call => ['resource_automation_status', 'preview_resource_automation', 'apply_resource_automation'].includes(call.command)));
});

test('automation errors keep the original message without adding an Error prefix', async () => {
  const f = fixture(command => command === 'resource_automation_status' ? Promise.reject(new Error('原运行文件已变化，请重新核对。')) : undefined);
  await mount(f); await click(button('自动更新许可'));
  assert.equal(host.querySelector('[role="alert"]')?.textContent, '原运行文件已变化，请重新核对。');
  assert.equal(f.calls.length, 1);
});

test('an existing package authorization can be revoked without recreating a current package source', async () => {
  const f = fixture(command => command === 'resource_automation_status' ? Promise.resolve({ ...status(), currentScope: null, authorization: { revision: 3, enabled: true, scope: packageScope }, blockedReason: '当前来源尚未核实' }) : command === 'apply_resource_automation' ? Promise.resolve({ resource: resource(5), authorization: { enabled: false }, saved: true, automaticApplied: false }) : undefined);
  await mount(f); await click(button('自动更新许可')); await click(host.querySelector('input[type="checkbox"]')!); await click(button('预览本次许可'));
  assert.deepEqual(f.calls.at(-1)?.args, { resourceId: 'tool', expectedRevision: 4, enabled: false });
  await click(button('确认撤销自动更新许可')); assert.equal(f.changes.length, 1);
});
