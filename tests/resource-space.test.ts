import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
let code = ts.transpileModule(await readFile(new URL('../src/ResourceSpace.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText.replace(/import\s+['"][^'"]+\.css['"];?/g, '');
code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, name: string) => `from ${JSON.stringify(import.meta.resolve(name))}`);
const { ResourceSpace } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const host = document.getElementById('root')!;
let cleanup = () => {};
afterEach(async () => { await act(async () => cleanup()); cleanup = () => {}; });
const snapshot = (id = 'one') => ({ endpoint: { kind: 'tool', id }, rootPath: 'D:/synthetic', scannedAt: '2026-10-30T00:00:00Z', observedBytes: 1024, fileCount: 2, partial: true, skippedCount: 1, reasons: ['目录联接未跟随'], categories: [{ id: 'runtime', label: '运行文件', bytes: 1024, files: 2 }, { id: 'previous', label: '上一版本', bytes: null, files: null, reason: '尚无独立记录' }], sharedDependencies: [{ kind: 'tool', id: 'shared', name: '共享服务', exists: true }], basis: '只计量本次目录内实际读取的文件' });
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!;
const click = async (label: string) => act(async () => button(label).click());
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(handler: (command: string, args: any) => unknown = () => snapshot()) {
  const calls: { action: string; args: any }[] = [], root = createRoot(host); cleanup = () => root.unmount();
  const action = async (_label: string, command: string, args: any) => { calls.push({ action: command, args }); return handler(command, args); };
  return { calls, render: async (props = {}) => act(async () => root.render(createElement(ResourceSpace, { endpoint: { kind: 'tool', id: 'one' }, revision: 1, action, ...props }))) };
}

test('statistics run only on explicit demand and never scan while hidden or after unrelated renders', async () => {
  const f = fixture(); await f.render(); assert.equal(f.calls.length, 0);
  await f.render({ visible: false }); await click('统计本目录空间'); assert.equal(f.calls.length, 0);
  await f.render(); await click('统计本目录空间'); await f.render();
  assert.deepEqual(f.calls, [{ action: 'resource_space', args: { kind: 'tool', id: 'one' } }]);
  assert(host.textContent!.includes('已读取部分：1 KiB')); assert(host.textContent!.includes('未知'));
  assert(host.textContent!.includes('目录联接未跟随')); assert(host.textContent!.includes('共享目录不额外叠加'));
});

test('record changes keep timestamped statistics but do not trigger a rescan', async () => {
  const f = fixture(); await f.render(); await click('统计本目录空间'); await f.render({ revision: 2 });
  assert.equal(f.calls.length, 1); assert(host.textContent!.includes('保留上次统计')); assert(host.textContent!.includes('1 KiB'));
});

test('failed scans retain the prior result and wait for explicit retry', async () => {
  let count = 0; const f = fixture(() => { if (++count === 2) throw new Error('实际目录不可用'); return snapshot(); });
  await f.render(); await click('统计本目录空间'); await click('重新统计'); await f.render();
  assert.equal(count, 2); assert(host.textContent!.includes('实际目录不可用')); assert(host.textContent!.includes('1 KiB'));
});

test('late results never replace another resource and duplicate clicks are coalesced', async () => {
  const pending = deferred<ReturnType<typeof snapshot>>(); const f = fixture(() => pending.promise);
  await f.render(); await act(async () => { button('统计本目录空间').click(); button('统计本目录空间').click(); }); assert.equal(f.calls.length, 1);
  await f.render({ endpoint: { kind: 'skill', id: 'another' } }); await act(async () => pending.resolve(snapshot()));
  assert(!host.textContent!.includes('1 KiB')); assert.equal(f.calls.length, 1);
});

test('retained versions show their actual multi-directory scope and keep unknown sizes explicit', async () => {
  const f = fixture(() => ({ ...snapshot(), partial: false, scope: 'registeredRuntimeRoots', rootCount: 3 }));
  await f.render(); await click('统计本目录空间');
  assert(host.textContent!.includes('已登记版本目录的文件'));
  assert(host.textContent!.includes('3 个目录'));
  assert(host.textContent!.includes('未知'));
  assert(!host.textContent!.includes('本目录已读取文件'));
});
