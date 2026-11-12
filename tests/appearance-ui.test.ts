import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act, createElement, useState } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { DEFAULT_APPEARANCE, type Appearance } from '../src/appearance.ts';

// Exercise the actual settings component with synthetic state; no backend or user data.
const file = new URL('../src/AppearanceControls.tsx', import.meta.url);
let code = ts.transpileModule(await readFile(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, name: string) => `from ${JSON.stringify(name.startsWith('.') ? new URL(`${name}.ts`, file).href : import.meta.resolve(name))}`);
const { AppearanceControls } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const host = document.getElementById('root')!;
let unmount = () => {};
afterEach(async () => { await act(async () => unmount()); unmount = () => {}; });

test('accent, density and motion choices preview without discarding each other or saving implicitly', async () => {
  const patches: Partial<Appearance>[] = [];
  function Harness() {
    const [value, setValue] = useState(DEFAULT_APPEARANCE);
    return createElement(AppearanceControls, { value, onChange: (patch: Partial<Appearance>) => { patches.push(patch); setValue(previous => ({ ...previous, ...patch })); } });
  }
  const root = createRoot(host); unmount = () => root.unmount();
  await act(async () => root.render(createElement(Harness)));
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes(label))!;
  assert.equal(button('鸢尾紫').getAttribute('aria-pressed'), 'true');
  await act(async () => button('青绿').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  assert.equal(button('青绿').getAttribute('aria-pressed'), 'true');
  assert.equal(button('鸢尾紫').getAttribute('aria-pressed'), 'false');
  const density = host.querySelector<HTMLSelectElement>('select[aria-label="界面密度"]')!;
  await act(async () => { density.value = 'comfortable'; density.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
  const motion = host.querySelector<HTMLSelectElement>('select[aria-label="动效"]')!;
  await act(async () => { motion.value = 'none'; motion.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
  assert.deepEqual(patches, [{ uiAccent: 'teal' }, { uiDensity: 'comfortable' }, { uiMotion: 'none' }]);
  assert.equal(button('青绿').getAttribute('aria-pressed'), 'true');
  assert.equal(density.value, 'comfortable');
  assert.equal(motion.value, 'none');
  assert(!host.querySelector('button[type="submit"]'), 'preview controls must not submit settings');
});
