import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { createElement, act } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import type { ResourceLibraryDraft } from '../src/resource-library.ts';

// Load the actual component and helper, without copying their implementation.
const modules = new Map<string, Promise<string>>();
async function relativeModule(value: string, parent: URL): Promise<URL> {
  if (/\.[cm]?[jt]sx?$/.test(value)) return new URL(value, parent);
  for (const suffix of ['.ts', '.tsx']) {
    const url = new URL(value + suffix, parent);
    try { await access(url); return url; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  throw new Error(`Cannot resolve ${value} from ${parent.href}`);
}
async function moduleURL(url: URL): Promise<string> {
  const previous = modules.get(url.href); if (previous) return previous;
  const loading = (async () => {
    let code = ts.transpileModule(await readFile(url, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText.replace(/import\s+['"][^'"]+\.css['"];?/g, '');
    const replacements = new Map<string, string>();
    for (const match of code.matchAll(/from\s+(['"])([^'"]+)\1/g)) {
      const value = match[2]; if (replacements.has(value)) continue;
      replacements.set(value, value.startsWith('.') ? await moduleURL(await relativeModule(value, url)) : import.meta.resolve(value));
    }
    code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match,_quote,value) => `from ${JSON.stringify(replacements.get(value))}`);
    return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  })(); modules.set(url.href,loading); return loading;
}
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const { ResourceLibrary } = await import(await moduleURL(new URL('../src/ResourceLibrary.tsx', import.meta.url)));
const host = document.getElementById('root')!;
let cleanup = () => {};
afterEach(async () => { await act(async () => cleanup()); cleanup = () => {}; });
const click = async (element: Element) => act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === name)!;
const skill = (id: string) => ({ id, name: `Skill ${id}`, status: 'local_only', localPath: `D:/synthetic/${id}` });
const tool = { id: 'same', name: 'Tool same', alias: '', notes: '', rootPath: 'D:/synthetic/tool', kind: 'mcp', enabled: true, revision: 1, actions: [], capabilities: [], ownership: 'external', managementScope: 'register', createdAt: '', updatedAt: '' };
const props = () => ({ skills: [skill('same')], tools: { resources: [tool], loaded: true, loading: false, stale: false, error: '' }, categories: [], ready: true, onDraft: (_draft: ResourceLibraryDraft) => {}, onOpen: (_entry: { id: string }) => {}, onRetry: () => {}, savedViews: [], onSavedView: (_id: string) => {}, paneRoot: { current: host } });
async function mount(value: ReturnType<typeof props> & { initialDraft?: Partial<ResourceLibraryDraft> }) {
  const root = createRoot(host); cleanup = () => root.unmount();
  await act(async () => root.render(createElement(ResourceLibrary, value)));
  return async (next: typeof value) => act(async () => root.render(createElement(ResourceLibrary, next)));
}

test('type selection and detail actions retain the original skill or tool identity', async () => {
  const opened: string[] = [];
  let captured: ResourceLibraryDraft | undefined;
  await mount({ ...props(), onDraft: draft => { captured = draft; }, onOpen: entry => opened.push(entry.id) });
  assert.equal(host.querySelectorAll('.unified-row').length, 2);
  await click(button('Skills'));
  assert.equal(host.querySelectorAll('.unified-row').length, 1);
  await click(button('Skill same'));
  await click(button('工具'));
  await click(button('Tool same'));
  assert.deepEqual(opened, ['skill:same', 'tool:same']);
  assert.equal(captured?.kind, 'tools');
  assert.equal(button('工具').getAttribute('aria-pressed'), 'true');
  await click(button('全部'));
  assert.equal(host.querySelectorAll('.unified-row').length, 2);
});

test('large inventories render one page and preserve the current page in the captured draft', async () => {
  let captured: ResourceLibraryDraft | undefined;
  await mount({ ...props(), skills: Array.from({ length: 1000 }, (_, index) => skill(String(index))), onDraft: draft => { captured = draft; } });
  assert.equal(host.querySelectorAll('.unified-row').length, 20);
  await click(host.querySelector('[aria-label="下一页资源"]')!);
  assert.equal(captured?.page, 2);
  assert.equal(host.querySelectorAll('.unified-row').length, 20);
  await act(async () => cleanup()); cleanup = () => {};
  await mount({ ...props(), skills: Array.from({ length: 1000 }, (_, index) => skill(String(index))), initialDraft: captured });
  assert(host.querySelector('.unified-pagination')!.textContent!.includes('21–40'));
});

test('background changes keep reading order until the user applies the new filter result', async () => {
  const base = props();
  const rerender = await mount({ ...base, skills: [{ ...skill('one'), status: 'local_modified' }], initialDraft: { attention: true } });
  assert.equal(host.querySelectorAll('.unified-row').length, 1);
  await rerender({ ...base, skills: [{ ...skill('one'), status: 'synced' }] });
  assert.equal(host.querySelectorAll('.unified-row').length, 1);
  assert(button('更新筛选结果'));
  await click(button('更新筛选结果'));
  assert.equal(host.querySelectorAll('.unified-row').length, 0);
});

test('failed tool reads preserve partial skill results and retry is explicit', async () => {
  let retried = 0;
  await mount({ ...props(), tools: { resources: [], loaded: false, loading: false, stale: true, error: '工具目录暂时不可读' }, onRetry: () => { retried++; } });
  assert.equal(host.querySelectorAll('.unified-row').length, 1);
  assert(host.querySelector('.unified-summary')!.textContent!.includes('已读取结果'));
  assert(host.querySelector('.unified-error')!.textContent!.includes('工具目录暂时不可读'));
  assert.equal(retried, 0);
  await click(button('重试'));
  assert.equal(retried, 1);
});
