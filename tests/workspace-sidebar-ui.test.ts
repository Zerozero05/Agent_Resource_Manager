import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act, createElement, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { outlineId } from '../src/workspace.ts';
import type { SettingsSectionKey } from '../src/settings-sections.ts';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLDetailsElement: dom.window.HTMLDetailsElement, Element: dom.window.Element, Node: dom.window.Node, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const { createRoot } = await import('react-dom/client');
async function loadTsx(path: string) {
  const file = new URL(path, import.meta.url);
  const code = ts.transpileModule(await readFile(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/import\s+['"][^'"]+\.css['"];?/g, '')
    .replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, name: string) => `from ${JSON.stringify(name.startsWith('.') ? new URL(name.endsWith('.ts') ? name : `${name}.ts`, file).href : import.meta.resolve(name))}`);
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
const { WorkspaceShell } = await loadTsx('../src/WorkspaceShell.tsx');
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

test('grouped settings keep legacy anchors, mount panels on demand and restore narrow navigation focus', async t => {
  const { SettingsLayout, SettingsSection } = await loadTsx('../src/SettingsLayout.tsx');
  t.mock.method(dom.window.HTMLElement.prototype, 'clientWidth', function (this: HTMLElement) {
    return this.classList.contains('settings-shell') ? 620 : 0;
  }, { getter: true });
  const mocks = {
    ResizeObserver: class { observe() {} disconnect() {} },
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  };
  const previous = Object.fromEntries(Object.keys(mocks).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, mocks);
  t.after(() => {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  function Harness() {
    const scopeRef = useRef<HTMLDivElement>(null);
    const [show, setShow] = useState(false), [expanded, setExpanded] = useState(true);
    const [active, setActive] = useState<SettingsSectionKey>('general');
    return createElement('div', { ref: scopeRef, 'data-pane-scroll': '' },
      !show ? createElement('button', { onClick: () => setShow(true) }, '打开设置') :
        createElement(SettingsLayout, { paneId: 'home', scopeRef, expanded, onExpandedChange: setExpanded, activeSection: active, onActiveSectionChange: setActive },
          createElement(SettingsSection, { sectionKey: 'general' }, createElement('h2', null, '常规设置'), createElement('input')),
          createElement(SettingsSection, { sectionKey: 'github' }, createElement('h2', null, 'GitHub 访问凭据'), createElement('h2', { 'data-outline-key': 'settings:github-sources', 'data-outline-label': '仓库来源' }, 'GitHub 来源')),
        ));
  }
  const view = createRoot(host); unmount = () => view.unmount();
  await act(async () => view.render(createElement(Harness)));
  await click(host.querySelector('button')!);
  const nav = host.querySelector('nav[aria-label="设置分类"]')!;
  const toggle = host.querySelector<HTMLButtonElement>('.settings-navigation-toggle')!;
  const general = host.querySelector<HTMLElement>('#settings-home-general')!;
  const github = host.querySelector<HTMLElement>('#settings-home-github')!;
  const button = (title: string) => Array.from(nav.querySelectorAll('button')).find(node => node.textContent === title)!;
  assert.deepEqual(Array.from(nav.querySelectorAll('[role="group"]'), group => group.getAttribute('aria-label')), ['应用', '运行与连接', '数据与排查']);
  assert.equal(button('常规').getAttribute('aria-current'), 'page');
  assert.equal(github.querySelector('h2:not([data-settings-fallback])'), null);
  const anchor = outlineId('home:settings', '使用偏好', 0, 'settings:general');
  assert.equal(general.querySelector('h2')?.id, anchor);
  const draft = general.querySelector('input')!;
  draft.value = '未保存路径';
  await click(button('GitHub'));
  assert.equal(toggle.getAttribute('aria-label'), '设置分类：GitHub');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, toggle);
  assert.equal(general.hidden, true);
  assert.equal(github.hidden, false);
  assert.equal(button('GitHub').getAttribute('aria-controls'), github.id);
  assert.equal(github.querySelector('[data-outline-key="settings:github-sources"]')?.id, outlineId('home:settings', '仓库来源', 0, 'settings:github-sources'));
  await click(toggle);
  await click(button('常规'));
  assert.equal(general.querySelector('input'), draft);
  assert.equal(draft.value, '未保存路径');
});
