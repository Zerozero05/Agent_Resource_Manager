import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import type { Resource } from '../src/resources.ts';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const stub = (code: string) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const packageInfo = { archivePath: 'D:/synthetic/downloads/v2.zip', unpackedBytes: 42, files: [{ path: 'tool.exe', bytes: 20, license: false }, { path: 'library.dll', bytes: 18, license: false }, { path: 'LICENSE', bytes: 4, license: true }] };
const github = stub(`import {createElement} from ${JSON.stringify(import.meta.resolve('react'))}; export function ResourceGithub(props){return createElement('button',{type:'button',disabled:props.disabled,onClick:()=>props.onDownloaded(${JSON.stringify({ ...packageInfo, downloadId: 'verified-download', source: { repository: 'https://github.com/synthetic/tool', version: 'v2', verification: 'githubDigest' } })})},'模拟已确认下载');}`);
const dialog = stub('export async function open(){ return "D:/synthetic/chosen-parent"; }');
const modules = new Map<string, Promise<string>>();
async function moduleURL(url: URL): Promise<string> {
  const existing = modules.get(url.href); if (existing) return existing;
  const loading = (async () => {
    let code = ts.transpileModule(await readFile(url, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const replacements = new Map<string, string>();
    for (const match of code.matchAll(/from\s+(['"])([^'"]+)\1/g)) {
      const specifier = match[2]; if (replacements.has(specifier)) continue;
      let target: string;
      if (specifier === './ResourceGithub') target = github;
      else if (specifier === '@tauri-apps/plugin-dialog') target = dialog;
      else if (specifier.startsWith('.')) {
        let path = new URL(/\.tsx?$/.test(specifier) ? specifier : specifier + '.ts', url);
        try { await access(path); } catch { path = new URL(specifier + '.tsx', url); }
        target = await moduleURL(path);
      } else target = import.meta.resolve(specifier);
      replacements.set(specifier, target);
    }
    code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, specifier: string) => `from ${JSON.stringify(replacements.get(specifier))}`);
    return stub(code);
  })(); modules.set(url.href, loading); return loading;
}
const { ResourceUpdate } = await import(await moduleURL(new URL('../src/ResourceUpdate.tsx', import.meta.url)));
const host = document.getElementById('root')!;
let cleanup = () => {};
function root() { const value = createRoot(host); cleanup = () => value.unmount(); return value; }
afterEach(async () => { await act(async () => cleanup()); cleanup = () => {}; });
const resource = (revision = 4): Resource => ({ id: 'tool', name: '测试工具', kind: 'cli', rootPath: 'D:/synthetic/tool/v1', repository: 'https://github.com/synthetic/tool', version: 'v1', alias: '', notes: '', enabled: true, ownership: 'managed', revision, managementScope: 'ownedFiles', actions: [], capabilities: [], createdAt: '', updatedAt: '' });
const stage = { id: 'stage-plan', kind: 'resourceUpdateStage', resourceId: 'tool', resourceRevision: 4, originalPath: 'D:/synthetic/tool/v1', targetPath: 'D:/synthetic/tool/v2', archivePath: packageInfo.archivePath, version: 'v2', selectedBytes: 42, files: { 'tool.exe': 'runtime', 'library.dll': 'privateDependency', LICENSE: 'license' }, changes: [{ path: 'tool.exe', baselineSha256: 'base-hash', localSha256: 'local-hash', upstreamSha256: 'upstream-hash', localModified: true, upstreamChanged: true }], canApply: true, warnings: ['原版本和本地改造保留，不复制用户数据。'] };
const candidate = (complete = true) => ({ root: stage.targetPath, version: 'v2', archivePath: packageInfo.archivePath, complete, error: complete ? null : '发行文件写入失败', files: [{ path: 'tool.exe', role: 'runtime' }], createdPaths: [stage.targetPath + '/tool.exe'], validation: null });
function withState(revision: number, state: any) { return { ...resource(revision), installation: { updateState: state } }; }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(override?: (command: string, args: any) => Promise<unknown> | undefined) {
  const calls: { command: string; args: any }[] = [], changes: Resource[] = [];
  const action = async (_label: string, command: string, args: any) => {
    calls.push({ command, args }); const result = override?.(command, args); if (result) return result;
    if (command === 'resource_package_inspect') return packageInfo;
    if (command === 'preview_resource_update') return stage;
    if (command === 'resource_update_state') return { resource: resource(), updateState: null };
    if (command === 'apply_resource_update_stage') return { resource: withState(5, { candidate: candidate(), previous: [] }), staged: true, complete: true, switched: false };
    throw new Error(`Unexpected action: ${command}`);
  };
  return { calls, changes, action, onChanged: (value: Resource) => changes.push(value) };
}
const button = (text: string) => Array.from(host.querySelectorAll('button')).find(item => item.textContent === text)!;
async function click(element: Element) { await act(async () => { assert(element); element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); }); }
async function input(label: string, value: string) {
  const field = Array.from(host.querySelectorAll('label')).find(item => item.textContent?.startsWith(label))!.querySelector('input')!;
  await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
}
async function select(label: string, value: string) {
  const field = Array.from(host.querySelectorAll('label')).find(item => item.textContent?.startsWith(label))!.querySelector('select')!;
  await act(async () => { field.value = value; field.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
}
async function mount(props: any, extra: any = {}) { const view = root(); await act(async () => view.render(createElement(ResourceUpdate, { resource: resource(), ...props, ...extra }))); return view; }
async function prepare() {
  await click(button('更新运行版本')); await input('候选版本 ZIP', packageInfo.archivePath); await click(button('读取文件清单'));
  await input('固定版本', 'v2'); await input('候选保存目录', stage.targetPath); await click(button('全选文件')); await select('文件用途：library.dll', 'privateDependency');
}

test('4098-file update keeps controls and preview rows bounded while preserving all files, global selection and off-page roles', async () => {
  const files = [{ path: 'LICENSE', bytes: 4, license: true }, ...Array.from({ length: 4096 }, (_, index) => ({ path: `runtime/file-${String(index).padStart(4, '0')}.bin`, bytes: 16, license: false })), { path: 'licenses/NOTICE', bytes: 4, license: true }];
  const inventory = { ...packageInfo, files, unpackedBytes: files.reduce((total, file) => total + file.bytes, 0) };
  const first = files[1].path, last = files.at(-2)!.path;
  const expectedRoles = Object.fromEntries(files.filter(file => !file.license).map(file => [file.path, file.path === first || file.path === last ? 'privateDependency' : 'runtime']));
  const largeStage = { ...stage, id: 'full-large-plan', selectedBytes: inventory.unpackedBytes, files: Object.fromEntries(files.map(file => [file.path, file.license ? 'license' : expectedRoles[file.path]])), changes: files.map(file => ({ ...stage.changes[0], path: file.path })) };
  const f = fixture(command => command === 'resource_package_inspect' ? Promise.resolve(inventory) : command === 'preview_resource_update' ? Promise.resolve(largeStage) : undefined);
  await mount(f); await click(button('更新运行版本')); await input('候选版本 ZIP', inventory.archivePath); await click(button('读取文件清单'));
  await input('固定版本', 'v2'); await input('候选保存目录', stage.targetPath);
  const fileList = () => host.querySelector('[aria-label="候选运行文件"]')!;
  const checkbox = (path: string) => Array.from(fileList().querySelectorAll('label')).find(label => label.querySelector('span')?.textContent === path)?.querySelector('input') as HTMLInputElement | undefined;
  const pager = (label: string) => host.querySelector(`[aria-label="${label}分页"]`)!;
  const next = (label: string) => host.querySelector(`[aria-label="下一页${label}"]`)!;
  const previous = (label: string) => host.querySelector(`[aria-label="上一页${label}"]`)!;
  const boundedControls = () => {
    assert(fileList().querySelectorAll('input[type="checkbox"]').length <= 50);
    assert(fileList().querySelectorAll('select').length <= 50);
    assert(fileList().querySelectorAll('*').length < 600);
  };
  assert.equal(fileList().querySelectorAll('input[type="checkbox"]').length, 50);
  assert(pager('候选文件').textContent?.includes('1–50 / 4098'));
  assert(previous('候选文件').matches(':disabled'));
  assert(checkbox('LICENSE')!.checked); assert(checkbox('LICENSE')!.disabled);
  assert(!checkbox('licenses/NOTICE')); assert(!checkbox(last));
  await click(button('全选文件')); boundedControls();
  assert.equal(fileList().querySelectorAll('select').length, 49);
  await select(`文件用途：${first}`, 'privateDependency');
  await click(next('候选文件'));
  assert(!checkbox(first)); assert(checkbox(files[50].path)!.checked); boundedControls();
  await click(checkbox(files[50].path)!);
  await click(previous('候选文件'));
  assert.equal(Array.from(fileList().querySelectorAll('select')).find(field => field.closest('label')?.textContent?.includes(first))!.value, 'privateDependency');
  await input('筛选候选文件', files[50].path); assert(!checkbox(files[50].path)!.checked);
  await input('筛选候选文件', last); assert(checkbox(last)!.checked);
  await select(`文件用途：${last}`, 'privateDependency');
  await input('筛选候选文件', 'no-matching-file');
  assert.equal(fileList().querySelectorAll('input,select').length, 0);
  assert(previous('候选文件').matches(':disabled')); assert(next('候选文件').matches(':disabled'));
  await click(button('仅保留许可证'));
  assert(button('预览候选版本').disabled);
  await input('筛选候选文件', 'licenses/NOTICE');
  assert(checkbox('licenses/NOTICE')!.checked); assert(checkbox('licenses/NOTICE')!.disabled);
  await click(button('全选文件'));
  await input('筛选候选文件', last);
  assert.equal(fileList().querySelector('select')!.value, 'privateDependency');
  await input('筛选候选文件', '');
  assert(pager('候选文件').textContent?.includes('1–50 / 4098'));
  assert.equal(fileList().querySelector('select')!.value, 'privateDependency'); boundedControls();
  await click(button('预览候选版本'));
  assert.deepEqual(f.calls.find(item => item.command === 'preview_resource_update')!.args, { id: 'tool', expectedRevision: 4, archivePath: inventory.archivePath, destinationPath: stage.targetPath, version: 'v2', selectedFiles: files.map(file => file.path), fileRoles: expectedRoles });
  const preview = () => host.querySelector('[aria-label="版本更新影响清单"]')!;
  const previewRows = () => preview().querySelector('[aria-label="候选完整文件路径"]')!;
  const changeRows = () => preview().querySelector('[aria-label="当前文件与上游差异"]')!;
  assert.equal(previewRows().children.length, 50); assert.equal(changeRows().children.length, 50);
  assert(pager('预览文件').textContent?.includes('1–50 / 4098'));
  assert(pager('文件差异').textContent?.includes('1–50 / 4098'));
  await click(preview().querySelector('summary')!);
  for (let page = 1; page < 82; page++) {
    await click(next('预览文件')); await click(next('文件差异'));
    assert(previewRows().children.length <= 50); assert(changeRows().children.length <= 50);
  }
  assert.equal(previewRows().children.length, 48); assert.equal(changeRows().children.length, 48);
  assert(previewRows().textContent?.includes('D:/synthetic/tool/v2/licenses/NOTICE'));
  assert(changeRows().textContent?.includes(last));
  assert(next('预览文件').matches(':disabled')); assert(next('文件差异').matches(':disabled'));
  await input('筛选候选文件', last);
  assert(preview());
  await select(`文件用途：${last}`, 'runtime');
  assert(!preview());
  await select(`文件用途：${last}`, 'privateDependency');
  await click(button('预览候选版本'));
  assert.deepEqual(f.calls.filter(item => item.command === 'preview_resource_update').at(-1)!.args.fileRoles, expectedRoles);
  assert(pager('预览文件').textContent?.includes('1–50 / 4098'));
  assert(pager('文件差异').textContent?.includes('1–50 / 4098'));
  await click(button('确认准备这些文件'));
  assert.deepEqual(f.calls.at(-1), { command: 'apply_resource_update_stage', args: { previewId: 'full-large-plan' } });
  assert.equal(f.calls.filter(item => item.command === 'apply_resource_update_stage').length, 1);
});

test('a replacement package resets file filtering and pagination without carrying old selections or roles', async () => {
  const files = Array.from({ length: 100 }, (_, index) => ({ path: `old-${index}.bin`, bytes: 1, license: false }));
  let inspected = 0;
  const f = fixture(command => command === 'resource_package_inspect' && ++inspected === 1 ? Promise.resolve({ ...packageInfo, files }) : undefined);
  await mount(f); await click(button('更新运行版本')); await input('候选版本 ZIP', 'D:/synthetic/old.zip'); await click(button('读取文件清单'));
  await click(button('全选文件'));
  await click(host.querySelector('[aria-label="下一页候选文件"]')!);
  await input('筛选候选文件', 'old-99');
  await select('文件用途：old-99.bin', 'privateDependency');
  await input('候选版本 ZIP', packageInfo.archivePath); await click(button('读取文件清单'));
  const search = host.querySelector('input[type="search"]') as HTMLInputElement;
  assert.equal(search.value, '');
  const list = host.querySelector('[aria-label="候选运行文件"]')!;
  assert.equal(list.querySelectorAll('input').length, 3);
  assert.equal(list.querySelectorAll('input:checked').length, 1);
  assert.equal(list.querySelectorAll('select').length, 0);
  assert(host.querySelector('[aria-label="候选文件分页"]')!.textContent?.includes('1–3 / 3'));
});

test('update panel has no startup, open, hidden, or read-only I/O', async () => {
  const f = fixture(), view = await mount(f); assert.equal(f.calls.length, 0);
  await click(button('更新运行版本')); assert.equal(f.calls.length, 0);
  await act(async () => view.render(createElement(ResourceUpdate, { resource: resource(), ...f, visible: false })));
  assert.equal(host.childElementCount, 0); assert.equal(f.calls.length, 0);
  await act(async () => view.render(createElement(ResourceUpdate, { resource: resource(), ...f, readOnly: true })));
  assert.equal(host.childElementCount, 0); assert.equal(f.calls.length, 0);
});

test('local package selects files and roles, keeps licenses and previews exact paths and three-way hashes', async () => {
  const f = fixture(); await mount(f); await prepare();
  const license = Array.from(host.querySelectorAll('label')).find(item => item.textContent?.startsWith('LICENSE'))!.querySelector('input')!;
  assert(license.checked); assert(license.disabled);
  await click(button('预览候选版本'));
  assert.deepEqual(f.calls.find(item => item.command === 'preview_resource_update')!.args, { id: 'tool', expectedRevision: 4, archivePath: packageInfo.archivePath, destinationPath: stage.targetPath, version: 'v2', selectedFiles: ['tool.exe', 'library.dll', 'LICENSE'], fileRoles: { 'tool.exe': 'runtime', 'library.dll': 'privateDependency' } });
  const preview = host.querySelector('[aria-label="版本更新影响清单"]')!;
  for (const text of [stage.originalPath, stage.targetPath, packageInfo.archivePath, 'D:/synthetic/tool/v2/library.dll', 'base-hash', 'local-hash', 'upstream-hash', '本地有修改', '上游内容有变化']) assert(preview.textContent?.includes(text), text);
  assert.equal(f.changes.length, 0);
  await click(button('确认准备这些文件'));
  assert.deepEqual(f.calls.at(-1), { command: 'apply_resource_update_stage', args: { previewId: stage.id } });
  assert.equal(f.changes.length, 1);
  assert(host.querySelector('[aria-label="本次版本更新结果"]')!.textContent?.includes('尚未切换运行入口'));
  assert(!f.calls.some(item => item.command === 'verify_resource_update' || item.command.includes('_switch')));
  assert(host.querySelector('[aria-label="待处理候选版本"]'));
});

test('GitHub flow reuses the confirmed download receipt and fixed version without automatic staging', async () => {
  const f = fixture(); await mount(f); await click(button('更新运行版本')); await click(button('GitHub 发行版')); await click(button('模拟已确认下载'));
  assert.equal(f.calls.length, 0);
  const version = Array.from(host.querySelectorAll('label')).find(item => item.textContent?.startsWith('固定版本'))!.querySelector('input')!;
  assert.equal(version.value, 'v2'); assert(version.disabled);
  await input('候选保存目录', stage.targetPath); await click(button('全选文件')); await click(button('预览候选版本'));
  assert.equal(f.calls[0].args.downloadId, 'verified-download'); assert.equal(f.calls[0].args.version, 'v2');
  assert(!('repository' in f.calls[0].args)); assert.equal(f.calls.length, 1);
});

test('candidate verification uses native adapter arguments, then separately previews and confirms one switch', async () => {
  const initial = { candidate: candidate(), previous: [] }, verified = { ...initial, candidate: { ...candidate(), validation: { adapter: 'isolated-help', verifiedAt: '2026-10-30T00:00:00Z' } } };
  const f = fixture(command => {
    if (command === 'resource_update_state') return Promise.resolve({ resource: resource(5), updateState: initial });
    if (command === 'verify_resource_update') return Promise.resolve({ resource: withState(6, verified), verified: true, switched: false });
    if (command === 'preview_resource_update_switch') return Promise.resolve({ ...stage, id: 'switch-plan', kind: 'resourceUpdateSwitch', resourceRevision: 6 });
    if (command === 'apply_resource_update_switch') return Promise.resolve({ resource: { ...withState(7, { candidate: null, previous: [{ root: stage.originalPath, version: 'v1', reason: '切换时原样保留' }] }), rootPath: stage.targetPath, version: 'v2' }, switched: true, complete: true });
  });
  await mount(f, { resource: resource(5) }); await click(button('更新运行版本')); await click(button('读取更新记录'));
  await click(button('验证候选入口'));
  assert.deepEqual(f.calls.at(-1), { command: 'verify_resource_update', args: { id: 'tool', expectedRevision: 5 } });
  assert(!Object.keys(f.calls.at(-1)!.args).some(key => /verified|validation|boolean/i.test(key)));
  await click(button('预览切换')); assert.equal(f.calls.at(-1)!.args.expectedRevision, 6);
  assert(!f.calls.some(item => item.command === 'apply_resource_update_switch'));
  await click(button('确认切换运行入口'));
  assert.deepEqual(f.calls.at(-1), { command: 'apply_resource_update_switch', args: { previewId: 'switch-plan' } });
  assert(host.querySelector('[aria-label="本次版本更新结果"]')!.textContent?.includes('运行入口已切换'));
  assert(host.textContent?.includes('保留的原运行版本（1）')); assert(host.textContent?.includes(stage.originalPath));
});

test('verification failure and blocked switch preserve failure reasons and never bypass validation', async () => {
  const f = fixture(command => {
    if (command === 'resource_update_state') return Promise.resolve({ resource: resource(), updateState: { candidate: candidate(), previous: [] } });
    if (command === 'verify_resource_update') return Promise.reject(new Error('本地改造不能通过此适配器隔离验证'));
    if (command === 'preview_resource_update_switch') return Promise.resolve({ ...stage, kind: 'resourceUpdateSwitch', canApply: false, warnings: ['候选未通过隔离验证'] });
  });
  await mount(f); await click(button('更新运行版本')); await click(button('读取更新记录')); await click(button('验证候选入口'));
  assert(host.querySelector('[role="alert"]')!.textContent?.includes('本地改造不能通过此适配器隔离验证'));
  assert(host.querySelector('[aria-label="待处理候选版本"]'));
  await click(button('预览切换')); assert(button('确认切换运行入口').disabled); assert(host.textContent?.includes('候选未通过隔离验证'));
  assert.equal(f.changes.length, 0); assert(!f.calls.some(item => item.command === 'apply_resource_update_switch'));
});

test('incomplete candidate can be abandoned after preview while files and history remain, then a new directory can be prepared', async () => {
  const failed = candidate(false), retained = { candidate: null, previous: [], retainedCandidates: [{ candidate: failed, reason: '文件原位保留' }], lastFailure: null };
  const f = fixture(command => {
    if (command === 'resource_update_state') return Promise.resolve({ resource: resource(), updateState: { candidate: failed, previous: [], lastFailure: '候选写入中断' } });
    if (command === 'preview_resource_update_abandon') return Promise.resolve({ ...stage, id: 'abandon-plan', kind: 'resourceUpdateAbandon', createdPaths: failed.createdPaths, warnings: ['候选文件和归属原位保留，不删除'] });
    if (command === 'apply_resource_update_abandon') return Promise.resolve({ resource: withState(5, retained), complete: true, abandoned: true, switched: false, filesRetained: true, deleted: [] });
  });
  await mount(f); await click(button('更新运行版本')); await click(button('读取更新记录'));
  assert(button('验证候选入口').disabled); assert(host.textContent?.includes('候选写入中断'));
  await click(button('结束候选流程')); assert(host.querySelector('[aria-label="保留的候选路径"]')!.textContent?.includes(failed.createdPaths[0]));
  assert(!f.calls.some(item => item.command.startsWith('apply_'))); await click(button('确认结束并保留文件'));
  assert.deepEqual(f.calls.at(-1), { command: 'apply_resource_update_abandon', args: { previewId: 'abandon-plan' } });
  assert(host.textContent?.includes('已结束并保留的候选（1）')); assert(host.querySelector('form'));
  const directory = Array.from(host.querySelectorAll('input')).find(item => item.placeholder.startsWith('D:')); assert(!directory);
  assert(!f.calls.some(item => /delete|remove|clean|invoke/.test(item.command)));
});

test('stage ownership-save failure exposes retained paths and has no automatic retry or switch', async () => {
  const f = fixture(command => command === 'apply_resource_update_stage' ? Promise.resolve({ complete: false, staged: true, switched: false, ownershipSaved: false, error: '保存归属记录失败', receipt: { createdPaths: [stage.targetPath + '/tool.exe'], error: '保存归属记录失败' } }) : undefined);
  await mount(f); await prepare(); await click(button('预览候选版本')); await click(button('确认准备这些文件'));
  assert(host.textContent?.includes('归属记录保存失败')); assert(host.textContent?.includes(stage.targetPath + '/tool.exe'));
  assert(!host.querySelector('[aria-label="版本更新影响清单"]')); assert.equal(f.changes.length, 0);
  assert.equal(f.calls.filter(item => item.command.startsWith('apply_')).length, 1);
});

test('changing a stage input discards the preview and IME Enter cannot submit', async () => {
  const f = fixture(); await mount(f); await prepare(); await click(button('预览候选版本'));
  await input('固定版本', 'v3'); assert(!host.querySelector('[aria-label="版本更新影响清单"]'));
  const event = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true });
  await act(async () => host.querySelector('form')!.dispatchEvent(event)); assert(event.defaultPrevented);
  assert(!f.calls.some(item => item.command.startsWith('apply_')));
});

test('a changed resource revision invalidates a delayed preview and later calls use the current revision', async () => {
  const pending = deferred<unknown>();
  const f = fixture(command => command === 'preview_resource_update' ? pending.promise : undefined), view = await mount(f);
  await prepare(); await click(button('预览候选版本'));
  await act(async () => view.render(createElement(ResourceUpdate, { resource: resource(9), ...f })));
  await act(async () => pending.resolve(stage));
  assert(!host.querySelector('[aria-label="版本更新影响清单"]')); assert.equal(f.changes.length, 0);
  await click(button('预览候选版本')); assert.equal(f.calls.at(-1)!.args.expectedRevision, 9);
});

for (const constraint of [{ visible: false }, { readOnly: true }]) test(`hidden/basic transition ignores pending update receipt (${Object.keys(constraint)[0]})`, async () => {
  const pending = deferred<unknown>();
  const f = fixture(command => command === 'apply_resource_update_stage' ? pending.promise : undefined), view = await mount(f);
  await prepare(); await click(button('预览候选版本')); await click(button('确认准备这些文件'));
  await act(async () => view.render(createElement(ResourceUpdate, { resource: resource(), ...f, ...constraint })));
  await act(async () => pending.resolve({ resource: withState(5, { candidate: candidate(), previous: [] }), staged: true, complete: true }));
  assert.equal(host.childElementCount, 0); assert.equal(f.changes.length, 0);
  assert(!f.calls.some(item => item.command.includes('_switch') || item.command === 'verify_resource_update'));
});

test('double confirmation submits once and stale apply failure discards its one-use preview', async () => {
  const pending = deferred<unknown>(); const f = fixture(command => command === 'apply_resource_update_stage' ? pending.promise : undefined);
  await mount(f); await prepare(); await click(button('预览候选版本'));
  const confirm = button('确认准备这些文件');
  await act(async () => { confirm.click(); confirm.click(); });
  assert.equal(f.calls.filter(item => item.command === 'apply_resource_update_stage').length, 1);
  await act(async () => pending.reject(new Error('预览后文件已变化，请重新预览')));
  assert(host.querySelector('[role="alert"]')!.textContent?.includes('预览后文件已变化'));
  assert(!host.querySelector('[aria-label="版本更新影响清单"]')); assert.equal(f.changes.length, 0);
});

for (const rolledBack of [true, false]) test(`post-switch failure shows actual rollback outcome (${rolledBack}) and keeps exact reasons`, async () => {
  const before = { candidate: candidate(), previous: [] };
  const reason = '共享运行环境在核对期间已被更换';
  const after = { candidate: candidate(), previous: [], switchCheck: { status: rolledBack ? 'rolledBack' : 'rollbackBlocked', checkedAt: '2026-10-30T00:00:00Z', verifiedScopes: [], error: '切换后入口验证失败' } };
  const f = fixture(async command => {
    if (command === 'resource_update_state') return { resource: withState(4, before), updateState: before };
    if (command === 'preview_resource_update_switch') return { ...stage, id: 'switch-plan', kind: 'resourceUpdateSwitch' };
    if (command === 'apply_resource_update_switch') return { resource: withState(5, after), complete: false, switched: !rolledBack, rolledBack, error: '切换后入口验证失败', ...(rolledBack ? {} : { rollbackBlockedReason: reason }) };
    throw new Error(`Unexpected ${command}`);
  });
  await mount(f); await click(button('更新运行版本')); await click(button('读取更新记录'));
  await click(button('预览切换')); await click(button('确认切换运行入口'));
  const result = host.querySelector('[aria-label="本次版本更新结果"]')!;
  assert(result.textContent?.includes(rolledBack ? '入口已恢复' : '未自动恢复入口'));
  assert(!result.textContent?.includes('运行入口已切换'));
  assert(host.querySelector('[aria-label="最近入口切换核对"]')!.textContent?.includes(rolledBack ? '原入口已恢复，运行自检通过' : '未自动恢复入口'));
  if (!rolledBack) assert(host.textContent?.includes(reason));
  assert.equal(f.calls.filter(call => call.command === 'apply_resource_update_switch').length, 1);
});

test('restored entry with an unverified runtime has a distinct result and persisted status', async () => {
  const reason = '恢复入口后的只读自检未通过：版本输出不匹配';
  const before = { candidate: candidate(), previous: [] };
  const after = { candidate: candidate(), previous: [], switchCheck: { status: 'rollbackUnverified', checkedAt: '2026-10-30T00:00:00Z', verifiedScopes: [], error: reason } };
  const f = fixture(async command => {
    if (command === 'resource_update_state') return { resource: withState(4, before), updateState: before };
    if (command === 'preview_resource_update_switch') return { ...stage, kind: 'resourceUpdateSwitch' };
    if (command === 'apply_resource_update_switch') return { resource: withState(5, after), complete: false, switched: false, rolledBack: false, entryRestored: true, rollbackVerified: false, error: '切换后入口验证失败', rollbackBlockedReason: reason };
    throw new Error(`Unexpected ${command}`);
  });
  await mount(f); await click(button('更新运行版本')); await click(button('读取更新记录'));
  await click(button('预览切换')); await click(button('确认切换运行入口'));
  const result = host.querySelector('[aria-label="本次版本更新结果"]')!;
  assert(result.textContent?.includes('原入口已恢复，运行未核实'));
  assert(!result.textContent?.includes('未自动恢复入口'));
  assert(!result.textContent?.includes('运行自检通过'));
  const persisted = host.querySelector('[aria-label="最近入口切换核对"]')!;
  assert(persisted.textContent?.includes('原入口已恢复，运行未核实'));
  assert(persisted.textContent?.includes(reason));
  assert(host.textContent?.includes(reason));
  assert.equal(f.calls.filter(call => call.command === 'apply_resource_update_switch').length, 1);
});
