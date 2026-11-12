import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const modules = new Map<string, Promise<string>>();
async function moduleURL(url: URL): Promise<string> {
  const existing = modules.get(url.href); if (existing) return existing;
  const loading = (async () => {
    let code = ts.transpileModule(await readFile(url, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const replacements = new Map<string, string>();
    for (const match of code.matchAll(/from\s+(['"])([^'"]+)\1/g)) {
      const specifier = match[2]; if (replacements.has(specifier)) continue;
      if (!specifier.startsWith('.')) replacements.set(specifier, import.meta.resolve(specifier));
      else { let target = new URL(specifier + '.ts', url); try { await access(target); } catch { target = new URL(specifier + '.tsx', url); } replacements.set(specifier, await moduleURL(target)); }
    }
    code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, specifier) => `from ${JSON.stringify(replacements.get(specifier))}`);
    return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  })(); modules.set(url.href, loading); return loading;
}
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const { RuntimePackageInstall } = await import(await moduleURL(new URL('../src/RuntimePackageInstall.tsx', import.meta.url)));
const host = document.getElementById('root')!;
let cleanup = () => {};
function root() { const value = createRoot(host); cleanup = () => value.unmount(); return value; }
afterEach(async () => { await act(async () => cleanup()); cleanup = () => {}; });
const button = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === label)!;
const field = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const click = async (element: Element) => act(async () => { assert(element); element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); });
const change = async (element: HTMLInputElement, value: string) => act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
const select = async (value: string) => act(async () => { const element = host.querySelector('select')!; element.value = value; element.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const hash = 'a'.repeat(64), defaults = { workingDirectory: 'D:/resources/work', downloadDirectory: 'D:/resources/downloads', destinationPath: 'D:/resources/edge-v1' };
const session = (changes = {}) => ({ id: 'session', revision: 2, recipe: 'edgeMcpNpmV1', version: '1.2.3', resourceId: null, ...defaults, status: 'resolved', error: null, downloadComplete: false, materialized: false, executionVerified: false, createdAt: '2026-10-31', updatedAt: '2026-10-31', ...changes });
const prepare = (changes = {}) => ({ id: 'prepare', canApply: true, kind: 'runtimePackagePreparation', recipe: 'edgeMcpNpmV1', version: '1.2.3', resourceId: null, targetPath: defaults.destinationPath, workingDirectory: defaults.workingDirectory, downloadDirectory: defaults.downloadDirectory, bytesPerSecond: 0, source: null, installsFiles: false, executionVerified: false, network: { hosts: ['registry.npmjs.org'], purpose: '只读取精确依赖元数据', downloadsArchives: false }, warning: '不运行脚本', ...changes });
const download = (revision = 2) => ({ id: 'download', canApply: true, kind: 'runtimePackageDownload', sessionId: 'session', sessionRevision: revision, resourceId: null, recipe: 'edgeMcpNpmV1', directory: defaults.downloadDirectory, bytesPerSecond: 0, artifacts: [{ package: '@playwright/mcp', filename: 'mcp.tgz', url: 'https://registry.npmjs.org/mcp.tgz', bytes: null, sha256: null, sha512: 'sha512-YWJjZA==' }], downloadBytes: null, maximumArtifactBytes: 536870912, planHash: hash, installsFiles: false, executesCode: false, warning: '只下载这些资产' });
const materialize = () => ({ id: 'materialize', canApply: true, kind: 'npmRuntimeMaterialization', sessionId: 'session', sessionRevision: 3, resourceId: null, recipe: 'edgeMcpNpmV1', targetPath: defaults.destinationPath, artifacts: { '@playwright/mcp': { path: defaults.downloadDirectory + '/mcp.tgz', file: { bytes: 42, sha256: hash, modified: '2026-10-31' }, origin: { kind: 'npmRegistry', package: '@playwright/mcp', version: '1.2.3', tarball: 'https://registry.npmjs.org/mcp.tgz' } } }, files: { '@playwright/mcp': { unpackedBytes: 24, files: [{ path: 'LICENSE', bytes: 24, sha256: hash, license: true }] } }, planHash: hash, nodeMajorMinimum: 18, executionVerified: false, warnings: ['保留许可证'] });
const receipt = (changes = {}) => ({ recipe: 'edgeMcpNpmV1', root: defaults.destinationPath, files: [{ path: 'LICENSE', role: 'license', installedSha256: hash }], complete: true, dependencyCheckPassed: true, executionVerified: false, error: null, createdPaths: [defaults.destinationPath], temporaryPaths: [], ...changes });
const resource = { id: 'edge', name: 'Edge Control', kind: 'mcp', rootPath: defaults.destinationPath, revision: 1, enabled: false, alias: '', notes: '', ownership: 'managedFiles', managementScope: 'ownedFiles', actions: [], capabilities: [], createdAt: '', updatedAt: '' };
const commit = (changes = {}) => ({ id: 'commit', kind: 'resourcePackageCommit', recipe: 'edgeMcpNpmV1', sessionId: 'session', sessionRevision: 4, resourceId: null, targetPath: defaults.destinationPath, version: '1.2.3', mode: 'register', files: receipt().files, canApply: true, warnings: [], ...changes });
function fixture(override?: (command: string, args: any) => unknown) {
  const calls: { command: string; args: any }[] = [], installed: unknown[] = [];
  const action = async (_label: string, command: string, args: any) => {
    calls.push({ command, args }); const custom = override?.(command, args); if (custom !== undefined) return custom;
    if (command === 'preview_resource_package_prepare') return prepare();
    if (command === 'apply_resource_package_prepare') return { session: session(), complete: true, installed: false, executionVerified: false };
    if (command === 'preview_resource_package_download') return download();
    if (command === 'apply_resource_package_download') return { session: session({ revision: 3, downloadComplete: true, status: 'downloaded' }), complete: true, installed: false, executionVerified: false };
    if (command === 'preview_resource_package_materialize') return materialize();
    if (command === 'apply_resource_package_materialize') return { session: session({ revision: 4, downloadComplete: true, materialized: true, status: 'materialized' }), complete: true, installed: false, executionVerified: false, receipt: receipt() };
    if (command === 'preview_resource_package_commit') return commit();
    if (command === 'apply_resource_package_commit') return { complete: true, executionVerified: false, receipt: receipt(), registered: true, staged: false, switched: false, ownershipSaved: true, resource };
    if (command === 'resource_package_sessions') return { sessions: [] };
    throw new Error('Unexpected action ' + command);
  };
  return { calls, installed, props: { action, defaultPaths: defaults, onInstalled: (item: unknown) => installed.push(item) } };
}
async function fillNode() { await select('edgeMcpNpmV1'); await change(field('软件包精确版本'), '1.2.3'); await change(field('软件包运行程序'), 'D:/shared/node.exe'); for (const element of host.querySelectorAll<HTMLInputElement>('input[type="radio"]')) await click(element); }
async function firstSession() { await click(button('预览准备范围')); await click(button('确认解析依赖')); }
async function downloadedSession() { await firstSession(); await click(button('预览依赖下载')); await click(button('确认下载依赖文件')); }

test('mount is inert and missing trusted wheel receipt cannot be replaced by user-supplied IDs', async () => {
  const f = fixture(); await act(async () => root().render(createElement(RuntimePackageInstall, f.props)));
  assert.equal(f.calls.length, 0); assert(host.textContent?.includes('请先从 GitHub 下载'));
  assert.equal(host.querySelector('input[aria-label*="downloadId"]'), null); assert.equal(host.querySelector('input[aria-label*="回执"]'), null);
  await change(field('软件包精确版本'), '1.2.3'); await change(field('软件包运行程序'), 'D:/shared/python.exe');
  for (const element of host.querySelectorAll<HTMLInputElement>('input[type="radio"]')) await click(element);
  await click(button('预览准备范围')); assert.equal(f.calls.length, 0);
});

test('each phase has separate explicit preview and confirmation with exact minimal requests', async () => {
  const f = fixture(); await act(async () => root().render(createElement(RuntimePackageInstall, f.props))); await fillNode(); assert.equal(f.calls.length, 0);
  await click(button('预览准备范围'));
  assert.deepEqual(f.calls, [{ command: 'preview_resource_package_prepare', args: { recipe: 'edgeMcpNpmV1', version: '1.2.3', runtimePath: 'D:/shared/node.exe', workDirectory: defaults.workingDirectory, downloadDirectory: defaults.downloadDirectory, destinationPath: defaults.destinationPath, bytesPerSecond: 0 } }]);
  assert.equal(f.installed.length, 0); await click(button('确认解析依赖')); assert.equal(f.calls.at(-1)?.command, 'apply_resource_package_prepare');
  assert.equal(host.querySelector('.runtime-package-next-step > button')!.textContent, '预览依赖下载'); assert.equal(host.querySelector('.runtime-package-next-step details')!.hasAttribute('open'), false);
  await click(button('预览依赖下载')); assert.deepEqual(f.calls.at(-1)?.args, { sessionId: 'session' }); assert(host.textContent?.includes('未知'));
  await click(button('确认下载依赖文件')); assert.equal(f.installed.length, 0);
  assert.equal(host.querySelector('.runtime-package-next-step > button')!.textContent, '预览运行目录');
  await click(button('预览运行目录')); assert(host.textContent?.includes('保留的许可证')); assert.equal(f.installed.length, 0);
  await click(button('确认准备运行目录')); assert.equal(f.installed.length, 0); assert.equal(f.calls.length, 6);
  assert.equal(host.querySelector('.runtime-package-next-step > button')!.textContent, '预览登记运行目录'); assert(button('核对续传范围').disabled);
  await click(button('预览登记运行目录')); assert.deepEqual(f.calls.at(-1)?.args, { sessionId: 'session' }); assert.equal(f.installed.length, 0);
  await click(button('确认登记运行目录')); assert.deepEqual(f.installed, [resource]);
  assert.deepEqual(f.calls.filter(call => call.command.startsWith('apply_')).map(call => call.args), [{ previewId: 'prepare' }, { previewId: 'download' }, { previewId: 'materialize' }, { previewId: 'commit' }]);
  assert(host.textContent?.includes('能力待验证')); assert.equal(button('预览登记运行目录').disabled, true);
});

test('unset defaults are stated once and custom paths stay explicitly selectable without repeated paths', async () => {
  const f = fixture(); await act(async () => root().render(createElement(RuntimePackageInstall, { ...f.props, defaultPaths: {} })));
  assert.equal(host.querySelectorAll('input[type="radio"]').length, 0); assert.equal(host.querySelectorAll('.destination-manual input').length, 0);
  assert.equal(host.textContent!.split('未配置的目录没有默认位置').length - 1, 1);
  for (const [name, path] of [['准备工作目录', 'D:/custom/work'], ['依赖下载目录', 'D:/custom/downloads'], ['新运行目录', 'D:/custom/runtime']]) {
    await click(host.querySelector(`[aria-label="手动填写${name}"]`)!); await change(field(`${name}完整路径`), path);
    assert.equal(field(`${name}完整路径`).value, path); assert.equal(host.querySelectorAll('.destination-current code').length, 0);
  }
  assert.equal(f.calls.length, 0); assert.equal(host.querySelectorAll('.destination-manual input').length, 3);
});

test('recipe-specific examples and adjacent format errors do not start network work', async () => {
  const f = fixture(); await act(async () => root().render(createElement(RuntimePackageInstall, f.props)));
  assert.equal(host.querySelector('option[value="edgeMcpNpmV1"]')?.textContent, 'Playwright MCP');
  assert(field('软件包精确版本').placeholder.includes('1.6.0')); await select('edgeMcpNpmV1'); assert(field('软件包精确版本').placeholder.includes('0.0.83'));
  await change(field('软件包精确版本'), 'latest'); assert.equal(field('软件包精确版本').getAttribute('aria-invalid'), 'true');
  const help = document.getElementById(field('软件包精确版本').getAttribute('aria-describedby')!)!; assert(help.textContent?.includes('0.0.83')); assert(button('预览准备范围').disabled);
  await change(field('软件包精确版本'), '0.0.83'); assert.equal(field('软件包精确版本').hasAttribute('aria-invalid'), false); assert.equal(f.calls.length, 0);
});

test('manual package rates use MiB/s while exact requests retain integer bytes per second', async () => {
  const f = fixture((command, args) => command === 'preview_resource_package_prepare' ? prepare({ bytesPerSecond: args.bytesPerSecond }) : undefined);
  await act(async () => root().render(createElement(RuntimePackageInstall, f.props))); await fillNode();
  await change(field('软件包下载限速'), '0.001953125'); await click(button('预览准备范围'));
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].args, { recipe: 'edgeMcpNpmV1', version: '1.2.3', runtimePath: 'D:/shared/node.exe', workDirectory: defaults.workingDirectory, downloadDirectory: defaults.downloadDirectory, destinationPath: defaults.destinationPath, bytesPerSecond: 2048 });
  assert(host.querySelector('[aria-label="软件包本次影响清单"]')?.textContent?.includes('0.001953125 MiB/s'));
  assert.equal(f.installed.length, 0); assert(f.calls.every(call => !call.command.startsWith('apply_')));
});

test('manual rate errors stay next to the field and positive underflow never becomes unlimited', async () => {
  const f = fixture(); await act(async () => root().render(createElement(RuntimePackageInstall, f.props))); await fillNode();
  const rate = field('软件包下载限速');
  for (const value of ['', '-1', 'NaN', '0.0000001', '1e-999', '8589934592']) {
    await change(rate, value);
    assert.equal(rate.getAttribute('aria-invalid'), 'true', value); assert(button('预览准备范围').disabled);
    assert.equal(f.calls.length, 0);
    const note = document.getElementById(rate.getAttribute('aria-describedby')!)!;
    assert.equal(note.parentElement, rate.parentElement);
    assert(note.textContent?.includes(value === '8589934592' ? '过大' : ['0.0000001', '1e-999'].includes(value) ? '过小' : '非负数'));
  }
  await change(rate, '0'); assert.equal(rate.getAttribute('aria-invalid'), 'false');
  await click(button('预览准备范围')); assert.equal(f.calls[0].args.bytesPerSecond, 0);
});

test('package preview errors keep the actual reason without the Error prefix', async () => {
  const f = fixture(command => command === 'preview_resource_package_prepare' ? Promise.reject(new Error('所选运行目录已存在，未覆盖。')) : undefined);
  await act(async () => root().render(createElement(RuntimePackageInstall, f.props))); await fillNode();
  await click(button('预览准备范围'));
  assert.equal(host.querySelector('[role="alert"]')?.textContent, '所选运行目录已存在，未覆盖。');
  assert.equal(f.calls.length, 1); assert.equal(f.installed.length, 0);
});

test('default location must be explicitly chosen and changed defaults invalidate it', async () => {
  const f = fixture(), view = root(); await act(async () => view.render(createElement(RuntimePackageInstall, f.props)));
  await select('edgeMcpNpmV1'); await change(field('软件包精确版本'), '1.2.3'); await change(field('软件包运行程序'), 'D:/shared/node.exe');
  assert.equal(button('预览准备范围').disabled, true);
  for (const element of host.querySelectorAll<HTMLInputElement>('input[type="radio"]')) await click(element);
  assert.equal(button('预览准备范围').disabled, false);
  await act(async () => view.render(createElement(RuntimePackageInstall, { ...f.props, defaultPaths: { ...defaults, destinationPath: 'D:/resources/edge-v2' } })));
  assert.equal(button('预览准备范围').disabled, true); assert.equal(f.calls.length, 0);
  await click(host.querySelector('[aria-label="手动填写新运行目录"]')!); await change(field('新运行目录完整路径'), 'D:/custom/edge-v3'); assert.equal(button('预览准备范围').disabled, false);
});

test('Reach obtains trusted archive identity only through props and displays resolver download limits truthfully', async () => {
  const f = fixture(command => command === 'preview_resource_package_prepare' ? prepare({ recipe: 'agentReachWheelV1', source: { path: 'D:/official/agent_reach.whl', file: { bytes: 30, sha256: hash, modified: '2026-10-31' }, origin: { kind: 'githubRelease', source: { repository: 'https://github.com/panniantong/agent-reach', version: 'v1.2.3' } } }, network: { hosts: ['pypi.org'], purpose: '解析 wheel', resolverMayDownloadWheels: true, resolverDownloadsRateLimited: false, temporaryCacheParent: defaults.workingDirectory } }) : undefined);
  await act(async () => root().render(createElement(RuntimePackageInstall, { ...f.props, archivePath: 'D:/official/agent_reach.whl', downloadId: 'internal-receipt' })));
  await change(field('软件包精确版本'), '1.2.3'); await change(field('软件包运行程序'), 'D:/shared/python.exe'); for (const element of host.querySelectorAll<HTMLInputElement>('input[type="radio"]')) await click(element);
  await click(button('预览准备范围')); assert.equal(f.calls[0].args.downloadId, 'internal-receipt'); assert(!host.textContent?.includes('internal-receipt'));
  assert(host.textContent?.includes('解析阶段的下载不受上述限速约束')); assert.equal(f.calls.length, 1);
});

test('restored journal records are read explicitly and never resume work on selection', async () => {
  const f = fixture(command => command === 'resource_package_sessions' ? { sessions: [session({ status: 'downloading' }), session({ id: 'pending', status: 'materializing', downloadComplete: true })] } : undefined);
  await act(async () => root().render(createElement(RuntimePackageInstall, f.props))); assert.equal(f.calls.length, 0);
  await click(button('查看准备记录')); await click(button('Playwright MCP · 1.2.3'));
  assert.equal(f.calls.length, 1); assert.equal(button('核对续传范围').disabled, false); assert(host.textContent?.includes('下载尚未结束'));
  const records = host.querySelector('[aria-label="已有软件包准备记录"]')!; await click(records.querySelectorAll('li button')[1]);
  assert.equal(f.calls.length, 1); assert.equal(button('预览运行目录').disabled, true); assert(host.textContent?.includes('不会重复安装'));
});

test('resume preview uses current session facts and confirmation never replays another phase', async () => {
  const f = fixture(command => command === 'resource_package_sessions' ? { sessions: [session({ status: 'downloadInterrupted', error: '网络中断' })] } : command === 'preview_resource_package_resume' ? { id: 'resume', canApply: true, kind: 'runtimePackageResume', sessionId: 'session', sessionRevision: 2, resourceId: null, plan: download(), transfers: [{ package: '@playwright/mcp', target: defaults.downloadDirectory + '/mcp.tgz', partial: defaults.downloadDirectory + '/mcp.part', observed: { bytes: 10, sha256: hash, modified: '2026-10-31' }, complete: false, error: null }], willReplayInstall: false } : command === 'apply_resource_package_resume' ? { session: session({ revision: 3, status: 'downloaded', downloadComplete: true }), complete: true, installed: false, executionVerified: false } : undefined);
  await act(async () => root().render(createElement(RuntimePackageInstall, f.props))); await click(button('查看准备记录')); await click(button('Playwright MCP · 1.2.3'));
  await click(button('核对续传范围')); assert(host.textContent?.includes('mcp.part')); assert.equal(f.calls.length, 2);
  await click(button('确认继续此下载')); assert.equal(f.calls.at(-1)?.command, 'apply_resource_package_resume'); assert.deepEqual(f.calls.at(-1)?.args, { previewId: 'resume' }); assert.equal(f.installed.length, 0);
});

test('late previews are discarded when source input changes and never enable a stale confirmation', async () => {
  const wait = deferred<unknown>(), f = fixture(command => command === 'preview_resource_package_prepare' ? wait.promise : undefined);
  await act(async () => root().render(createElement(RuntimePackageInstall, f.props))); await fillNode(); await click(button('预览准备范围'));
  await change(field('软件包精确版本'), '1.2.4'); await act(async () => wait.resolve(prepare()));
  assert.equal(host.querySelector('[aria-label="软件包本次影响清单"]'), null); assert.equal(f.calls.length, 1); assert.equal(f.installed.length, 0);
});

for (const mode of ['hidden', 'basic', 'disabled']) test(`${mode} invalidates pending previews and rejects writes`, async () => {
  const wait = deferred<unknown>(), f = fixture(command => command === 'preview_resource_package_prepare' ? wait.promise : undefined), view = root();
  await act(async () => view.render(createElement(RuntimePackageInstall, f.props))); await fillNode(); await click(button('预览准备范围'));
  const changes = mode === 'hidden' ? { visible: false } : mode === 'basic' ? { readOnly: true } : { disabled: true };
  await act(async () => view.render(createElement(RuntimePackageInstall, { ...f.props, ...changes })));
  await act(async () => wait.resolve(prepare())); assert.equal(host.querySelector('[aria-label="软件包本次影响清单"]'), null); assert.equal(f.installed.length, 0);
  if (mode === 'hidden') assert.equal(host.children.length, 0);
  if (mode === 'basic') { assert.equal(host.querySelector('form'), null); await click(button('查看准备记录')); assert.equal(f.calls.at(-1)?.command, 'resource_package_sessions'); }
  assert(f.calls.every(call => !call.command.startsWith('apply_')));
});

test('one-time confirmation applies once and receipt without registration does not close the flow', async () => {
  const wait = deferred<unknown>(), f = fixture(command => command === 'apply_resource_package_materialize' ? wait.promise : undefined);
  await act(async () => root().render(createElement(RuntimePackageInstall, f.props))); await fillNode(); await downloadedSession(); await click(button('预览运行目录'));
  const confirm = button('确认准备运行目录'); await act(async () => { confirm.click(); confirm.click(); }); assert.equal(f.calls.filter(call => call.command === 'apply_resource_package_materialize').length, 1);
  await act(async () => wait.resolve({ session: session({ revision: 4, status: 'materialized', materialized: true, downloadComplete: true }), complete: true, executionVerified: false, installed: false, receipt: receipt() }));
  assert.equal(f.installed.length, 0); assert(host.textContent?.includes('管理登记尚未完成')); assert.equal(button('确认准备运行目录'), undefined);
});

test('partial materialization preserves actual errors and temporary paths without a success callback', async () => {
  const f = fixture(command => command === 'apply_resource_package_materialize' ? { session: session({ revision: 4, status: 'materializationIncomplete', error: '空间不足', downloadComplete: true }), complete: false, executionVerified: false, receipt: receipt({ complete: false, dependencyCheckPassed: false, error: '空间不足', temporaryPaths: ['D:/resources/work/partial-file'] }) } : undefined);
  await act(async () => root().render(createElement(RuntimePackageInstall, f.props))); await fillNode(); await downloadedSession(); await click(button('预览运行目录')); await click(button('确认准备运行目录'));
  assert.equal(f.installed.length, 0); assert(host.textContent?.includes('空间不足')); assert(host.textContent?.includes('D:/resources/work/partial-file')); assert.equal(button('预览运行目录').disabled, true); assert(host.textContent?.includes('不会重复安装'));
});

test('records paginate compactly and a record from another resource cannot be applied here', async () => {
  const f = fixture(command => command === 'resource_package_sessions' ? { sessions: Array.from({ length: 21 }, (_, index) => session({ id: `session-${index}`, version: `1.2.${index}`, resourceId: 'another-resource' })) } : undefined);
  await act(async () => root().render(createElement(RuntimePackageInstall, f.props))); await click(button('查看准备记录'));
  assert.equal(host.querySelectorAll('[aria-label="已有软件包准备记录"] li').length, 20); await click(button('下一页')); assert.equal(host.querySelectorAll('[aria-label="已有软件包准备记录"] li').length, 1);
  await click(button('Playwright MCP · 1.2.20')); assert(host.textContent?.includes('属于其他工具')); assert.equal(button('预览依赖下载'), undefined); assert.equal(f.calls.length, 1);
});

test('restored materialized directory commits only after a fresh preview and one-time confirmation, without rebuilding', async () => {
  const wait = deferred<unknown>(), f = fixture(command => command === 'resource_package_sessions' ? { sessions: [session({ revision: 4, downloadComplete: true, materialized: true, status: 'materialized' })] } : command === 'apply_resource_package_commit' ? wait.promise : undefined);
  await act(async () => root().render(createElement(RuntimePackageInstall, f.props))); await click(button('查看准备记录')); await click(button('Playwright MCP · 1.2.3'));
  assert.equal(f.calls.length, 1); await click(button('预览登记运行目录')); assert.equal(f.calls.length, 2); assert.equal(f.installed.length, 0);
  const confirm = button('确认登记运行目录'); await act(async () => { confirm.click(); confirm.click(); });
  assert.equal(f.calls.filter(call => call.command === 'apply_resource_package_commit').length, 1);
  await act(async () => wait.resolve({ complete: true, executionVerified: false, registered: true, staged: false, switched: false, ownershipSaved: true, receipt: receipt(), resource }));
  assert.deepEqual(f.installed, [resource]); assert(f.calls.every(call => ['resource_package_sessions', 'preview_resource_package_commit', 'apply_resource_package_commit'].includes(call.command)));
});

test('candidate commit reports staging through its own callback and preserves the actual old resource root and version', async () => {
  const original = { ...resource, rootPath: 'D:/resources/edge-old', version: '0.9.0' }, staged: unknown[] = [];
  const f = fixture(command => command === 'resource_package_sessions' ? { sessions: [session({ revision: 4, resourceId: 'edge', downloadComplete: true, materialized: true, status: 'materialized' })] } : command === 'preview_resource_package_commit' ? commit({ resourceId: 'edge', mode: 'candidate' }) : command === 'apply_resource_package_commit' ? { complete: true, executionVerified: false, registered: false, staged: true, switched: false, ownershipSaved: true, receipt: receipt(), resource: original } : undefined);
  await act(async () => root().render(createElement(RuntimePackageInstall, { ...f.props, resourceId: 'edge', expectedRevision: 1, onStaged: (value: unknown) => staged.push(value) })));
  await click(button('查看准备记录')); await click(button('Playwright MCP · 1.2.3')); await click(button('预览保存候选'));
  assert(host.textContent?.includes('当前版本保持不变')); assert.equal(staged.length, 0); await click(button('确认保存候选'));
  assert.deepEqual(staged, [original]); assert.equal(f.installed.length, 0); assert(host.textContent?.includes('候选已准备，等待验证和切换'));
  assert(f.calls.every(call => !call.command.includes('switch') && !call.command.includes('verify')));
});

test('commit persistence failure retains the prepared directory and does not report registration or staging', async () => {
  const f = fixture(command => command === 'resource_package_sessions' ? { sessions: [session({ revision: 4, downloadComplete: true, materialized: true, status: 'materialized' })] } : command === 'apply_resource_package_commit' ? { complete: false, ownershipSaved: false, executionVerified: false, registered: false, staged: false, switched: false, receipt: receipt(), error: '登记保存失败，请刷新核对' } : undefined);
  await act(async () => root().render(createElement(RuntimePackageInstall, f.props))); await click(button('查看准备记录')); await click(button('Playwright MCP · 1.2.3')); await click(button('预览登记运行目录')); await click(button('确认登记运行目录'));
  assert.equal(f.installed.length, 0); assert(host.textContent?.includes('登记保存失败')); assert(host.textContent?.includes(defaults.destinationPath)); assert.equal(button('确认登记运行目录'), undefined);
  assert.equal(button('预览登记运行目录').disabled, false);
});

test('commit preview from an old session or hidden panel cannot authorize a write', async () => {
  const wait = deferred<unknown>(), f = fixture(command => command === 'resource_package_sessions' ? { sessions: [session({ revision: 4, downloadComplete: true, materialized: true, status: 'materialized' })] } : command === 'preview_resource_package_commit' ? wait.promise : undefined), view = root();
  await act(async () => view.render(createElement(RuntimePackageInstall, f.props))); await click(button('查看准备记录')); await click(button('Playwright MCP · 1.2.3')); await click(button('预览登记运行目录'));
  await act(async () => view.render(createElement(RuntimePackageInstall, { ...f.props, visible: false }))); await act(async () => wait.resolve(commit()));
  await act(async () => view.render(createElement(RuntimePackageInstall, f.props))); assert.equal(button('确认登记运行目录'), undefined); assert(f.calls.every(call => !call.command.startsWith('apply_')));
});
