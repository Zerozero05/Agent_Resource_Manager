import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act, createElement, useState } from 'react';
import { createPortal } from 'react-dom';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLDetailsElement: dom.window.HTMLDetailsElement, Element: dom.window.Element, Node: dom.window.Node, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const { createRoot } = await import('react-dom/client');
let code = ts.transpileModule(await readFile(new URL('../src/WorkspaceShell.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText.replace(/import\s+['"][^'"]+\.css['"];?/g, '');
code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, name: string) => `from ${JSON.stringify(name.startsWith('.') ? new URL(`${name}.ts`, new URL('../src/WorkspaceShell.tsx', import.meta.url)).href : import.meta.resolve(name))}`);
const { WorkspaceShell } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const host = document.getElementById('root')!;
let unmount = () => {};
afterEach(async () => { await act(async () => unmount()); unmount = () => {}; });
const click = async (element: Element) => act(async () => { assert(element); element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
const sidebar = () => host.querySelector<HTMLButtonElement>('.workspace-sidebar-toggle')!;
const home = { id: 'home', kind: 'home', state: {} }, detail = { id: 'detail', kind: 'detail', skillId: 'one', title: '示例 Skill', state: {} };

test('sidebar control stays before tabs in the fixed toolbar and preserves mounted page state when collapsed', async () => {
  const changes: boolean[] = [];
  function Harness() {
    const [expanded, setExpanded] = useState(true), [count, setCount] = useState(0);
    return createElement(WorkspaceShell, { panes: [home, detail], activePaneId: 'home', sidebarExpanded: expanded, onToggleSidebar: () => setExpanded(value => { changes.push(!value); return !value; }), onActivate: () => {}, onClose: () => {}, onReorder: () => {}, onDetach: () => {}, renderPane: (pane: any) => pane.id === 'home' ? createElement('div', null, createElement('button', { onClick: () => setCount(value => value + 1) }, `保留状态 ${count}`)) : createElement('p', null, '业务内容') });
  }
  const view = createRoot(host); unmount = () => view.unmount(); await act(async () => view.render(createElement(Harness)));
  const owner = sidebar(); assert.equal(owner.parentElement?.className, 'workspace-bar'); assert.equal(owner.nextElementSibling?.getAttribute('role'), 'tablist'); assert.equal(owner.closest('.workspace-pages'), null);
  await click(host.querySelector('.workspace-page button')!); await click(owner);
  assert.equal(sidebar(), owner); assert.equal(sidebar().getAttribute('aria-label'), '展开侧栏'); assert.equal(sidebar().getAttribute('aria-expanded'), 'false'); assert(host.textContent?.includes('保留状态 1'));
  await click(sidebar()); assert.equal(sidebar().getAttribute('aria-label'), '收起侧栏'); assert.deepEqual(changes, [false, true]); assert(host.textContent?.includes('保留状态 1'));
});

test('toolbar control remains available for a business tab and split panes without navigating or invoking tasks', async () => {
  let toggled = 0; const activations: string[] = [], view = createRoot(host); unmount = () => view.unmount();
  const props = { panes: [home, detail], activePaneId: 'detail', sidebarExpanded: false, onToggleSidebar: () => toggled++, onActivate: (id: string) => activations.push(id), onClose: () => {}, onReorder: () => {}, onDetach: () => {}, renderPane: (pane: any) => createElement('p', null, pane.id) };
  await act(async () => view.render(createElement(WorkspaceShell, props))); await click(sidebar()); assert.equal(toggled, 1); assert.deepEqual(activations, []);
  await act(async () => view.render(createElement(WorkspaceShell, { ...props, splitView: { rightPaneId: 'detail', ratio: 0.55 }, onSplitChange: () => {} }))); await click(sidebar());
  assert.equal(toggled, 2); assert.equal(host.querySelectorAll('.workspace-page:not([hidden])').length, 2); assert.deepEqual(activations, []);
});

test('closing blocks the toolbar action and ordinary tab shortcuts remain unchanged', async () => {
  let toggled = 0, closed = 0; const activations: string[] = [], view = createRoot(host); unmount = () => view.unmount();
  const props = { panes: [home, detail], activePaneId: 'detail', sidebarExpanded: true, onToggleSidebar: () => toggled++, onActivate: (id: string) => activations.push(id), onClose: () => closed++, onReorder: () => {}, onDetach: () => {}, renderPane: () => null };
  await act(async () => view.render(createElement(WorkspaceShell, { ...props, shortcutsBlocked: true }))); assert.equal(sidebar().disabled, true); await click(sidebar()); assert.equal(toggled, 0);
  await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true }))); assert.equal(closed, 0);
  await act(async () => view.render(createElement(WorkspaceShell, props)));
  await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true, cancelable: true }))); assert.deepEqual(activations, ['home']);
  await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true }))); assert.equal(closed, 1);
});

test('one real portal sidebar stays outside hidden Home and does not activate Home through React capture bubbling', async () => {
  const activations: string[] = []; let renders = 0;
  function Harness({ split = false }: { split?: boolean }) {
    const [sidebarHost, setSidebarHost] = useState<HTMLDivElement | null>(null), [count, setCount] = useState(0);
    const side = createElement('aside', { 'aria-label': '唯一测试侧栏' }, createElement('button', { onClick: () => setCount(value => value + 1) }, `保留侧栏状态 ${count}`));
    renders++;
    return createElement(WorkspaceShell, { panes: [home, detail], activePaneId: 'detail', onSidebarHost: setSidebarHost, sidebarExpanded: true, onToggleSidebar: () => {}, splitView: split ? { rightPaneId: 'detail', ratio: 0.55 } : undefined, onSplitChange: () => {}, onActivate: (id: string) => activations.push(id), onClose: () => {}, onReorder: () => {}, onDetach: () => {}, renderPane: (pane: any) => pane.id === 'home' ? createElement('div', null, sidebarHost && createPortal(side, sidebarHost), '工作台') : createElement('p', null, '业务内容') });
  }
  const view = createRoot(host); unmount = () => view.unmount(); await act(async () => view.render(createElement(Harness)));
  const side = host.querySelector('aside')!, action = side.querySelector('button')!;
  assert.equal(side.closest('[hidden]'), null); assert.equal(side.closest('.workspace-sidebar-host')?.parentElement?.className, 'workspace-body'); assert(host.querySelector('[data-pane-id="home"]')?.hasAttribute('hidden'));
  await click(action); assert.equal(host.querySelectorAll('aside').length, 1); assert(side.textContent?.includes('保留侧栏状态 1'));
  await act(async () => view.render(createElement(Harness, { split: true })));
  await act(async () => { action.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true })); action.focus(); });
  assert.deepEqual(activations, []); assert.equal(host.querySelector('aside'), side); assert(side.textContent?.includes('保留侧栏状态 1')); assert.equal(host.querySelectorAll('.workspace-page:not([hidden])').length, 2); assert(renders < 8, 'stable host must not repeatedly register and rerender');
});
