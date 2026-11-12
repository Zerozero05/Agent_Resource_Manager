import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { createElement, act } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import type { LibraryItem } from '../src/library.ts';

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
const { Dashboard } = await import(await moduleURL(new URL('../src/Dashboard.tsx', import.meta.url)));
const host = document.getElementById('root')!;
let cleanup = () => {};
afterEach(async () => { await act(async () => cleanup()); cleanup = () => {}; });
const clicks: string[] = [];
function props() {
  clicks.length = 0;
  return {
    ready: true, canAdd: true, skills: [] as LibraryItem[], categories: [{ id: 'research', name: '论文研究', color: 'blue' }], sources: [], tasks: [],
    tools: { loaded: false, stale: true, loading: false, error: '', resources: [] },
    onView: (view: string) => clicks.push(view), onSkill: (id: string, section = 'docs') => clicks.push(`skill:${id}:${section}`),
    onCategory: (id: string) => clicks.push(`category:${id}`), onTask: (task: { id: string }) => clicks.push(`task:${task.id}`),
    onHistory: () => clicks.push('history'), onSources: () => clicks.push('sources'), onRetryTools: () => clicks.push('retry'), onAdd: () => clicks.push('add'),
  };
}
async function render(value: ReturnType<typeof props>) {
  const root = createRoot(host); cleanup = () => root.unmount();
  await act(async () => root.render(createElement(Dashboard, value)));
  return async (next: ReturnType<typeof props>) => act(async () => root.render(createElement(Dashboard, next)));
}
async function click(button: Element | null) {
  assert(button, 'expected an actionable control');
  await act(async () => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
}

test('unknown counts stay unknown and overview uses the existing navigation callbacks', async () => {
  const value = props(); value.ready = false;
  await render(value);
  const metrics = [...host.querySelectorAll('.dashboard-metric')];
  assert.equal(metrics[0].querySelector('strong')!.textContent, '—');
  assert.equal(metrics[1].querySelector('strong')!.textContent, '—');
  assert.equal(host.querySelector('[aria-label="需要处理"]')!.textContent!.includes('没有待处理'), false);
  assert.deepEqual(clicks, [], 'rendering must not execute an action');
  for (const metric of metrics) await click(metric);
  assert.deepEqual(clicks, ['skills', 'tools', 'changes', 'history']);
});

test('resolved issues leave the overview and runtime problems retain their reason', async () => {
  const value = props();
  value.skills = [
    { id: 'modified', name: 'Edited', status: 'local_modified', localPath: 'D:/synthetic/edited' },
    { id: 'missing', name: 'Needs reference', status: 'synced', runtimeAudit: { status: 'failed', reason: '缺少引用脚本' } },
    { id: 'docs', name: 'Docs checked', status: 'docs_updated' },
  ];
  const rerender = await render(value);
  const section = () => host.querySelector('[aria-label="需要处理"]')!;
  assert.equal(section().querySelectorAll('li').length, 2);
  assert(section().textContent!.includes('缺少引用脚本'));
  assert(!section().textContent!.includes('Docs checked'));
  await click(section().querySelector('li button'));
  assert(clicks[0].startsWith('skill:'));
  assert(clicks[0].endsWith(':files'));
  await rerender({ ...value, skills: value.skills.map(skill => ({ ...skill, status: 'synced', runtimeAudit: undefined })) });
  assert.equal(section().querySelectorAll('li').length, 0);
  assert(section().textContent!.includes('当前没有待处理'));
});

test('favorites, categories, source failure and retry keep distinct actions', async () => {
  const value = props();
  value.skills = [{ id: 'one', name: 'Original', alias: '我的文献', favorite: true, categoryId: 'research', status: 'local_only' }];
  value.tools.error = '读取工具目录超时';
  await render(value);
  await click(host.querySelector('.dashboard-favorites button'));
  await click(host.querySelector('.dashboard-categories button'));
  await click(host.querySelector('.dashboard-read-error > button'));
  assert.deepEqual(clicks, ['skill:one:docs', 'category:research', 'retry']);
  assert.equal(host.querySelector('.dashboard-categories strong')!.textContent, '1');
  assert(host.querySelector('.dashboard-favorites')!.textContent!.includes('我的文献'));
  assert(host.querySelector('.dashboard-read-error')!.textContent!.includes('读取工具目录超时'));
});

test('hidden tasks are excluded, running progress and retained history open actual records', async () => {
  const value = props();
  const task = (id: string, status: string, hidden = false) => ({ id, status, hidden, action: 'synthetic', label: id, stage: '正在读取', origin: {}, cancellable: false, createdAt: '2026-11-01T10:00:00Z', progress: { completed: 2, total: 5 } });
  const withTasks = { ...value, tasks: [task('active', 'running'), task('secret-hidden', 'running', true), task('done', 'succeeded')] };
  await render(withTasks as ReturnType<typeof props>);
  assert(!host.textContent!.includes('secret-hidden'));
  assert.equal(host.querySelector('progress')!.value, 2);
  assert.equal(host.querySelector('progress')!.max, 5);
  assert.equal(host.querySelectorAll('.dashboard-metric strong')[3].textContent, '1');
  await click(host.querySelector('[aria-label="任务进度"] li button'));
  await click(host.querySelector('[aria-label="近期操作"] li button'));
  assert.deepEqual(clicks, ['task:active', 'task:done']);
});

test('empty-state registration observes read-only and pending-operation protection', async () => {
  const value = props(); value.canAdd = false;
  await render(value);
  const add = host.querySelector<HTMLButtonElement>('[aria-label="需要处理"] .primary')!;
  assert(add.disabled);
  await act(async () => add.click());
  assert.deepEqual(clicks, []);
});
