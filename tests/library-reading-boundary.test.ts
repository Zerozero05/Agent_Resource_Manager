import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act, createElement, createRef, useLayoutEffect } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const file = new URL('../src/LibraryReadingBoundary.tsx', import.meta.url);
let code = ts.transpileModule(await readFile(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, specifier: string) => `from ${JSON.stringify(specifier.startsWith('.') ? new URL(`${specifier}.ts`, file).href : import.meta.resolve(specifier))}`);
const { LibraryReadingBoundary } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const host = document.getElementById('root')!;
let unmount = () => {};
afterEach(async () => { await act(async () => unmount()); unmount = () => {}; });
type Item = { id: string; height?: number };
const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 400, width: 400, x: 0, y: top, toJSON: () => ({}) });

function fixture(zoom = 1) {
  const root = createRoot(host), outer = createRef<HTMLDivElement>();
  unmount = () => root.unmount();
  let scroller!: HTMLDivElement;
  function CommitFocus({ takeFocus }: { takeFocus: boolean }) {
    useLayoutEffect(() => { if (takeFocus) outer.current?.querySelector<HTMLButtonElement>('[data-other-control]')?.focus(); }, [takeFocus]);
    return null;
  }
  const render = async (items: readonly Item[], scope = 'same', takeFocus = false) => {
    let top = 0;
    const children = items.map(item => {
      const offset = top, height = item.height ?? 100; top += height;
      return createElement('div', { key: item.id, 'data-skill-id': item.id, 'data-top': offset, 'data-height': height, tabIndex: 0,
        ref: (node: HTMLDivElement | null) => { if (node) node.getBoundingClientRect = () => rect(100 + (Number(node.dataset.top) - scroller.scrollTop) * zoom, Number(node.dataset.height) * zoom); },
      }, item.id, createElement('button', { 'data-row-button': item.id }, `Open ${item.id}`));
    });
    await act(async () => root.render(createElement('div', { ref: outer },
      createElement(LibraryReadingBoundary, { root: outer, scope, items },
        createElement('div', { 'data-pane-scroll': true, ref: (node: HTMLDivElement | null) => {
          if (!node) return; scroller = node;
          node.getBoundingClientRect = () => rect(100, 200 * zoom);
          Object.defineProperties(node, { offsetHeight: { configurable: true, get: () => 200 }, clientHeight: { configurable: true, get: () => 200 }, scrollHeight: { configurable: true, get: () => 2000 } });
        } }, createElement('section', { className: 'library-panel' }, createElement('input', { 'aria-label': '搜索 Skill' }), ...children)),
        createElement('button', { 'data-other-control': true }, 'Other control'), createElement(CommitFocus, { takeFocus }),
      ),
    )));
  };
  const row = (id: string) => outer.current!.querySelector<HTMLElement>(`[data-skill-id="${id}"]`)!;
  const rowButton = (id: string) => outer.current!.querySelector<HTMLButtonElement>(`[data-row-button="${id}"]`)!;
  return { render, row, rowButton, get scroller() { return scroller; }, get scopeRoot() { return outer.current!; } };
}

test('same-scope metadata layout changes preserve the first visible row offset using a pre-mutation snapshot', async () => {
  const f = fixture(); await f.render([{ id: 'a' }, { id: 'b' }, { id: 'c' }]); f.scroller.scrollTop = 120;
  const oldOffset = f.row('b').getBoundingClientRect().top - f.scroller.getBoundingClientRect().top;
  await f.render([{ id: 'a', height: 160 }, { id: 'b' }, { id: 'c' }]);
  assert.equal(f.scroller.scrollTop, 180); assert.equal(f.row('b').getBoundingClientRect().top - f.scroller.getBoundingClientRect().top, oldOffset);
  assert.equal(f.scopeRoot.children.length, 2, 'boundary introduces no layout wrapper');
});

test('offset correction uses logical pixels under CSS zoom', async () => {
  const f = fixture(1.5); await f.render([{ id: 'a' }, { id: 'b' }, { id: 'c' }]); f.scroller.scrollTop = 120;
  await f.render([{ id: 'a', height: 160 }, { id: 'b' }, { id: 'c' }]); assert.equal(f.scroller.scrollTop, 180);
});

test('user scope changes skip scroll and focus restoration', async () => {
  const f = fixture(); await f.render([{ id: 'a' }, { id: 'b' }, { id: 'c' }]); f.scroller.scrollTop = 120; f.rowButton('b').focus();
  await f.render([{ id: 'a', height: 160 }, { id: 'c' }], 'different-filter');
  assert.equal(f.scroller.scrollTop, 120); assert.equal(document.activeElement, document.body);
});

test('unchanged items reference does not restore unrelated child layout updates', async () => {
  const f = fixture(), items = [{ id: 'a', height: 100 }, { id: 'b', height: 100 }, { id: 'c', height: 100 }];
  await f.render(items); f.scroller.scrollTop = 120; items[0].height = 160; await f.render(items);
  assert.equal(f.scroller.scrollTop, 120);
});

test('deleting the focused visible row places its successor at the anchor and focuses it without scrolling to top', async () => {
  const f = fixture(); await f.render([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]); f.scroller.scrollTop = 120; f.rowButton('b').focus();
  await f.render([{ id: 'a' }, { id: 'c' }, { id: 'd' }]);
  assert.equal(document.activeElement, f.row('c')); assert.equal(f.scroller.scrollTop, 120);
  assert.equal(f.row('c').getBoundingClientRect().top - f.scroller.getBoundingClientRect().top, -20);
});

test('deleting the last focused row falls back to the preceding survivor', async () => {
  const f = fixture(); await f.render([{ id: 'a' }, { id: 'b' }, { id: 'c' }]); f.scroller.scrollTop = 220; f.rowButton('c').focus();
  await f.render([{ id: 'a' }, { id: 'b' }]); assert.equal(document.activeElement, f.row('b')); assert.equal(f.scroller.scrollTop, 120);
});

test('surviving focused controls keep exact DOM focus while another row changes height', async () => {
  const f = fixture(); await f.render([{ id: 'a' }, { id: 'b' }, { id: 'c' }]); f.scroller.scrollTop = 120;
  const focused = f.rowButton('b'); focused.focus(); await f.render([{ id: 'a', height: 140 }, { id: 'b' }, { id: 'c' }]);
  assert.equal(document.activeElement, focused); assert.equal(f.rowButton('b'), focused); assert.equal(f.scroller.scrollTop, 160);
});

test('an explicit focus move during the commit is not stolen after deleting the old row', async () => {
  const f = fixture(); await f.render([{ id: 'a' }, { id: 'b' }]); f.rowButton('a').focus();
  await f.render([{ id: 'b' }], 'same', true); assert.equal(document.activeElement, f.scopeRoot.querySelector('[data-other-control]'));
});

test('removing every row returns lost row focus to the Skill search field', async () => {
  const f = fixture(); await f.render([{ id: 'a' }]); f.rowButton('a').focus(); await f.render([]);
  assert.equal(document.activeElement, f.scopeRoot.querySelector('input[aria-label="搜索 Skill"]'));
});

test('input focus outside rows is left alone on metadata updates', async () => {
  const f = fixture(); await f.render([{ id: 'a' }, { id: 'b' }]);
  const search = f.scopeRoot.querySelector<HTMLInputElement>('input')!; search.focus(); await f.render([{ id: 'b' }]); assert.equal(document.activeElement, search);
});
