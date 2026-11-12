import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { createElement, act } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const modules = new Map<string, Promise<string>>();
async function moduleURL(url: URL): Promise<string> {
  const cached = modules.get(url.href); if (cached) return cached;
  const loading = (async () => {
    let code = ts.transpileModule(await readFile(url, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText.replace(/import\s+['"][^'"]+\.css['"];?/g, '');
    const replacements = new Map<string, string>();
    for (const match of code.matchAll(/from\s+(['"])([^'"]+)\1/g)) {
      const value = match[2];
      if (!replacements.has(value)) {
        let target: string;
        if (value.startsWith('.')) {
          let path = new URL(/\.tsx?$/.test(value) ? value : value + '.ts', url);
          try { await access(path); } catch { path = new URL(value + '.tsx', url); }
          target = await moduleURL(path);
        } else target = import.meta.resolve(value);
        replacements.set(value, target);
      }
    }
    code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, value) => `from ${JSON.stringify(replacements.get(value))}`);
    return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  })(); modules.set(url.href, loading); return loading;
}
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const { ResourceRepair } = await import(await moduleURL(new URL('../src/ResourceRepair.tsx', import.meta.url)));
const { ResourcePanel } = await import(await moduleURL(new URL('../src/ResourcePanel.tsx', import.meta.url)));
const host = document.getElementById('root')!;
let cleanup = () => {};
function root() { const value = createRoot(host); cleanup = () => value.unmount(); return value; }
afterEach(async () => { await act(async () => cleanup()); cleanup = () => {}; });
const button = (label: string) => Array.from(host.querySelectorAll('button')).find(item => item.textContent === label)!;
const close = () => host.querySelector('[aria-label="关闭修复"]')!;
const click = async (element: Element) => act(async () => { assert(element); element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); });
const change = async (input: HTMLInputElement, value: string) => act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
const submit = async () => act(async () => { host.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const resource = { id: 'tool', name: 'Example', kind: 'portable', rootPath: 'D:/synthetic/example/v1', repository: 'https://github.com/synthetic/example', version: 'editable-v99', alias: '', notes: '', enabled: false, revision: 4, ownership: 'managedFiles', managementScope: 'ownedFiles', actions: [], capabilities: [], createdAt: '', updatedAt: '' };
const plan = { id: 'repair-plan', kind: 'resourceRepair', resourceId: resource.id, targetPath: resource.rootPath, archivePath: 'D:/synthetic/original.zip', source: { repository: resource.repository, version: 'original-v1', verification: 'githubAsset' }, files: [{ path: 'tool.exe', target: resource.rootPath + '/tool.exe', role: 'runtime', decision: 'restore', reason: '已登记的运行文件缺失' }, { path: 'local.cfg', target: resource.rootPath + '/local.cfg', role: 'configuration', decision: 'preserve', reason: '已有本地配置保持' }], requiredBytes: 120, canApply: true, warnings: [], temporaryPaths: [resource.rootPath + '/tool.exe.repair-part'] };
const success = { resource: { ...resource, revision: 5 }, complete: true, ownershipSaved: true, receipt: { restored: [resource.rootPath + '/tool.exe'], retained: [resource.rootPath + '/local.cfg'], failures: [], temporaryPaths: [] } };
const npmResource = { ...resource, kind: 'mcp', installation: { runtimePackage: { recipe: 'edgeMcpNpmV1' } } };
const npmArtifact = { path: 'D:/synthetic/original/mcp-0.0.83.tgz', file: { bytes: 1536, sha256: 'a'.repeat(64), modified: 'source-time' }, origin: { kind: 'npmRegistry', registry: 'https://registry.npmjs.org', package: '@playwright/mcp', version: '0.0.83', repository: 'https://github.com/microsoft/playwright-mcp', tarball: 'https://registry.npmjs.org/@playwright/mcp/-/mcp-0.0.83.tgz', integrity: 'sha512-exact-original-integrity' } };
const npmPlan = { ...plan, archivePath: null, sourceFormat: 'npmTgz', sourcePaths: [npmArtifact.path], source: { repository: npmArtifact.origin.repository, version: '0.0.83', recipe: 'edgeMcpNpmV1', verification: 'npmIntegrity', artifacts: [npmArtifact] } };
function setup(override?: (command: string, args: any) => Promise<unknown> | undefined) {
  const calls: { command: string; args: any }[] = [], changes: any[] = [];
  const action = async (_label: string, command: string, args: any) => {
    calls.push({ command, args }); const custom = override?.(command, args); if (custom) return custom;
    if (command === 'preview_resource_repair') return plan;
    if (command === 'apply_resource_repair') return success;
    if (command === 'resource_list') return { resources: [resource] };
    if (command === 'resource_runtime') return { runs: [] };
    throw new Error(`Unexpected action ${command}`);
  };
  return { calls, changes, action, onChanged: (value: any) => changes.push(value) };
}

test('repair entry does nothing until preview, which binds revision and shows original install version and exact paths', async () => {
  const props = setup(); await act(async () => root().render(createElement(ResourceRepair, { resource, ...props })));
  await click(button('修复缺失文件')); assert.equal(props.calls.length, 0);
  await submit(); assert.deepEqual(props.calls, [{ command: 'preview_resource_repair', args: { id: 'tool', expectedRevision: 4 } }]);
  const preview = host.querySelector('[aria-label="修复影响清单"]')!;
  assert(preview.textContent?.includes('original-v1')); assert(!preview.textContent?.includes('editable-v99'));
  assert(preview.textContent?.includes(plan.archivePath)); assert(preview.textContent?.includes(plan.files[0].target));
  assert(preview.textContent?.includes(plan.temporaryPaths[0])); assert(preview.textContent?.includes('已有本地配置保持'));
  assert.equal(props.changes.length, 0);
});

test('npm repair uses original TGZ sources or an explicit local directory, never ZIP or network download', async () => {
  const props = setup(command => command === 'preview_resource_repair' ? Promise.resolve(npmPlan) : command === 'apply_resource_repair' ? Promise.resolve({ ...success, resource: { ...npmResource, revision: 5 } }) : undefined);
  await act(async () => root().render(createElement(ResourceRepair, { resource: npmResource, ...props })));
  await click(button('修复缺失文件')); assert.equal(props.calls.length, 0);
  const directory = host.querySelector<HTMLInputElement>('[aria-label="原精确 npm 资产目录"]')!;
  assert(directory); assert.equal(directory.value, ''); assert.equal(button('选择 ZIP'), undefined); assert(!host.textContent?.includes('原版本 ZIP'));
  await submit(); assert.deepEqual(props.calls.at(-1), { command: 'preview_resource_repair', args: { id: 'tool', expectedRevision: 4 } });
  const sources = host.querySelector('[aria-label="本次核对的 npm 资产"]')!;
  for (const value of [npmArtifact.path, npmArtifact.origin.package, npmArtifact.origin.version, npmArtifact.file.sha256, npmArtifact.origin.integrity]) assert(sources.textContent?.includes(value), value);
  assert(!host.querySelector('[aria-label="修复影响清单"]')?.textContent?.includes(plan.archivePath));
  await change(directory, 'D:/synthetic/moved-assets'); assert.equal(host.querySelector('[aria-label="修复影响清单"]'), null);
  await submit(); assert.deepEqual(props.calls.at(-1)?.args, { id: 'tool', expectedRevision: 4, artifactDirectory: 'D:/synthetic/moved-assets' });
  assert.equal(props.changes.length, 0); await click(button('确认补齐这些文件'));
  assert.deepEqual(props.calls.at(-1), { command: 'apply_resource_repair', args: { previewId: 'repair-plan' } });
  assert(props.calls.every(call => ['preview_resource_repair', 'apply_resource_repair'].includes(call.command)));
});

test('Reach repair displays exact wheel and original Python sources without treating Python files as wheel payloads', async () => {
  const wheel = { path: 'D:/synthetic/agent_reach-1.6.0-py3-none-any.whl', file: { bytes: 162228, sha256: 'c'.repeat(64) }, origin: { kind: 'githubRelease', source: { repository: 'https://github.com/panniantong/agent-reach', version: 'v1.6.0', assetName: 'agent_reach-1.6.0-py3-none-any.whl', downloadUrl: 'https://github.com/panniantong/agent-reach/releases/download/v1.6.0/agent_reach-1.6.0-py3-none-any.whl' } } };
  const pythonFile = { path: 'D:/synthetic/python/LICENSE.txt', target: 'LICENSES/Python.txt', bytes: 2048, sha256: 'd'.repeat(64) };
  const pythonPlan = { ...plan, archivePath: null, sourceFormat: 'pythonWheel', sourcePaths: [wheel.path, pythonFile.path, 'D:/synthetic/python/python.exe'], source: { repository: wheel.origin.source.repository, version: '1.6.0', verification: 'wheelRecord', recipe: 'agentReachWheelV1', artifacts: [wheel], runtimeFiles: [pythonFile] } };
  const props = setup(command => command === 'preview_resource_repair' ? Promise.resolve(pythonPlan) : undefined);
  await act(async () => root().render(createElement(ResourceRepair, { resource: { ...resource, installation: { runtimePackage: { recipe: 'agentReachWheelV1' } } }, ...props })));
  await click(button('修复缺失文件')); assert.equal(button('选择 ZIP'), undefined);
  const directory = host.querySelector<HTMLInputElement>('[aria-label="原精确 wheel 资产目录"]')!; assert(directory); assert.equal(directory.value, '');
  await submit(); assert.deepEqual(props.calls.at(-1)?.args, { id: 'tool', expectedRevision: 4 });
  const sources = host.querySelector('[aria-label="本次核对的 wheel 与原 Python 文件"]')!;
  for (const value of [wheel.path, wheel.origin.source.downloadUrl, wheel.file.sha256, pythonFile.path, pythonFile.target, pythonFile.sha256, '原 Python 文件', '绑定运行环境（仅核对）']) assert(sources.textContent?.includes(value), value);
  assert(!sources.textContent?.includes('npm integrity')); assert(!host.textContent?.includes('当前不支持 Python 专用环境的原位修复'));
  await change(directory, 'D:/synthetic/original-wheels'); await submit();
  assert.deepEqual(props.calls.at(-1)?.args, { id: 'tool', expectedRevision: 4, artifactDirectory: 'D:/synthetic/original-wheels' });
  assert.equal(props.changes.length, 0); assert(props.calls.every(call => call.command === 'preview_resource_repair'));
});

test('unreconstructable Reach generated files keep the precise backend refusal and cannot begin repair', async () => {
  const reason = 'Scripts/agent-reach.exe：没有原摘要一致的可信载荷，未开始修复';
  const props = setup(command => command === 'preview_resource_repair' ? Promise.reject(new Error(reason)) : undefined);
  await act(async () => root().render(createElement(ResourceRepair, { resource: { ...resource, installation: { runtimePackage: { recipe: 'agentReachWheelV1' } } }, ...props })));
  await click(button('修复缺失文件')); assert.equal(button('选择 ZIP'), undefined); assert(button('选择资产目录'));
  assert(host.textContent?.includes('无法可信重建的生成项由预览逐项说明'));
  await submit(); assert(host.querySelector('[role="alert"]')?.textContent?.includes(reason));
  assert.deepEqual(props.calls, [{ command: 'preview_resource_repair', args: { id: 'tool', expectedRevision: 4 } }]); assert.equal(props.changes.length, 0);
});

test('repair preview distinguishes retained historical files from the new temporary paths before confirmation', async () => {
  const retainedPath = resource.rootPath + '/tool.exe.previous-repair-part';
  const props = setup(command => command === 'preview_resource_repair' ? Promise.resolve({ ...plan, retainedTemporaryPaths: [retainedPath] }) : undefined);
  await act(async () => root().render(createElement(ResourceRepair, { resource, ...props })));
  await click(button('修复缺失文件')); await submit();
  const retained = host.querySelector('[aria-label="保留的历史临时文件"]')!;
  assert(retained.textContent?.includes(retainedPath)); assert(retained.textContent?.includes('原样保留，本次不复用、不删除'));
  assert(!retained.textContent?.includes(plan.temporaryPaths[0]));
  const current = Array.from(host.querySelectorAll('h4')).find(item => item.textContent === '本次临时位置')!.parentElement!;
  assert(current.textContent?.includes(plan.temporaryPaths[0])); assert(!current.textContent?.includes(retainedPath));
  assert.equal(props.calls.length, 1); assert.equal(props.changes.length, 0);
});

for (const enabled of [true, false]) test(`repair receipt reports the returned ${enabled ? 'enabled' : 'disabled'} choice without claiming the tool was started`, async () => {
  const props = setup(command => command === 'apply_resource_repair' ? Promise.resolve({ ...success, resource: { ...success.resource, enabled } }) : undefined);
  await act(async () => root().render(createElement(ResourceRepair, { resource: { ...resource, enabled: !enabled }, ...props })));
  await click(button('修复缺失文件')); await submit(); await click(button('确认补齐这些文件'));
  const status = host.querySelector('[aria-label="本次修复结果"] [role="status"]')!;
  assert(status.textContent?.includes(`本次完成时资源为${enabled ? '已启用' : '已停用'}`));
  assert(status.textContent?.includes('修复未启动工具，运行能力仍需验证'));
  assert.equal(props.changes[0].enabled, enabled);
  assert(!props.calls.some(call => call.command === 'resource_set_enabled' || call.command === 'resource_invoke'));
});

test('changing original ZIP or closing discards confirmation and IME Enter cannot submit', async () => {
  const props = setup(); await act(async () => root().render(createElement(ResourceRepair, { resource, ...props })));
  await click(button('修复缺失文件')); await submit();
  const input = host.querySelector('input')!;
  await change(input, 'D:/synthetic/reobtained.zip'); assert.equal(host.querySelector('[aria-label="修复影响清单"]'), null);
  const composing = new dom.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
  await act(async () => input.dispatchEvent(composing)); assert.equal(composing.defaultPrevented, true); assert.equal(props.calls.length, 1);
  await submit(); assert.equal(props.calls.at(-1)?.args.archivePath, 'D:/synthetic/reobtained.zip');
  await click(close()); assert.equal(document.activeElement, button('修复缺失文件'));
  await click(button('修复缺失文件')); assert.equal(host.querySelector('[aria-label="修复影响清单"]'), null);
  assert(props.calls.every(call => call.command === 'preview_resource_repair'));
});

test('revision changes reject old and late previews without overwriting the new resource', async () => {
  const waiting = deferred<unknown>(); let delayed = false;
  const props = setup(command => command === 'preview_resource_repair' && delayed ? waiting.promise : undefined), view = root();
  await act(async () => view.render(createElement(ResourceRepair, { resource, ...props })));
  await click(button('修复缺失文件')); await submit();
  await act(async () => view.render(createElement(ResourceRepair, { resource: { ...resource, revision: 5 }, ...props })));
  assert.equal(host.querySelector('[aria-label="修复影响清单"]'), null);
  delayed = true; await submit();
  await act(async () => view.render(createElement(ResourceRepair, { resource: { ...resource, revision: 6 }, ...props })));
  await act(async () => waiting.resolve(plan));
  assert.equal(host.querySelector('[aria-label="修复影响清单"]'), null); assert.equal(props.changes.length, 0);
  assert(props.calls.every(call => call.command === 'preview_resource_repair'));
});

test('read-only resource details never expose the repair entry and do not run maintenance', async () => {
  const props = setup(), view = root();
  await act(async () => view.render(createElement(ResourcePanel, { action: props.action, readOnly: true })));
  await click(host.querySelector('.resource-name-button')!);
  assert.equal(button('修复缺失文件'), undefined); assert(props.calls.every(call => ['resource_list', 'resource_runtime'].includes(call.command)));
  await act(async () => view.render(createElement(ResourceRepair, { resource, ...props, readOnly: true })));
  assert.equal(host.children.length, 0);
});

test('repair stays in details rather than list rows and applies exactly once without enabling the resource', async () => {
  const waiting = deferred<unknown>();
  const props = setup(command => command === 'apply_resource_repair' ? waiting.promise : undefined);
  await act(async () => root().render(createElement(ResourcePanel, { action: props.action })));
  assert.equal(button('修复缺失文件'), undefined);
  await click(host.querySelector('.resource-name-button')!);
  assert.equal(host.querySelector('.resource-row .resource-repair'), null);
  await click(button('修复缺失文件')); await submit();
  const apply = button('确认补齐这些文件'); await act(async () => { apply.click(); apply.click(); });
  assert.equal(props.calls.filter(call => call.command === 'apply_resource_repair').length, 1);
  assert.equal((close() as HTMLButtonElement).disabled, true);
  await act(async () => waiting.resolve(success));
  assert(host.textContent?.includes('所选缺失文件已补齐并记录')); assert(host.querySelector('.resource-state')?.textContent?.includes('已停用'));
  assert(!props.calls.some(call => call.command === 'resource_set_enabled'));
  assert.deepEqual(props.calls.find(call => call.command === 'apply_resource_repair')?.args, { previewId: 'repair-plan' });
});

test('no missing files do not expose an enabled apply and partial results remain readable with unsaved ownership', async () => {
  let noMissing = true;
  const props = setup(command => command === 'preview_resource_repair' && noMissing ? Promise.resolve({ ...plan, files: [plan.files[1]], requiredBytes: 0, canApply: false }) : command === 'apply_resource_repair' ? Promise.resolve({ ...success, complete: false, ownershipSaved: false, receipt: { ...success.receipt, failures: [[resource.rootPath + '/helper.dll', '目标已被占用']], temporaryPaths: plan.temporaryPaths } }) : undefined);
  await act(async () => root().render(createElement(ResourceRepair, { resource, ...props })));
  await click(button('修复缺失文件')); await submit();
  assert.equal(button('确认补齐这些文件').disabled, true); assert(host.textContent?.includes('无需补齐运行文件'));
  noMissing = false; await submit(); await click(button('确认补齐这些文件'));
  const output = host.querySelector('[aria-label="本次修复结果"]')!;
  assert(output.textContent?.includes('未完整完成')); assert(output.textContent?.includes('归属记录尚未保存'));
  assert(output.textContent?.includes(success.receipt.restored[0])); assert(output.textContent?.includes('目标已被占用')); assert(output.textContent?.includes(plan.temporaryPaths[0]));
  assert.equal(props.changes[0].enabled, false);
});

test('closing a pending preview ignores its response and restores focus after reading ends', async () => {
  const waiting = deferred<unknown>();
  const props = setup(command => command === 'preview_resource_repair' ? waiting.promise : undefined);
  await act(async () => root().render(createElement(ResourceRepair, { resource, ...props })));
  await click(button('修复缺失文件')); await submit(); await click(close());
  await act(async () => waiting.resolve(plan));
  assert.equal(host.querySelector('[aria-label="修复影响清单"]'), null); assert.equal(document.activeElement, button('修复缺失文件'));
  await click(button('修复缺失文件')); assert.equal(host.querySelector('[aria-label="修复影响清单"]'), null);
});

for (const complete of [true, false]) test(`${complete ? 'complete' : 'partial'} repair receipt survives earlier catalog events without overwriting newer resource metadata`, async () => {
  const waiting = deferred<unknown>();
  const props = setup(command => command === 'apply_resource_repair' ? waiting.promise : undefined), view = root();
  await act(async () => view.render(createElement(ResourceRepair, { resource, ...props })));
  await click(button('修复缺失文件')); await submit(); await click(button('确认补齐这些文件'));
  await act(async () => view.render(createElement(ResourceRepair, { resource: { ...resource, revision: 7, enabled: true, notes: 'newer metadata' }, ...props })));
  const outcome = complete ? success : { ...success, complete: false, ownershipSaved: false, receipt: { ...success.receipt, failures: [[resource.rootPath + '/helper.dll', '目标已变化']], temporaryPaths: plan.temporaryPaths } };
  await act(async () => waiting.resolve(outcome));
  const output = host.querySelector('[aria-label="本次修复结果"]')!;
  assert(output); assert(output.textContent?.includes(complete ? '所选缺失文件已补齐并记录' : '本次修复未完整完成'));
  if (!complete) { assert(output.textContent?.includes('目标已变化')); assert(output.textContent?.includes(plan.temporaryPaths[0])); }
  assert.equal(props.changes.length, 0, 'an earlier result must not overwrite a higher catalog revision');
  assert.equal(button('修复缺失文件').disabled, false);
});

test('an apply receipt from a different resource view remains isolated', async () => {
  const waiting = deferred<unknown>();
  const props = setup(command => command === 'apply_resource_repair' ? waiting.promise : undefined), view = root();
  await act(async () => view.render(createElement(ResourceRepair, { resource, ...props })));
  await click(button('修复缺失文件')); await submit(); await click(button('确认补齐这些文件'));
  await act(async () => view.render(createElement(ResourceRepair, { resource: { ...resource, id: 'another-tool', revision: 1 }, ...props })));
  await act(async () => waiting.resolve(success));
  assert.equal(host.querySelector('[aria-label="本次修复结果"]'), null); assert.equal(props.changes.length, 0);
});

test('completion-only recovery with no missing files still requires explicit confirmation and reports record completion', async () => {
  const props = setup(command => command === 'preview_resource_repair' ? Promise.resolve({ ...plan, id: 'completion-plan', completionOnly: true, canApply: true, files: [plan.files[1]], requiredBytes: 0, temporaryPaths: [], warnings: ['完成后仍保留本人选择的停用状态。'] }) : command === 'apply_resource_repair' ? Promise.resolve({ ...success, receipt: { ...success.receipt, restored: [] } }) : undefined);
  await act(async () => root().render(createElement(ResourceRepair, { resource, ...props })));
  await click(button('修复缺失文件')); await submit();
  assert.equal(props.calls.length, 1); assert(host.textContent?.includes('本次只核验已有文件并完成记录，不再解包'));
  assert(host.textContent?.includes('完成后仍保留本人选择的停用状态'));
  assert.equal(button('确认补齐这些文件'), undefined); assert.equal(button('核验并完成上次修复').disabled, false);
  await click(button('核验并完成上次修复'));
  assert.deepEqual(props.calls.at(-1), { command: 'apply_resource_repair', args: { previewId: 'completion-plan' } });
  const output = host.querySelector('[aria-label="本次修复结果"]')!;
  assert(output.textContent?.includes('已有文件已核验，上次修复记录已完成'));
  assert(!output.textContent?.includes('所选缺失文件已补齐'));
  assert.equal(props.changes[0].enabled, false);
});
