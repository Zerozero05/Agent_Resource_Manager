import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act, createElement, useState } from 'react';
import { createPortal } from 'react-dom';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
const resizeObservers = new Set<{ observed: Set<Element>; callback: () => void }>();
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window), MutationObserver: dom.window.MutationObserver,
  requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; },
  cancelAnimationFrame: (id: number) => frames.delete(id),
  ResizeObserver: class {
    observed = new Set<Element>();
    callback: () => void;
    constructor(callback: () => void) { this.callback = callback; resizeObservers.add(this); }
    observe(element: Element) { this.observed.add(element); }
    disconnect() { resizeObservers.delete(this); }
  },
  IS_REACT_ACT_ENVIRONMENT: true,
});
let copied: string[] = [], clipboardFails = false;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: dom.window.navigator.userAgent, clipboard: { writeText: async (text: string) => { if (clipboardFails) throw new Error('denied'); copied.push(text); } } } });
const { createRoot } = await import('react-dom/client');
async function component(name: string) {
  const source = new URL(`../src/${name}.tsx`, import.meta.url);
  let code = ts.transpileModule(await readFile(source, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText.replace(/import\s+['"][^'"]+\.css['"];?/g, '');
  code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, name: string) => `from ${JSON.stringify(name.startsWith('.') ? new URL(name + '.ts', source).href : import.meta.resolve(name))}`);
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
const { DiagnosticSummary } = await component('DiagnosticSummary');
const { OperationHistory } = await component('OperationHistory');
const { OperationSummary } = await component('OperationSummary');
const host = document.getElementById('root')!;
let cleanup = () => {};
const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
const originalRects = dom.window.HTMLElement.prototype.getClientRects;
afterEach(async () => {
  await act(async () => cleanup()); cleanup = () => {}; copied = []; clipboardFails = false;
  dom.window.HTMLElement.prototype.getBoundingClientRect = originalRect;
  dom.window.HTMLElement.prototype.getClientRects = originalRects;
  frames.clear(); resizeObservers.clear();
});
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!;
const click = async (label: string) => act(async () => button(label).click());
const task = (id: string) => ({ id, action: 'check_now', label: `检查 ${id}`, status: 'failed', stage: '读取来源', createdAt: '2026-10-30T00:00:00Z', origin: { sourceId: 'source' }, error: 'HTTP 429 PRIVATE-TOKEN', cancellable: false });
function mount(Component: any, props: any) {
  const root = createRoot(host); cleanup = () => root.unmount();
  return { render: async (patch = {}) => act(async () => root.render(createElement(Component, { ...props, ...patch }))) };
}

test('diagnostics do no work until preview and copy only the already previewed safe text', async () => {
  const f = mount(DiagnosticSummary, { version: '0.2.11', basicMode: false, tasks: [task('one')], skillCount: 3, sourceErrors: 1 });
  await f.render(); assert.equal(host.querySelector('textarea'), null); assert.equal(copied.length, 0);
  await click('生成诊断预览'); const preview = host.querySelector('textarea')!.value;
  assert(!preview.includes('PRIVATE-TOKEN')); assert.equal(copied.length, 0);
  await f.render({ tasks: [] }); assert.equal(host.querySelector('textarea')!.value, preview);
  await click('复制当前摘要'); assert.deepEqual(copied, [preview]); assert(host.textContent!.includes('未上传'));
});

test('Basic supports diagnostics and clipboard failure preserves the selectable preview', async () => {
  clipboardFails = true;
  const f = mount(DiagnosticSummary, { version: '0.2.11', basicMode: true, tasks: [], skillCount: 0, sourceErrors: 0 });
  await f.render(); await click('生成诊断预览'); await click('复制当前摘要');
  assert(host.querySelector('textarea')!.value.includes('基本模式')); assert(host.textContent!.includes('请在下面选择并复制'));
  assert.equal(copied.length, 0); await f.render({ visible: false }); assert(button('生成诊断预览').disabled); assert(button('复制当前摘要').disabled);
});

test('problem groups preserve every original row and explicit navigation does not retry tasks', async () => {
  const inspected: string[] = [], located: string[] = [];
  const f = mount(OperationHistory, { tasks: [task('one'), task('two')], onDraftChange: () => {}, onInspect: (task: {id:string}) => inspected.push(task.id), onLocate: (task: {id:string}) => located.push(task.id), onCancel: () => assert.fail('viewing must not cancel'), onClear: () => assert.fail('viewing must not clear') });
  await f.render(); assert.equal(host.querySelectorAll('.operation-history-row').length, 2);
  assert.equal(host.querySelectorAll('[aria-label="重复问题归并"] details').length, 1);
  assert(host.textContent!.includes('等待限制解除后再检查')); assert.deepEqual(inspected, []);
  await click('查看对应记录'); assert.deepEqual(inspected, ['one']); assert.deepEqual(located, []);
  assert.equal(host.querySelectorAll('.operation-history-row').length, 2);
});

function summaryFixture() {
  const layout = {
    pages: { left: 224, top: 56, right: 1000, bottom: 740 },
    sidebar: { left: 0, top: 56, right: 224, bottom: 740 },
    trigger: { left: 16, top: 680, right: 216, bottom: 724 },
  };
  const rect = (value: { left: number; top: number; right: number; bottom: number }) => new dom.window.DOMRect(value.left, value.top, value.right - value.left, value.bottom - value.top);
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains('workspace-pages')) return rect(layout.pages);
    if (this.classList.contains('sidebar')) return rect(layout.sidebar);
    if (this.classList.contains('history-sidebar-entry')) return rect(layout.trigger);
    if (this.classList.contains('operation-summary')) return rect({ left: 0, top: 0, right: 360, bottom: 380 });
    return originalRect.call(this);
  };
  dom.window.HTMLElement.prototype.getClientRects = function () {
    return (this.closest('[hidden]') ? [] : [this.getBoundingClientRect()]) as unknown as DOMRectList;
  };
  let shown = 0;
  function Harness({ homeVisible = true }: { homeVisible?: boolean }) {
    const [sidebarHost, setSidebarHost] = useState<HTMLDivElement | null>(null);
    const sidebar = createElement('div', { className: 'app-shell workspace-sidebar-frame' },
      createElement('aside', { className: 'sidebar' }, createElement(OperationSummary, {
        tasks: [task('one'), task('two')], onShowAll: () => { shown++; },
        onDetails: () => assert.fail('opening summary must not inspect a task'),
        onReturn: () => assert.fail('opening summary must not navigate'),
      })));
    return createElement('div', { className: 'desktop-workspace' }, createElement('div', { className: 'workspace-body' },
      createElement('div', { className: 'workspace-sidebar-host', ref: setSidebarHost }),
      createElement('div', { className: 'workspace-pages' },
        createElement('section', { hidden: !homeVisible }, createElement('div', { className: 'app-shell workspace-home-content' },
          sidebarHost && createPortal(sidebar, sidebarHost), createElement('main', { className: 'main' }, '工作台内容'))),
        createElement('section', { hidden: homeVisible }, '业务内容'))));
  }
  const root = createRoot(host); cleanup = () => root.unmount();
  return { layout, shown: () => shown, render: async (homeVisible = true) => act(async () => root.render(createElement(Harness, { homeVisible }))) };
}
const summaryTrigger = () => host.querySelector<HTMLButtonElement>('[aria-label="操作记录"]')!;
const summaryPanel = () => document.querySelector<HTMLElement>('.operation-summary');
async function clickElement(element: HTMLElement) { await act(async () => element.click()); }
async function flushFrames() {
  const callbacks = [...frames.values()]; frames.clear();
  await act(async () => { for (const callback of callbacks) callback(0); });
}

test('summary opens from the separate sidebar portal and only the explicit all-records action navigates', async () => {
  const fixture = summaryFixture(); await fixture.render();
  const trigger = summaryTrigger();
  assert.equal(trigger.closest('.app-shell')?.querySelector(':scope > .main'), null);
  await clickElement(trigger);
  const popup = summaryPanel()!; assert.ok(popup); assert.equal(popup.style.visibility, 'visible');
  assert.equal(trigger.getAttribute('aria-expanded'), 'true'); assert.equal(trigger.getAttribute('aria-controls'), popup.id);
  assert.equal(document.activeElement, popup); assert.equal(popup.style.left, '232px'); assert.equal(fixture.shown(), 0);
  assert.equal(popup.querySelectorAll('.operation-summary-row').length, 2);
  await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  assert.equal(summaryPanel(), null); assert.equal(document.activeElement, trigger); assert.equal(fixture.shown(), 0);
  await clickElement(trigger);
  const all = [...summaryPanel()!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '查看全部记录')!;
  await clickElement(all); assert.equal(fixture.shown(), 1); assert.equal(summaryPanel(), null);
  assert.equal(summaryTrigger(), trigger); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});

test('summary follows its visible workspace bounds while Home is hidden and reacts to resize and outer scroll', async () => {
  const fixture = summaryFixture(); await fixture.render(false); await clickElement(summaryTrigger());
  assert(host.querySelector('.workspace-home-content')!.closest('[hidden]'));
  const popup = summaryPanel()!; assert.ok(popup); assert.equal(popup.style.visibility, 'visible');
  const pages = host.querySelector('.workspace-pages')!;
  assert([...resizeObservers].some(observer => observer.observed.has(pages)));
  fixture.layout.pages.right = 440;
  for (const observer of resizeObservers) observer.callback(); await flushFrames();
  assert.equal(popup.style.width, '200px'); assert(popup.classList.contains('is-compact'));
  assert(popup.textContent!.includes('查看全部记录'));
  await act(async () => popup.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }))); assert.equal(frames.size, 0);
  fixture.layout.trigger.top = 456; fixture.layout.trigger.bottom = 500;
  await act(async () => pages.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }))); await flushFrames();
  assert.equal(popup.style.top, '120px');
  await clickElement(popup.querySelector<HTMLButtonElement>('[aria-label="关闭操作摘要"]')!);
  assert.equal(summaryPanel(), null); assert.equal(document.activeElement, summaryTrigger()); assert.equal(resizeObservers.size, 0);
});
