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
          let path = new URL(value + '.ts', url);
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
const { InstallResource } = await import(await moduleURL(new URL('../src/ResourceLifecycle.tsx', import.meta.url)));
const { ResourceGithub } = await import(await moduleURL(new URL('../src/ResourceGithub.tsx', import.meta.url)));
const host = document.getElementById('root')!;
let cleanup = () => {};
function root() { const value = createRoot(host); cleanup = () => value.unmount(); return value; }
afterEach(async () => { await act(async () => cleanup()); cleanup = () => {}; });
const button = (label: string) => Array.from(host.querySelectorAll('button')).find(item => item.textContent === label)!;
const field = (label: string) => Array.from(host.querySelectorAll('label')).find(item => item.firstChild?.textContent === label)!.querySelector('input, select') as HTMLInputElement;
const click = async (element: Element) => act(async () => { assert(element); element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); });
const change = async (input: HTMLInputElement, value: string) => act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
const select = async (label: string, value: string) => act(async () => { const input = field(label); Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
const submit = async (element: Element) => act(async () => { element.closest('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const repository = 'https://github.com/synthetic/example';
const files = [{ path: 'LICENSE', bytes: 60, license: true }, { path: 'tool.exe', bytes: 100, license: false }];
const inventory = { archivePath: 'D:/synthetic/download/example.zip', files, unpackedBytes: 160 };
const catalogue = { repository, author: 'synthetic', releases: [{ id: 11, tag: 'v1.0', name: 'Example', url: repository + '/releases/tag/v1.0', publishedAt: '', prerelease: false, assets: [{ id: 21, name: 'example-win-x64.zip', size: 90, digest: null, url: '', updatedAt: '' }, { id: 22, name: 'installer.exe', size: 250, url: '', updatedAt: '' }] }] };
const downloadPlan = { id: 'download-plan', kind: 'resourceDownload', repository, version: 'v1.0', author: 'synthetic', releaseId: 11, assetId: 21, assetName: 'example-win-x64.zip', downloadUrl: repository + '/releases/download/v1.0/example.zip', targetPath: inventory.archivePath, downloadBytes: 90, canApply: true, warnings: [] };
const downloaded = { ...inventory, downloadId: 'download-receipt', source: { repository, version: 'v1.0', verification: 'githubAsset', author: 'synthetic' } };
const savedDownload = { id: 'saved-download', status: 'interrupted', assetName: 'example-win-x64.zip', repository, version: 'v1.0', targetPath: inventory.archivePath, partialPath: inventory.archivePath + '.part', receivedBytes: 45, totalBytes: 90, updatedAt: '2026-10-28T00:00:00Z' };
function setup(override?: (command: string, args: any) => Promise<unknown> | undefined) {
  const calls: { command: string; args: any }[] = [];
  const action = async (_label: string, command: string, args: any) => {
    calls.push({ command, args });
    const custom = override?.(command, args); if (custom) return custom;
    if (command === 'resource_github_releases') return catalogue;
    if (command === 'preview_resource_download') return downloadPlan;
    if (command === 'resource_downloads') return { downloads: [savedDownload], total: 1, offset: args.offset, limit: args.limit };
    if (command === 'preview_resource_resume') return { ...downloadPlan, id: 'resume-plan' };
    if (command === 'apply_resource_download') return downloaded;
    if (command === 'resource_package_inspect') return inventory;
    if (command === 'preview_resource_install') return { id: 'install-plan', kind: 'resourceInstall', archivePath: args.archivePath, targetPath: args.destinationPath, files, selectedBytes: 160, source: { repository: args.repository, version: args.version, verification: args.downloadId ? 'githubAsset' : 'userProvided' }, canApply: true, warnings: [] };
    throw new Error(`Unexpected command ${command}`);
  };
  return { calls, action };
}
async function begin(action: (...args: any[]) => Promise<unknown>) {
  await act(async () => root().render(createElement(InstallResource, { action, onInstalled() {} })));
  await click(button('安装发行包')); await click(button('GitHub 发行版'));
  await change(field('GitHub 仓库或发行链接'), repository); await submit(button('查询发行版本'));
}
async function chooseZip() { await select('发行版本', '11'); await select('发行文件', '21'); await change(field('下载保存目录'), 'D:/synthetic/download'); }
async function selectInstallFiles() {
  await click(host.querySelectorAll('.resource-file-selection input')[1]);
  await change(field('名称'), 'Example'); await change(field('新版本保存目录'), 'D:/synthetic/install/v1');
}

test('GitHub lookup only reads metadata; unsupported assets never become silent ZIP downloads', async () => {
  const { calls, action } = setup(); await begin(action);
  assert.deepEqual(calls.map(item => item.command), ['resource_github_releases']);
  assert.equal(field('发行版本').value, '');
  await select('发行版本', '11'); await select('发行文件', '22');
  assert(host.textContent?.includes('当前安装流程尚不支持')); assert.equal(button('预览下载'), undefined);
  assert.equal(calls.length, 1);
});

test('official wheel uses the package preparation tab and preserves its actual download receipt', async () => {
  const official = 'https://github.com/panniantong/agent-reach';
  const wheelAsset = { ...catalogue.releases[0].assets[0], name: 'agent_reach-1.6.0-py3-none-any.whl', digest: 'sha256:' + 'a'.repeat(64) };
  const wheelCatalogue = { repository: official, author: 'synthetic', releases: [{ ...catalogue.releases[0], tag: 'v1.6.0', assets: [wheelAsset] }] };
  const wheelDownload = { ...downloaded, format: 'pythonWheel', archivePath: 'D:/synthetic/download/agent_reach-1.6.0-py3-none-any.whl', source: { repository: official, version: 'v1.6.0', verification: 'githubDigest' } };
  const { calls, action } = setup(command => command === 'resource_github_releases' ? Promise.resolve(wheelCatalogue) : command === 'apply_resource_download' ? Promise.resolve(wheelDownload) : undefined);
  let installed = 0;
  await act(async () => root().render(createElement(InstallResource, { action, onInstalled() { installed++; } })));
  await click(button('安装发行包')); await click(button('官方软件包'));
  assert.equal(calls.length, 0, 'Opening the package tab must not resolve, download or install.');
  assert.equal(field('GitHub 仓库或发行链接').value, official);
  await submit(button('查询发行版本'));
  await select('发行版本', '11'); await select('发行文件', '21');
  await change(field('下载保存目录'), 'D:/synthetic/download');
  await click(button('预览下载')); await click(button('确认下载此文件'));
  assert(host.textContent?.includes(`已下载的官方发行包：${wheelDownload.archivePath}`));
  assert.equal(host.querySelector('[aria-label="发行包文件清单"]'), null, 'A wheel is not installed as a selected ZIP.');
  assert.equal(installed, 0);
  assert.deepEqual(calls.map(item => item.command), ['resource_github_releases', 'preview_resource_download', 'apply_resource_download']);
});

test('ordinary ZIP installation does not accept a wheel receipt restored from download history', async () => {
  const { action } = setup(command => command === 'apply_resource_download' ? Promise.resolve({ ...downloaded, format: 'pythonWheel' }) : undefined);
  await begin(action); await chooseZip(); await click(button('预览下载')); await click(button('确认下载此文件'));
  assert(host.querySelector('[role="alert"]')?.textContent?.includes('另一种安装方式'));
  assert.equal(host.querySelector('[aria-label="发行包文件清单"]'), null);
});

test('download confirmation binds chosen source, destination and speed; editing invalidates it', async () => {
  const { calls, action } = setup(); await begin(action); await chooseZip();
  await change(field('下载限速（MiB/s，0 为不限速）'), '1.5'); await click(button('预览下载'));
  assert.deepEqual(calls.at(-1)?.args, { repository, releaseId: 11, assetId: 21, downloadDirectory: 'D:/synthetic/download', bytesPerSecond: 1572864 });
  assert(host.querySelector('[aria-label="下载影响清单"]')); assert(host.textContent?.includes('上游未提供'));
  assert(!calls.some(item => item.command === 'apply_resource_download'));
  await change(field('下载保存目录'), 'D:/synthetic/another');
  assert.equal(host.querySelector('[aria-label="下载影响清单"]'), null); assert.equal(button('确认下载此文件'), undefined);
});

test('download speed exposes the existing 1 GiB/s bound and preserves a fractional 16 KiB/s preview', async () => {
  const { calls, action } = setup(); await begin(action); await chooseZip();
  const input = field('下载限速（MiB/s，0 为不限速）');
  await change(input, '1024.000001');
  assert.equal(input.validity.rangeOverflow, true, 'The native numeric control must reject rates above 1 GiB/s.');
  await change(input, '1024');
  assert.equal(input.checkValidity(), true, 'The existing maximum rate remains available.');
  await change(input, '0.015625');
  assert.equal(input.checkValidity(), true, 'Fractional MiB/s must remain valid without an integer step restriction.');
  await click(button('预览下载'));
  assert.deepEqual(calls.at(-1)?.args, { repository, releaseId: 11, assetId: 21, downloadDirectory: 'D:/synthetic/download', bytesPerSecond: 16384 });
  assert(host.querySelector('[aria-label="下载影响清单"]'));
  assert(!calls.some(item => item.command === 'apply_resource_download'));
});

test('download settings submit previews without requerying and IME Enter does not submit', async () => {
  const { calls, action } = setup(); await begin(action); await chooseZip();
  const input = field('下载保存目录');
  const composing = new dom.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
  await act(async () => { input.dispatchEvent(composing); });
  assert.equal(composing.defaultPrevented, true); assert.equal(calls.length, 1);
  await submit(input);
  assert.deepEqual(calls.map(item => item.command), ['resource_github_releases', 'preview_resource_download']);
});

test('one explicit download connects its receipt to selected-file installation and source edits invalidate proof', async () => {
  const waiting = deferred<unknown>();
  const { calls, action } = setup(command => command === 'apply_resource_download' ? waiting.promise : undefined);
  await begin(action); await chooseZip(); await click(button('预览下载'));
  const confirm = button('确认下载此文件');
  await act(async () => { confirm.click(); confirm.click(); });
  assert.equal(calls.filter(item => item.command === 'apply_resource_download').length, 1);
  assert.equal(button('本地 ZIP').disabled, true);
  await act(async () => { waiting.resolve(downloaded); });
  assert.equal(field('原 GitHub 仓库').value, repository); assert.equal(field('固定版本').value, 'v1.0');
  assert.equal(host.querySelector('[aria-label="下载影响清单"]'), null);
  await selectInstallFiles(); await submit(button('预览安装'));
  assert.equal(calls.at(-1)?.args.downloadId, 'download-receipt'); assert.deepEqual(calls.at(-1)?.args.selectedFiles, ['LICENSE', 'tool.exe']);
  assert(host.textContent?.includes('来源与下载回执已核对'));
  await change(field('固定版本'), 'v2');
  assert.equal(host.querySelector('[aria-label="安装影响清单"]'), null); assert(host.textContent?.includes('下载来源证明已失效'));
  await submit(button('预览安装')); assert.equal(calls.at(-1)?.args.downloadId, undefined);
  assert(host.textContent?.includes('来源由本次填写'));
});

test('failed download is not retried automatically and retains the exact confirmation for an explicit resume', async () => {
  let attempt = 0;
  const { calls, action } = setup(command => command === 'apply_resource_download' ? (++attempt === 1 ? Promise.reject(new Error('网络中断，已保留部分文件')) : Promise.resolve(downloaded)) : undefined);
  await begin(action); await chooseZip(); await click(button('预览下载')); await click(button('确认下载此文件'));
  assert(host.textContent?.includes('网络中断')); assert(host.querySelector('[aria-label="下载影响清单"]'));
  assert.equal(calls.filter(item => item.command === 'apply_resource_download').length, 1);
  await click(button('确认下载此文件'));
  assert.deepEqual(calls.filter(item => item.command === 'apply_resource_download').map(item => item.args), [{ previewId: 'download-plan' }, { previewId: 'download-plan' }]);
  assert(host.querySelector('[aria-label="发行包文件清单"]'));
});

test('unmounted GitHub downloader ignores late completion and never forwards a stale install receipt', async () => {
  const waiting = deferred<unknown>(); let received = 0;
  const { action } = setup(command => command === 'apply_resource_download' ? waiting.promise : undefined);
  await act(async () => root().render(createElement(ResourceGithub, { action, onDownloaded() { received++; }, onReset() {}, onBusyChange() {} })));
  await change(field('GitHub 仓库或发行链接'), repository); await submit(button('查询发行版本')); await chooseZip(); await click(button('预览下载')); await click(button('确认下载此文件'));
  await act(async () => cleanup()); cleanup = () => {};
  await act(async () => waiting.resolve(downloaded)); assert.equal(received, 0);
});

test('local ZIP path retains inspection and manual-source installation without GitHub calls', async () => {
  const { calls, action } = setup(); await act(async () => root().render(createElement(InstallResource, { action, onInstalled() {} })));
  await click(button('安装发行包')); await change(field('发行包'), inventory.archivePath); await click(button('读取清单'));
  await selectInstallFiles(); await submit(button('预览安装'));
  assert.deepEqual(calls.map(item => item.command), ['resource_package_inspect', 'preview_resource_install']);
  assert.equal(calls.at(-1)?.args.downloadId, undefined); assert(host.textContent?.includes('来源由本次填写'));
});

test('saved downloads load only on demand, preview without downloading, then require explicit resume confirmation', async () => {
  const { calls, action } = setup();
  await act(async () => root().render(createElement(InstallResource, { action, onInstalled() {} })));
  await click(button('安装发行包')); await click(button('GitHub 发行版'));
  assert.equal(calls.length, 0);
  await click(button('继续已有下载'));
  assert.deepEqual(calls.map(item => item.command), ['resource_downloads']);
  assert(host.textContent?.includes('50%')); assert(host.textContent?.includes(savedDownload.partialPath));
  await click(button('核对并继续'));
  assert.deepEqual(calls.at(-1), { command: 'preview_resource_resume', args: { downloadId: 'saved-download' } });
  assert.equal(calls.filter(item => item.command === 'apply_resource_download').length, 0);
  assert(host.querySelector('[aria-label="下载影响清单"]'));
  await click(button('确认继续此文件'));
  assert.deepEqual(calls.at(-1), { command: 'apply_resource_download', args: { previewId: 'resume-plan' } });
  assert(host.querySelector('[aria-label="发行包文件清单"]')); await selectInstallFiles(); await submit(button('预览安装'));
  assert.equal(calls.at(-1)?.args.downloadId, 'download-receipt');
});

test('editing the source invalidates a restored confirmation; mounting again never resumes implicitly', async () => {
  const { calls, action } = setup();
  await act(async () => root().render(createElement(ResourceGithub, { action, onDownloaded() {}, onReset() {}, onBusyChange() {} })));
  await click(button('继续已有下载')); await click(button('核对并继续'));
  await change(field('固定版本（可选）'), 'v2');
  assert.equal(host.querySelector('[aria-label="下载影响清单"]'), null);
  assert.equal(button('确认继续此文件'), undefined);
  await act(async () => cleanup()); cleanup = () => {};
  await act(async () => root().render(createElement(ResourceGithub, { action, onDownloaded() {}, onReset() {}, onBusyChange() {} })));
  assert.deepEqual(calls.map(item => item.command), ['resource_downloads', 'preview_resource_resume']);
  assert.equal(host.querySelector('[aria-label="已有下载记录"]'), null);
});

test('late restored-preview response cannot recreate confirmation in a new downloader instance', async () => {
  const waiting = deferred<unknown>();
  const { calls, action } = setup(command => command === 'preview_resource_resume' ? waiting.promise : undefined);
  await act(async () => root().render(createElement(ResourceGithub, { action, onDownloaded() {}, onReset() {}, onBusyChange() {} })));
  await click(button('继续已有下载')); await click(button('核对并继续'));
  await act(async () => cleanup()); cleanup = () => {};
  await act(async () => root().render(createElement(ResourceGithub, { action, onDownloaded() {}, onReset() {}, onBusyChange() {} })));
  await act(async () => waiting.resolve({ ...downloadPlan, id: 'stale-resume' }));
  assert.equal(host.querySelector('[aria-label="下载影响清单"]'), null);
  assert.deepEqual(calls.map(item => item.command), ['resource_downloads', 'preview_resource_resume']);
});

test('completed saved download requires local-file confirmation before restoring the install receipt', async () => {
  let received = 0;
  const { calls, action } = setup(command => command === 'resource_downloads' ? Promise.resolve({ downloads: [{ ...savedDownload, status: 'complete', receivedBytes: 90 }], total: 1, offset: 0, limit: 20 }) : command === 'preview_resource_resume' ? Promise.resolve({ ...downloadPlan, id: 'reuse-plan', alreadyComplete: true }) : undefined);
  await act(async () => root().render(createElement(ResourceGithub, { action, onDownloaded() { received++; }, onReset() {}, onBusyChange() {} })));
  await click(button('继续已有下载')); await click(button('核对已下载文件'));
  assert.equal(received, 0); assert(host.textContent?.includes('不再次下载'));
  assert.equal(button('确认继续此文件'), undefined); assert.equal(button('确认下载此文件'), undefined);
  await click(button('使用已完成文件'));
  assert.deepEqual(calls.at(-1), { command: 'apply_resource_download', args: { previewId: 'reuse-plan' } });
  assert.equal(received, 1);
});

test('download history pages only on explicit navigation, bounds requests and invalidates earlier confirmation', async () => {
  const records = Array.from({ length: 41 }, (_value, index) => ({ ...savedDownload, id: `saved-${index}`, assetName: `example-${index}.zip` }));
  const { calls, action } = setup((command, args) => command === 'resource_downloads' ? Promise.resolve({ downloads: records.slice(args.offset, args.offset + args.limit), total: records.length, offset: args.offset, limit: args.limit }) : undefined);
  await act(async () => root().render(createElement(ResourceGithub, { action, onDownloaded() {}, onReset() {}, onBusyChange() {} })));
  assert.equal(calls.length, 0);
  await click(button('继续已有下载'));
  assert.deepEqual(calls.at(-1), { command: 'resource_downloads', args: { offset: 0, limit: 20 } });
  assert.equal(host.querySelectorAll('[aria-label="下载记录列表"] li').length, 20);
  assert(host.textContent?.includes('第 1–20 条，共 41 条')); assert.equal(button('上一页').disabled, true);
  await click(button('核对并继续')); assert(host.querySelector('[aria-label="下载影响清单"]'));
  await click(button('下一页'));
  assert.equal(host.querySelector('[aria-label="下载影响清单"]'), null);
  assert(host.textContent?.includes('第 21–40 条，共 41 条'));
  assert.equal(host.querySelector('[aria-label="下载记录列表"] strong')?.textContent, 'example-20.zip');
  await click(button('刷新记录'));
  assert.deepEqual(calls.at(-1)?.args, { offset: 20, limit: 20 });
  await click(button('下一页'));
  assert(host.textContent?.includes('第 41–41 条，共 41 条')); assert.equal(button('下一页').disabled, true);
  assert.equal(host.querySelectorAll('[aria-label="下载记录列表"] li').length, 1);
  await click(button('上一页')); assert.deepEqual(calls.at(-1)?.args, { offset: 20, limit: 20 });
  assert(calls.every(item => ['resource_downloads', 'preview_resource_resume'].includes(item.command)));
  assert.equal(records.length, 41);
});

test('pending history navigation submits once and a late page never appears after remount', async () => {
  const waiting = deferred<unknown>();
  const { calls, action } = setup((command, args) => command === 'resource_downloads' ? args.offset === 20 ? waiting.promise : Promise.resolve({ downloads: [savedDownload], total: 21, offset: 0, limit: 20 }) : undefined);
  await act(async () => root().render(createElement(ResourceGithub, { action, onDownloaded() {}, onReset() {}, onBusyChange() {} })));
  await click(button('继续已有下载'));
  const next = button('下一页'); await act(async () => { next.click(); next.click(); });
  assert.equal(calls.filter(item => item.command === 'resource_downloads' && item.args.offset === 20).length, 1);
  assert.equal(next.disabled, true);
  await act(async () => cleanup()); cleanup = () => {};
  await act(async () => root().render(createElement(ResourceGithub, { action, onDownloaded() {}, onReset() {}, onBusyChange() {} })));
  await act(async () => waiting.resolve({ downloads: [{ ...savedDownload, assetName: 'stale-second-page.zip' }], total: 21, offset: 20, limit: 20 }));
  assert.equal(host.querySelector('[aria-label="已有下载记录"]'), null);
  assert(!host.textContent?.includes('stale-second-page.zip')); assert.equal(calls.length, 2);
});

test('failed page load preserves the readable page and refresh repeats that page rather than applying a download', async () => {
  const { calls, action } = setup((command, args) => command === 'resource_downloads' ? args.offset === 20 ? Promise.reject(new Error('记录读取失败')) : Promise.resolve({ downloads: [savedDownload], total: 21, offset: 0, limit: 20 }) : undefined);
  await act(async () => root().render(createElement(ResourceGithub, { action, onDownloaded() {}, onReset() {}, onBusyChange() {} })));
  await click(button('继续已有下载')); await click(button('下一页'));
  assert(host.textContent?.includes('记录读取失败')); assert(host.textContent?.includes(savedDownload.assetName));
  assert(host.textContent?.includes('第 1–1 条，共 21 条')); assert.equal(button('下一页').disabled, false);
  await click(button('刷新记录'));
  assert.deepEqual(calls.map(item => item.args), [{ offset: 0, limit: 20 }, { offset: 20, limit: 20 }, { offset: 0, limit: 20 }]);
  assert(calls.every(item => item.command === 'resource_downloads'));
});
