import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
let code = ts.transpileModule(await readFile(new URL('../src/ResourceRecovery.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
let sourceCode = ts.transpileModule(await readFile(new URL('../src/ResourceSource.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText.replace(/import\s+['"][^'"]+\.css['"];?/g, '');
sourceCode = sourceCode.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, specifier: string) => `from ${JSON.stringify(import.meta.resolve(specifier))}`);
code = code.replace(/from\s+(['"])\.\/ResourceSource\1/g, `from ${JSON.stringify(`data:text/javascript;base64,${Buffer.from(sourceCode).toString('base64')}`)}`);
code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, specifier: string) => `from ${JSON.stringify(import.meta.resolve(specifier))}`);
const { ResourceRecovery } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const host = document.getElementById('root')!;
let cleanup = () => {};
function root() { const view = createRoot(host); cleanup = () => view.unmount(); return view; }
afterEach(async () => { await act(async () => cleanup()); cleanup = () => {}; });
const path = 'D:/synthetic/resource/v1';
// Matches resource_manifest::recover's actual JSON shape. These are candidate
// facts, not a ResourceRecord, action definition or ownership receipt.
const preview = () => ({ schemaVersion: 1, resourceId: 'record-resource', installationId: '4a324033-7050-4bed-a2e1-120a26343087', kind: 'cli', version: 'v1', source: { repository: 'https://github.com/synthetic/tool', repositoryId: 11, releaseId: 22, assetId: 33, assetName: 'windows.zip', archiveSha256: 'a'.repeat(64) }, recordedComplete: true, canRegister: true, verifiedFiles: [{ path: 'bin/tool.exe', role: 'runtime', bytes: 25, sha256: 'b'.repeat(64) }, { path: 'LICENSE', role: 'license', bytes: 5, sha256: 'c'.repeat(64) }], missingOrUnreadable: [], modifiedFiles: [], unknownFilesRetained: ['private/settings.env'], ownership: 'external', sourceVerified: false, executionGrant: false, deleteGrant: false, automaticUpdateGrant: false, message: '仅为重新登记预览；来源、归属和调用需独立核验，未知及本地修改保留。' });
const packageHint = () => ({ recipe: 'edgeMcpNpmV1', version: '0.0.83', planHash: 'b'.repeat(64), artifacts: [{ bytes: 1234, sha256: 'a'.repeat(64), origin: { kind: 'npmRegistry', package: '@playwright/mcp', version: '0.0.83', tarball: 'https://registry.npmjs.org/@playwright/mcp/-/mcp-0.0.83.tgz', integrity: `sha512-${'A'.repeat(86)}==` } }] });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(override?: () => Promise<unknown>) {
  const calls: { command: string; args: unknown }[] = [], used: any[] = [];
  const action = async (_label: string, command: string, args: unknown) => { calls.push({ command, args }); return override ? override() : preview(); };
  return { calls, used, action, onUse: (value: any) => used.push(value) };
}
const button = (label: string) => Array.from(host.querySelectorAll('button')).find(item => item.textContent === label)!;
async function click(element: Element) { await act(async () => { assert(element); element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); }); }
async function mount(props: any, extra: any = {}) { const view = root(); await act(async () => view.render(createElement(ResourceRecovery, { rootPath: path, ...props, ...extra }))); return view; }

test('package recovery shows unverified source hints without restoring provenance or any permission into registration', async () => {
  const value = { ...preview(), kind: 'mcp', version: '0.0.83', source: { repository: 'https://github.com/microsoft/playwright-mcp', runtimePackage: packageHint() } };
  const f = fixture(async () => value); await mount(f); await click(button('读取资源管理记录'));
  const hints = host.querySelector('[aria-label="未核验的软件包来源提示"]')!;
  for (const text of ['npm 配方', '0.0.83', '@playwright/mcp', 'SHA-256', '尚未核验发布者或共享运行环境', '不会恢复安装归属、执行或自动更新许可']) assert(hints.textContent?.includes(text), text);
  await click(button('用作登记信息'));
  assert.deepEqual(f.used, [{ kind: 'mcp', rootPath: path, repository: 'https://github.com/microsoft/playwright-mcp', version: '0.0.83' }]);
  for (const field of ['runtimePackage', 'installation', 'ownership', 'enabled', 'actions', 'capabilities', 'automaticUpdateGrant']) assert(!(field in f.used[0]), field);
  assert.deepEqual(f.calls.map(call => call.command), ['preview_resource_recover']);
});

test('malformed package source URLs are not rendered or offered as registration hints', async () => {
  const hint = packageHint(); hint.artifacts[0].origin.tarball = 'javascript:alert(1)';
  const f = fixture(async () => ({ ...preview(), source: { repository: 'https://github.com/microsoft/playwright-mcp', runtimePackage: hint } }));
  await mount(f); await click(button('读取资源管理记录')); assert(host.querySelector('[role="alert"]')?.textContent?.includes('预览格式或权限状态异常')); assert(!host.querySelector('[aria-label="资源管理记录预览"]')); assert.equal(f.used.length, 0); assert.equal(host.querySelectorAll('a').length, 0);
});

test('recovery never scans at startup or on root, visibility, or read-only changes', async () => {
  const f = fixture(), view = await mount(f); assert.equal(f.calls.length, 0); assert(!host.querySelector('[aria-label="资源管理记录预览"]'));
  await act(async () => view.render(createElement(ResourceRecovery, { rootPath: path + '-other', ...f }))); assert.equal(f.calls.length, 0);
  await act(async () => view.render(createElement(ResourceRecovery, { rootPath: path, ...f, visible: false }))); assert.equal(host.childElementCount, 0);
  await act(async () => view.render(createElement(ResourceRecovery, { rootPath: path, ...f, readOnly: true }))); assert.equal(host.childElementCount, 0); assert.equal(f.calls.length, 0);
  await act(async () => view.render(createElement(ResourceRecovery, { rootPath: '  ', ...f }))); assert(button('读取资源管理记录').disabled); assert.equal(f.calls.length, 0);
});

test('native preview displays actual recover findings and never overwrites a draft until explicit use', async () => {
  const f = fixture(); const draft = { name: '保留未保存名称', notes: '保留未保存备注', kind: 'portable', rootPath: path, repository: '', version: '' };
  const useDraft = (value: any) => { f.onUse(value); Object.assign(draft, value); };
  await mount({ ...f, onUse: useDraft }, { rootPath: ` ${path} ` }); await click(button('读取资源管理记录'));
  assert.deepEqual(f.calls, [{ command: 'preview_resource_recover', args: { rootPath: path } }]); assert.equal(f.used.length, 0); assert.equal(draft.kind, 'portable');
  const section = host.querySelector('[aria-label="资源管理记录预览"]')!;
  for (const text of [path, 'v1', 'https://github.com/synthetic/tool', 'bin/tool.exe', 'LICENSE', 'private/settings.env', 'b'.repeat(64)]) assert(section.textContent?.includes(text), text);
  const permissions = host.querySelector('[aria-label="接管权限状态"]')!.textContent!;
  for (const text of ['来源身份', '尚未独立核验', '执行权限', '删除权限', '自动更新', '未授权']) assert(permissions.includes(text), text);
  await click(button('用作登记信息'));
  assert.deepEqual(f.used, [{ kind: 'cli', rootPath: path, repository: 'https://github.com/synthetic/tool', version: 'v1' }]);
  assert.equal(draft.name, '保留未保存名称'); assert.equal(draft.notes, '保留未保存备注'); assert.equal(draft.kind, 'cli');
  assert(host.querySelector('[role="status"]')!.textContent?.includes('尚未登记或授权')); assert(button('用作登记信息').disabled);
  assert.equal(f.calls.length, 1); assert(!f.calls.some(item => /register|invoke|apply|delete|update/.test(item.command)));
});

test('partial, missing and modified files are visible and block use while unknown files remain', async () => {
  const value = { ...preview(), recordedComplete: false, canRegister: false, missingOrUnreadable: ['missing.dll'], modifiedFiles: ['bin/tool.exe'] };
  const f = fixture(async () => value); await mount(f); await click(button('读取资源管理记录'));
  assert(host.textContent?.includes('管理记录标记为部分完成')); assert(host.querySelector('[aria-label="缺失或不可读取"]')!.textContent?.includes('missing.dll'));
  assert(host.querySelector('[aria-label="本地已修改"]')!.textContent?.includes('bin/tool.exe')); assert(host.querySelector('[aria-label="其余文件，原位保留"]')!.textContent?.includes('settings.env'));
  assert(button('用作登记信息').disabled); assert.equal(f.used.length, 0); assert.equal(f.calls.length, 1);
});

for (const field of ['executionGrant', 'deleteGrant', 'automaticUpdateGrant', 'sourceVerified']) test(`receipt cannot restore a forged ${field}`, async () => {
  const f = fixture(async () => ({ ...preview(), [field]: true })); await mount(f); await click(button('读取资源管理记录'));
  assert(host.querySelector('[role="alert"]')!.textContent?.includes('权限状态异常')); assert(!host.querySelector('[aria-label="资源管理记录预览"]')); assert.equal(f.used.length, 0); assert.equal(f.calls.length, 1);
});

test('changing root discards a delayed response and a new explicit read uses the new path', async () => {
  const pending = deferred<unknown>(); let read = 0; const f = fixture(() => ++read === 1 ? pending.promise : Promise.resolve(preview())); const view = await mount(f);
  await click(button('读取资源管理记录'));
  await act(async () => view.render(createElement(ResourceRecovery, { rootPath: path + '-new', ...f })));
  await act(async () => pending.resolve(preview()));
  assert(!host.querySelector('[aria-label="资源管理记录预览"]')); assert.equal(f.used.length, 0); assert.equal(f.calls.length, 1);
  await click(button('读取资源管理记录')); assert.deepEqual(f.calls.at(-1)!.args, { rootPath: path + '-new' });
  await click(button('用作登记信息')); assert.equal(f.used[0].rootPath, path + '-new');
});

for (const mode of [{ visible: false }, { readOnly: true }]) test(`pending response is ignored after ${Object.keys(mode)[0]} and never auto-applies later`, async () => {
  const pending = deferred<unknown>(); const f = fixture(() => pending.promise), view = await mount(f);
  await click(button('读取资源管理记录'));
  await act(async () => view.render(createElement(ResourceRecovery, { rootPath: path, ...f, ...mode })));
  await act(async () => pending.resolve(preview())); assert.equal(host.childElementCount, 0); assert.equal(f.used.length, 0);
  await act(async () => view.render(createElement(ResourceRecovery, { rootPath: path, ...f })));
  assert(!host.querySelector('[aria-label="资源管理记录预览"]')); assert.equal(f.calls.length, 1);
});

test('duplicate reads and duplicate use clicks do not scan or fill twice', async () => {
  const pending = deferred<unknown>(); const f = fixture(() => pending.promise); await mount(f);
  const read = button('读取资源管理记录'); await act(async () => { read.click(); read.click(); }); assert.equal(f.calls.length, 1);
  await act(async () => pending.resolve(preview())); const use = button('用作登记信息');
  await act(async () => { use.click(); use.click(); }); assert.equal(f.used.length, 1); assert.equal(f.calls.length, 1);
});

test('read errors and malformed responses do not retain old results or fabricate permissions', async () => {
  let turn = 0; const f = fixture(async () => { turn++; if (turn === 1) return preview(); if (turn === 2) throw new Error('管理记录的对象身份已变化'); return { ...preview(), verifiedFiles: null }; });
  await mount(f); await click(button('读取资源管理记录')); assert(host.querySelector('[aria-label="资源管理记录预览"]'));
  await click(button('读取资源管理记录')); assert(host.querySelector('[role="alert"]')!.textContent?.includes('对象身份已变化')); assert(!host.querySelector('[aria-label="资源管理记录预览"]'));
  await click(button('读取资源管理记录')); assert(host.querySelector('[role="alert"]')!.textContent?.includes('预览格式')); assert.equal(f.used.length, 0);
});

test('large findings render only the first 100 entries until the user expands them', async () => {
  const value = { ...preview(), unknownFilesRetained: Array.from({ length: 205 }, (_, index) => `personal/file-${index}.txt`) };
  const f = fixture(async () => value); await mount(f); await click(button('读取资源管理记录'));
  const findings = host.querySelector('[aria-label="其余文件，原位保留"]')!; assert.equal(findings.querySelectorAll('li').length, 100);
  await click(Array.from(findings.querySelectorAll('button'))[0]); assert.equal(findings.querySelectorAll('li').length, 200); assert.equal(f.calls.length, 1); assert.equal(f.used.length, 0);
  await click(button('收起预览')); assert(!host.querySelector('[aria-label="资源管理记录预览"]')); assert.equal(f.calls.length, 1);
});

test('nullable source and version stay unknown and no invented name or source claims enter the draft', async () => {
  const f = fixture(async () => ({ ...preview(), kind: 'mcp', version: null, source: null })); await mount(f); await click(button('读取资源管理记录')); await click(button('用作登记信息'));
  assert.deepEqual(f.used, [{ kind: 'mcp', rootPath: path }]); assert(!('name' in f.used[0])); assert(!('ownership' in f.used[0])); assert(!('capabilities' in f.used[0])); assert(!('installationId' in f.used[0]));
});
