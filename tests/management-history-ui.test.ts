import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement, act } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

let code = ts.transpileModule(await readFile(new URL('../src/management-history.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, value) => `from ${JSON.stringify(import.meta.resolve(value))}`);
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const { ManagementHistoryControls, useManagementHistory } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const host = document.getElementById('root')!;
const entry = { available: true, entryId: 'first', label: '归类 2 个 Skill' };
const options = { undo: entry, redo: { ...entry, entryId: 'second', label: '更改分类颜色' }, active: true, readOnly: false, busy: false, modal: false, canApply: () => true };
const button = (direction: 'undo' | 'redo') => host.querySelector<HTMLButtonElement>(`[aria-label="${direction === 'undo' ? '撤销' : '重做'}管理操作"]`)!;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
let cleanup = () => {};
afterEach(async () => { await act(async () => cleanup()); cleanup = () => {}; document.querySelectorAll('[data-test-overlay]').forEach(node => node.remove()); });
function Harness(props: any) {
  const history = useManagementHistory(props);
  return createElement('section', null,
    createElement(ManagementHistoryControls, { history }),
    createElement('input', { 'aria-label': '输入' }), createElement('textarea'), createElement('select'),
    createElement('div', { contentEditable: true, suppressContentEditableWarning: true }, createElement('span', { 'data-editor-child': true }, '编辑文字')),
    createElement('div', { role: 'textbox', tabIndex: 0 }),
  );
}
function fixture(custom?: (...args: any[]) => Promise<void>) {
  const calls: unknown[][] = [], root = createRoot(host);
  cleanup = () => root.unmount();
  const onApply = async (...args: unknown[]) => { calls.push(args); await custom?.(...args); };
  return { calls, render: async (changes = {}) => act(async () => root.render(createElement(Harness, { ...options, onApply, ...changes }))) };
}
async function click(node: HTMLButtonElement) { await act(async () => node.click()); }
async function key(init: KeyboardEventInit, target: EventTarget = window, prevented = false) {
  const event = new dom.window.KeyboardEvent('keydown', { ctrlKey: true, bubbles: true, cancelable: true, ...init });
  if (prevented) event.preventDefault();
  await act(async () => target.dispatchEvent(event));
  return event;
}

test('buttons identify the exact operation and submit its current history entry', async () => {
  const value = fixture(); await value.render();
  assert(button('undo').textContent?.includes(entry.label));
  assert(button('redo').textContent?.includes('更改分类颜色'));
  assert(button('redo').title.includes('Ctrl+Shift+Z'));
  await click(button('undo')); await click(button('redo'));
  assert.deepEqual(value.calls, [['undo', 'first', entry.label], ['redo', 'second', '更改分类颜色']]);
  await value.render({ redo: { ...entry, entryId: 'new-entry', label: '收藏 Skill' } });
  await click(button('redo'));
  assert.deepEqual(value.calls.at(-1), ['redo', 'new-entry', '收藏 Skill']);
});

test('Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z share the buttons and do not claim other combinations', async () => {
  const value = fixture(); await value.render();
  for (const input of [{ key: 'z' }, { key: 'y' }, { key: 'Z', shiftKey: true }]) assert.equal((await key(input)).defaultPrevented, true);
  assert.deepEqual(value.calls.map(call => call[0]), ['undo', 'redo', 'redo']);
  for (const input of [{ key: 'y', shiftKey: true }, { key: 'z', ctrlKey: false }, { key: 'a' }, { key: 'z', altKey: true }, { key: 'y', metaKey: true }]) assert.equal((await key(input)).defaultPrevented, false);
  assert.equal(value.calls.length, 3);
});

test('global sidebar buttons keep their entry while only the active business page consumes undo shortcuts', async () => {
  const homeCalls: unknown[][] = [], businessCalls: unknown[][] = [], root = createRoot(host); cleanup = () => root.unmount();
  await act(async () => root.render(createElement('div', null,
    createElement(Harness, { ...options, shortcutActive: false, onApply: async (...args: unknown[]) => { homeCalls.push(args); } }),
    createElement(Harness, { ...options, shortcutActive: true, onApply: async (...args: unknown[]) => { businessCalls.push(args); } }),
  )));
  const homeUndo = host.querySelectorAll<HTMLButtonElement>('[aria-label="撤销管理操作"]')[0]; assert.equal(homeUndo.disabled, false);
  await click(homeUndo); assert.deepEqual(homeCalls, [['undo', 'first', entry.label]]); assert.equal(businessCalls.length, 0);
  assert.equal((await key({ key: 'z' })).defaultPrevented, true); assert.equal(homeCalls.length, 1); assert.deepEqual(businessCalls, [['undo', 'first', entry.label]]);
});

test('text input, editable descendants and focused editors keep native undo and redo', async () => {
  const value = fixture(); await value.render();
  const targets = host.querySelectorAll('input,textarea,select,[data-editor-child],[role="textbox"]');
  for (const target of targets) for (const input of [{ key: 'z' }, { key: 'y' }, { key: 'Z', shiftKey: true }]) assert.equal((await key(input, target)).defaultPrevented, false);
  host.querySelector('input')!.focus();
  assert.equal((await key({ key: 'z' }, window)).defaultPrevented, false);
  assert.equal(value.calls.length, 0);
});

test('IME, repeated keys and already handled events do not invoke management history', async () => {
  const value = fixture(); await value.render();
  assert.equal((await key({ key: 'z', isComposing: true })).defaultPrevented, false);
  assert.equal((await key({ key: 'y', repeat: true })).defaultPrevented, false);
  await key({ key: 'Z', shiftKey: true }, window, true);
  assert.equal(value.calls.length, 0);
});

test('inactive, read-only, busy and modal panes disable buttons and leave keyboard events untouched', async () => {
  const value = fixture();
  for (const change of [{ active: false }, { readOnly: true }, { busy: true }, { modal: true }]) {
    await value.render(change);
    assert(button('undo').disabled); assert(button('redo').disabled);
    await click(button('redo')); assert.equal((await key({ key: 'y' })).defaultPrevented, false);
  }
  await value.render({ canApply: () => false });
  await click(button('undo')); assert.equal((await key({ key: 'z' })).defaultPrevented, false);
  assert.equal(value.calls.length, 0);
});

test('a dialog owned by another pane also keeps global history shortcuts inactive', async () => {
  const value = fixture(); await value.render();
  const dialog = document.createElement('section'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('data-test-overlay', ''); document.body.append(dialog);
  assert.equal((await key({ key: 'z' })).defaultPrevented, false);
  await click(button('redo')); assert.equal(value.calls.length, 0);
  dialog.remove(); await key({ key: 'y' }); assert.equal(value.calls.length, 1);
});

test('pending apply has one immediate lock across buttons and shortcuts without replaying the next entry', async () => {
  const pending = deferred(), value = fixture(() => pending.promise); await value.render();
  const undo = button('undo'), redo = button('redo');
  await act(async () => { undo.click(); redo.click(); undo.click(); });
  assert(button('undo').disabled); assert(button('redo').disabled);
  assert.equal((await key({ key: 'y' })).defaultPrevented, false);
  await value.render({ undo: { ...entry, entryId: 'new-entry' } });
  assert.equal(value.calls.length, 1); assert.deepEqual(value.calls[0], ['undo', 'first', entry.label]);
  await act(async () => pending.resolve());
  assert.equal(button('undo').disabled, false);
  assert.equal(value.calls.length, 1);
});

test('missing entry IDs and unavailable branches cannot dispatch from buttons or keys', async () => {
  const value = fixture();
  await value.render({ undo: { available: true, label: 'Unknown' }, redo: { ...entry, available: false } });
  assert(button('undo').disabled); assert(button('redo').disabled);
  await click(button('undo')); await click(button('redo'));
  assert.equal((await key({ key: 'z' })).defaultPrevented, false); assert.equal((await key({ key: 'y' })).defaultPrevented, false);
  assert.equal(value.calls.length, 0);
});

test('only the active pane handles a shortcut and removing it removes the listener', async () => {
  const calls: unknown[][] = [], root = createRoot(host); cleanup = () => root.unmount();
  await act(async () => root.render(createElement('div', null,
    createElement(Harness, { ...options, active: false, onApply: async (...args: unknown[]) => { calls.push(['inactive', ...args]); } }),
    createElement(Harness, { ...options, onApply: async (...args: unknown[]) => { calls.push(['active', ...args]); } }),
  )));
  await key({ key: 'Z', shiftKey: true });
  assert.deepEqual(calls, [['active', 'redo', 'second', '更改分类颜色']]);
  await act(async () => root.unmount()); cleanup = () => {};
  assert.equal((await key({ key: 'y' })).defaultPrevented, false); assert.equal(calls.length, 1);
});
