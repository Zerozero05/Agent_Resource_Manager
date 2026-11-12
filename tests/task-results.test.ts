import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
let code = ts.transpileModule(await readFile(new URL('../src/TaskResults.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText.replace(/import\s+['"][^'"]+\.css['"];?/g, '');
code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, name: string) => `from ${JSON.stringify(import.meta.resolve(name))}`);
const { TaskResults } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const host = document.getElementById('root')!;
let cleanup = () => {};
afterEach(async () => { await act(async () => cleanup()); cleanup = () => {}; });
const file = { id: 'output-one', label: '导出文件', path: 'D:/synthetic/output.zip', status: 'available', reason: '', canOpen: true, canOpenFolder: true };
const snapshot = (taskId = 'one', patch = {}) => ({ taskId, files: [{ ...file, ...patch }] });
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!;
const click = async (label: string) => act(async () => button(label).click());
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(handler: (command: string, args: any) => unknown = () => snapshot()) {
  const calls: { action: string; args: any }[] = [];
  const root = createRoot(host); cleanup = () => root.unmount();
  const request = async (action: string, args: any) => { calls.push({ action, args }); return handler(action, args); };
  return { calls, render: async (props = {}) => act(async () => root.render(createElement(TaskResults, { taskId: 'one', request, ...props }))) };
}

test('result viewing only validates saved locations and remains lazy while hidden', async () => {
  const f = fixture(); await f.render({ visible: false }); assert.equal(f.calls.length, 0);
  await f.render(); await f.render(); assert.deepEqual(f.calls, [{ action: 'task_result_files', args: { taskId: 'one' } }]);
  assert(host.textContent!.includes(file.path));
  await click('打开结果'); assert.deepEqual(f.calls.at(-1), { action: 'task_open_result', args: { taskId: 'one', resultId: file.id, folder: false } });
  await click('打开所在目录'); assert.deepEqual(f.calls.at(-1), { action: 'task_open_result', args: { taskId: 'one', resultId: file.id, folder: true } });
  assert(f.calls.every(call => ['task_result_files', 'task_open_result'].includes(call.action)));
});

test('missing files preserve the path and reason with an available parent folder', async () => {
  const f = fixture(() => snapshot('one', { status: 'unavailable', canOpen: false, reason: '结果位置已不存在' }));
  await f.render(); assert(button('打开结果').disabled); assert(!button('打开所在目录').disabled);
  assert.equal(host.querySelector('[role="alert"]')?.textContent, '结果位置已不存在');
  await click('打开结果'); assert.equal(f.calls.length, 1);
});

test('Basic can inspect and open a folder but cannot open a result in another program', async () => {
  const f = fixture(); await f.render({ basicMode: true });
  assert(button('打开结果').disabled); await click('打开结果'); assert.equal(f.calls.length, 1);
  await click('打开所在目录'); assert.equal(f.calls.length, 2); assert.equal(f.calls[1].args.folder, true);
});

test('same-turn double clicks dispatch one open and a failure never retries automatically', async () => {
  const pending = deferred<unknown>(); const f = fixture(command => command === 'task_open_result' ? pending.promise : snapshot());
  await f.render(); await act(async () => { button('打开结果').click(); button('打开结果').click(); });
  assert.equal(f.calls.length, 2); await act(async () => pending.reject(new Error('文件已被移动')));
  await f.render(); assert.equal(f.calls.length, 2); assert(host.textContent!.includes('文件已被移动'));
});

test('failed revalidation keeps the previous location visible and allows explicit retry', async () => {
  let attempt = 0; const f = fixture(() => { if (++attempt === 2) throw new Error('读取位置失败'); return snapshot(); });
  await f.render(); await click('重新核对位置'); assert(host.textContent!.includes(file.path));
  assert(host.textContent!.includes('读取位置失败')); await f.render(); assert.equal(attempt, 2);
  await click('重新核对位置'); assert.equal(attempt, 3);
});

test('late previous-task results and foreign identities never replace the displayed task', async () => {
  const pending = deferred<ReturnType<typeof snapshot>>();
  const f = fixture((_command, args) => args.taskId === 'one' ? pending.promise : snapshot('two', { path: 'D:/synthetic/two.zip' }));
  await f.render(); await f.render({ taskId: 'two' });
  await act(async () => pending.resolve(snapshot())); assert(!host.textContent!.includes(file.path));
  assert(host.textContent!.includes('D:/synthetic/two.zip'));
  await click('打开结果'); assert.equal(f.calls.at(-1)!.args.taskId, 'two');
});

test('a mismatched task response provides an error without an open action', async () => {
  const f = fixture(() => snapshot('foreign'));
  await f.render(); assert(host.textContent!.includes('结果记录不匹配')); assert.equal(button('打开结果'), undefined);
});
