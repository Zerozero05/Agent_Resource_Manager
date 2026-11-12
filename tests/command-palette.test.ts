import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { buildCommands, type Command } from '../src/commands.ts';
import type { Resource } from '../src/resources.ts';

const modules = new Map<string, Promise<string>>();
async function moduleURL(url: URL): Promise<string> {
  const cached = modules.get(url.href); if (cached) return cached;
  const loading = (async () => {
    let code = ts.transpileModule(await readFile(url, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText.replace(/import\s+['"][^'"]+\.css['"];?/g, '');
    const replacements = new Map<string, string>();
    for (const match of code.matchAll(/from\s+(['"])([^'"]+)\1/g)) {
      const name = match[2];
      if (!replacements.has(name)) replacements.set(name, name.startsWith('.') ? await moduleURL(new URL(`${name}.ts`, url)) : import.meta.resolve(name));
    }
    code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, name) => `from ${JSON.stringify(replacements.get(name))}`);
    return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  })(); modules.set(url.href, loading); return loading;
}
const dom = new JSDOM('<!doctype html><html><body><button id="origin">原入口</button><textarea id="editor"></textarea><input id="password" type="password"><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
// JSDOM has no layout; provide only the visibility geometry used by focus restoration.
dom.window.HTMLElement.prototype.getClientRects = function () { return this.isConnected && !this.closest('[hidden]') ? [{ width: 100, height: 32 }] as unknown as DOMRectList : [] as unknown as DOMRectList; };
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const { CommandPalette } = await import(await moduleURL(new URL('../src/CommandPalette.tsx', import.meta.url)));
const host = document.getElementById('root')!;
let unmount = () => {};
afterEach(async () => { await act(async () => unmount()); unmount = () => {}; document.querySelector('#blocking')?.remove(); });
const click = async (node: Element) => act(async () => { node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); });
const key = async (node: Element, name: string, options: KeyboardEventInit = {}) => {
  const event = new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...options });
  await act(async () => { node.dispatchEvent(event); }); return event;
};
function render(commands: Command[], onChoose: (command: Command) => void, extra: Record<string, unknown> = {}) {
  const root = createRoot(host); unmount = () => root.unmount();
  return act(async () => root.render(createElement(CommandPalette, { commands, onChoose, ...extra })));
}
const input = () => document.querySelector<HTMLInputElement>('[role="combobox"]')!;
const search = async (query: string) => act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input(), query); input().dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
const resource: Resource = { id: 'reader', name: 'Reader', alias: '阅读助手', notes: '', kind: 'cli', rootPath: 'D:/synthetic/reader', enabled: true, ownership: 'external', revision: 3, managementScope: 'register', actions: [{ id: 'find-video', label: '搜索视频', mode: 'task', executable: 'bin/read.exe', workingDirectory: '.', args: [{ type: 'parameter', name: 'query' }], parameters: [{ name: 'query', label: '关键词', kind: 'text', required: true }] }], capabilities: [], createdAt: '', updatedAt: '' };

test('Ctrl+K opens once, arrows choose the unified library, Escape restores focus and text shortcuts remain native', async () => {
  const chosen: Command[] = []; let opened = 0;
  await render(buildCommands([], []), command => chosen.push(command), { onOpen: () => { opened++; } });
  const origin = document.getElementById('origin')!; origin.focus();
  assert((await key(origin, 'k', { ctrlKey: true })).defaultPrevented);
  assert.equal(opened, 1); assert.equal(document.activeElement, input());
  assert.deepEqual([...document.querySelectorAll('[role="option"]')].slice(0, 4).map(option => option.querySelector('.command-palette-label')?.textContent), ['打开总览', '打开全部资源', '打开技能库', '打开工具目录']);
  assert.equal((await key(input(), 'a', { ctrlKey: true })).defaultPrevented, false);
  assert.equal((await key(input(), 'z', { ctrlKey: true })).defaultPrevented, false);
  await key(input(), 'ArrowDown'); await key(input(), 'Enter');
  assert.equal(chosen[0].id, 'view:resources'); assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, origin);
  await key(origin, 'k', { ctrlKey: true }); await key(input(), 'Escape');
  assert.equal(document.activeElement, origin); assert.equal(chosen.length, 1);
});

test('IME composition and keyCode229 never activate a result; query reaches labelled settings', async () => {
  const chosen: Command[] = [];
  await render(buildCommands([], []), command => chosen.push(command));
  await click(host.querySelector('button')!);
  await act(async () => { input().dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true })); });
  await key(input(), 'Enter'); await key(input(), 'Escape');
  assert.equal(chosen.length, 0); assert(input());
  await act(async () => { input().dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true })); });
  await key(input(), 'Enter', { keyCode: 229 }); assert.equal(chosen.length, 0);
  await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input(), '主题'); input().dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
  assert(document.querySelector('[role="option"]')?.textContent?.includes('显示设置'));
  await key(input(), 'Enter'); assert.equal(chosen[0].id, 'settings:display');
});

test('text editors, password inputs and active dialogs retain shortcut control', async () => {
  await render(buildCommands([], []), () => {});
  for (const id of ['editor', 'password']) {
    const node = document.getElementById(id)!; node.focus();
    assert.equal((await key(node, 'k', { ctrlKey: true })).defaultPrevented, false);
    assert.equal(document.querySelector('[role="dialog"]'), null);
  }
  const blocking = document.createElement('div'); blocking.id = 'blocking'; blocking.setAttribute('aria-modal', 'true'); document.body.append(blocking);
  const origin = document.getElementById('origin')!;
  await key(origin, 'k', { ctrlKey: true }); assert.equal(document.querySelector('.command-palette'), null);
});

test('inactive panes do not handle the shortcut, hidden dialogs do not block, and Tab stays in the palette', async () => {
  const root = createRoot(host); unmount = () => root.unmount();
  const props = { commands: buildCommands([], []), onChoose: () => {} };
  await act(async () => root.render(createElement(CommandPalette, { ...props, active: false })));
  const origin = document.getElementById('origin')!; origin.focus();
  assert.equal((await key(origin, 'k', { ctrlKey: true })).defaultPrevented, false);
  assert.equal(document.querySelector('.command-palette'), null);
  const blocking = document.createElement('div'); blocking.id = 'blocking'; blocking.hidden = true; blocking.setAttribute('aria-modal', 'true'); document.body.append(blocking);
  await act(async () => root.render(createElement(CommandPalette, { ...props, active: true })));
  await key(origin, 'k', { ctrlKey: true }); assert.equal(document.activeElement, input());
  await key(input(), 'Tab');
  const close = document.querySelector<HTMLButtonElement>('.command-palette-close')!;
  assert.equal(document.activeElement, close);
  await key(close, 'Tab', { shiftKey: true }); assert.equal(document.activeElement, input());
  const selection = input().getAttribute('aria-activedescendant');
  assert.equal((await key(input(), 'ArrowDown', { ctrlKey: true })).defaultPrevented, false);
  assert.equal(input().getAttribute('aria-activedescendant'), selection);
  await key(input(), 'Escape');
  assert.equal(document.activeElement, origin);
  await key(origin, 'k', { ctrlKey: true });
  const other = document.getElementById('editor')!; other.focus();
  await act(async () => root.render(createElement(CommandPalette, { ...props, active: false })));
  assert.equal(document.querySelector('.command-palette'), null);
  assert.equal(document.activeElement, other, 'changing the active pane must not steal focus back');
});

test('large local catalogues keep the result DOM bounded and empty queries recover without remote work', async () => {
  const commands = buildCommands(Array.from({ length: 1000 }, (_, index) => ({ id: String(index), name: `skill-${index}` })), []);
  await render(commands, () => {}); await click(host.querySelector('button')!);
  assert.equal(document.querySelectorAll('[role="option"]').length, 60);
  assert.equal(commands.length, 2016, '1000 skills each expose two entries, plus six navigation, nine settings and one history entry');
  assert.equal(document.querySelector('[role="status"]')?.textContent, '2016 个入口 · 显示前60项，请输入关键词缩小范围');
  await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input(), '完全不存在的关键词'); input().dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
  assert.equal(document.querySelectorAll('[role="option"]').length, 0);
  assert(document.querySelector('.command-palette-empty'));
  await key(input(), 'Enter'); assert(input());
});

test('registered actions search by their name and tool alias and choose only an identified form after IME completes', async () => {
  const chosen: Command[] = [];
  await render(buildCommands([], [resource]), command => chosen.push(command));
  await click(host.querySelector('button')!);
  await search('搜索视频 阅读助手');
  assert.equal(document.querySelectorAll('[role="option"]').length, 1);
  assert.match(document.querySelector('[role="option"]')!.textContent!, /打开参数表单.*核对后执行/);
  assert.match(document.querySelector('.command-palette-footer')!.textContent!, /核对参数后执行/);
  await act(async () => { input().dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true })); });
  await key(input(), 'Enter'); assert.equal(chosen.length, 0);
  await act(async () => { input().dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true })); });
  await key(input(), 'Enter', { keyCode: 229 });
  await key(input(), 'Enter', { repeat: true });
  const prevented = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }); prevented.preventDefault();
  await act(async () => { input().dispatchEvent(prevented); });
  assert.equal(chosen.length, 0);
  await search('powershell -Command'); await key(input(), 'Enter');
  assert.equal(chosen.length, 0); assert.equal(document.querySelectorAll('[role="option"]').length, 0);
  await search('搜索视频 阅读助手'); await key(input(), 'Enter');
  assert.equal(chosen.length, 1);
  assert.deepEqual(chosen[0].target, { kind: 'resource-action', id: 'reader', actionId: 'find-video', expectedRevision: 3 });
  assert.equal(document.querySelector('[role="dialog"]'), null);
});

test('basic mode and stopped actions expose their reasons and cannot be chosen by click or Enter', async () => {
  const chosen: Command[] = [];
  const root = createRoot(host); unmount = () => root.unmount();
  const paint = (readOnly: boolean, enabled: boolean) => act(async () => root.render(createElement(CommandPalette, { commands: buildCommands([], [{ ...resource, enabled }], { readOnly }), onChoose: (command: Command) => chosen.push(command) })));
  await paint(true, true); await click(host.querySelector('button')!); await search('搜索视频');
  let option = document.querySelector('[role="option"]')!;
  assert.equal(option.getAttribute('aria-disabled'), 'true'); assert.match(option.textContent!, /基本模式/);
  await click(option); await key(input(), 'Enter');
  assert.equal(chosen.length, 0); assert(input());
  await paint(false, false);
  option = document.querySelector('[role="option"]')!;
  assert.match(option.textContent!, /已停用/);
  await click(option); await key(input(), 'Enter'); assert.equal(chosen.length, 0);
  await search('显示设置'); await key(input(), 'Enter');
  assert.equal(chosen[0].id, 'settings:display');
});

test('an open palette uses the latest action availability and revision without dispatching a removed entry', async () => {
  const chosen: Command[] = [];
  const root = createRoot(host); unmount = () => root.unmount();
  const paint = (item: Resource) => act(async () => root.render(createElement(CommandPalette, { commands: buildCommands([], [item]), onChoose: (command: Command) => chosen.push(command) })));
  await paint(resource); await click(host.querySelector('button')!); await search('搜索视频');
  await paint({ ...resource, enabled: false, revision: 4 }); await key(input(), 'Enter');
  assert.equal(chosen.length, 0); assert.equal(document.querySelector('[role="option"]')?.getAttribute('aria-disabled'), 'true');
  await paint({ ...resource, actions: [], revision: 5 }); await key(input(), 'Enter');
  assert.equal(chosen.length, 0); assert.equal(document.querySelectorAll('[role="option"]').length, 0);
  await paint({ ...resource, revision: 6 }); await click(document.querySelector('[role="option"]')!);
  assert.equal(chosen.length, 1);
  assert.deepEqual(chosen[0].target, { kind: 'resource-action', id: 'reader', actionId: 'find-video', expectedRevision: 6 });
});
