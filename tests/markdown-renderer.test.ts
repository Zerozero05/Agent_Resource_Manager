import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act, createElement, lazy, Suspense, type ReactNode } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const source = await readFile(new URL('../src/MarkdownRenderer.tsx', import.meta.url), 'utf8');
let code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, name) => `from ${JSON.stringify(import.meta.resolve(name))}`);
const markdownModule = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const MarkdownRenderer = markdownModule.default;
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const host = document.getElementById('root')!;
let cleanup = () => {};
afterEach(async () => { await act(async () => cleanup()); cleanup = () => {}; });

test('deferred Markdown keeps GFM, custom image/code renderers and safe URL handling', async () => {
  const root = createRoot(host); cleanup = () => root.unmount();
  await act(async () => root.render(createElement(MarkdownRenderer, {
    children: '| 名称 | 状态 |\n| --- | --- |\n| 原内容 | 可读 |\n\n- [x] 完成\n\n![说明图](relative.png)\n\n```txt\noriginal bytes\n```\n\n[危险链接](javascript:alert(1))\n\n<script>window.untrusted = true</script>',
    components: {
      img: ({ src, alt }: { src?: string; alt?: string }) => createElement('span', { 'data-image': src }, alt),
      pre: ({ children }: { children?: ReactNode }) => createElement('section', { 'data-code': true }, children),
    },
  })));
  assert.equal(host.querySelectorAll('table tbody tr').length, 1);
  assert.equal(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked, true);
  assert.equal(host.querySelector('[data-image]')?.getAttribute('data-image'), 'relative.png');
  assert.equal(host.querySelector('[data-code] code')?.textContent, 'original bytes\n');
  assert.equal(host.querySelector('script'), null);
  assert.equal(host.querySelector('a')?.getAttribute('href'), '');
});

test('lazy preparation preserves sibling controls and stable heading focus after resolution and rerender', async () => {
  let finish!: (module: typeof markdownModule) => void;
  const DeferredMarkdown = lazy(() => new Promise<typeof markdownModule>(resolve => { finish = resolve; }));
  const heading = ({ children }: { children?: ReactNode }) => createElement('h2', { id: 'stable-heading', tabIndex: -1 }, children);
  const root = createRoot(host); cleanup = () => root.unmount();
  const view = (label: string) => createElement('article', {},
    createElement('button', { id: 'reading-control' }, label),
    createElement(Suspense, { fallback: createElement('p', { role: 'status' }, '正在准备说明显示…') }, createElement(DeferredMarkdown, { children: '## 标题\n\n正文', components: { h2: heading } })),
  );
  await act(async () => root.render(view('刷新说明')));
  const control = host.querySelector<HTMLButtonElement>('button')!; control.focus();
  assert(host.querySelector('[role="status"]'));
  await act(async () => { finish(markdownModule); });
  assert.equal(host.querySelector('[role="status"]'), null);
  assert.equal(document.activeElement, control);
  const title = host.querySelector<HTMLElement>('h2')!; title.focus();
  await act(async () => root.render(view('说明已刷新')));
  assert.equal(host.querySelector('h2'), title);
  assert.equal(document.activeElement, title);
});
