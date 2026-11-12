import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
let code = ts.transpileModule(await readFile(new URL('../src/SkillSource.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, specifier: string) => `from ${JSON.stringify(import.meta.resolve(specifier))}`);
const { SkillSourceHealth } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const host = document.getElementById('root')!;
let cleanup = () => {};
afterEach(async () => { await act(async () => cleanup()); cleanup = () => {}; });
const source = { sourceId: 'source-one', repo: 'new/skill', branch: 'main', remotePath: 'skills/example', commit: 'new-commit' };
const installed = { ...source, repo: 'original/skill', commit: 'installed-commit' };
const reply = (status = 'reachable') => ({ skillId: 'one', source, health: { status, message: 'Synthetic health evidence', checkedAt: '2026-10-30T00:00:00Z' } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(handler = async () => reply()) {
  const calls: unknown[] = [], root = createRoot(host); cleanup = () => root.unmount();
  const action = async (_label: string, command: string, args: unknown) => { calls.push({ command, args }); return handler(); };
  return { calls, render: async (props = {}) => act(async () => root.render(createElement(SkillSourceHealth, { skillId: 'one', source, installed, action, ...props }))) };
}
async function check() { await act(async () => host.querySelector<HTMLButtonElement>('button')!.click()); }

test('health is explicit, repeated clicks share one request, and original installation evidence remains distinct', async () => {
  const pending = deferred<ReturnType<typeof reply>>(); const f = fixture(() => pending.promise); await f.render(); assert.equal(f.calls.length, 0);
  assert(host.querySelector('[aria-label="原安装来源"]')!.textContent!.includes('original/skill'));
  await act(async () => { host.querySelector<HTMLButtonElement>('button')!.click(); host.querySelector<HTMLButtonElement>('button')!.click(); });
  assert.deepEqual(f.calls, [{ command: 'skill_source_health', args: { skillId: 'one' } }]); await act(async () => pending.resolve(reply()));
  assert(host.querySelector('[role="status"]')!.textContent!.includes('可访问')); assert.equal(host.querySelector('time')!.dateTime, reply().health.checkedAt);
});

test('a source identity or commit change clears visible health and rejects an in-flight old response', async () => {
  let pending: ReturnType<typeof deferred<ReturnType<typeof reply>>> | null = null;
  const f = fixture(() => pending ? pending.promise : Promise.resolve(reply())); await f.render(); await check(); assert(host.querySelector('[role="status"]'));
  await f.render({ source: { ...source, commit: 'changed' } }); assert.equal(host.querySelector('[role="status"]'), null);
  pending = deferred(); await check(); await f.render({ source: { ...source, repo: 'other/skill', commit: 'later' } });
  await act(async () => pending!.resolve(reply())); assert.equal(host.querySelector('[role="status"]'), null); assert.equal(host.querySelector('[role="alert"]'), null);
});

test('foreign source IDs and commits are rejected even when repository, path and branch still match', async () => {
  let value = { ...reply(), source: { ...source, sourceId: 'other' } };
  const f = fixture(async () => value); await f.render(); await check(); assert(host.querySelector('[role="alert"]')!.textContent!.includes('来源已变化')); assert.equal(host.querySelector('[role="status"]'), null);
  value = { ...reply(), source: { ...source, commit: 'other' } }; await check(); assert.equal(host.querySelector('[role="status"]'), null);
});

test('hidden and Basic views never probe and invalidate earlier health without automatically retrying', async () => {
  const f = fixture(); await f.render(); await check(); assert(host.querySelector('[role="status"]'));
  await f.render({ visible: false }); await check(); assert.equal(host.querySelector('[role="status"]'), null); assert.equal(f.calls.length, 1);
  await f.render({ readOnly: true }); await check(); assert.equal(f.calls.length, 1); assert(host.textContent!.includes('基本模式'));
  await f.render(); assert.equal(f.calls.length, 1);
});

test('changed and network health keep their actual classification and an error waits for explicit retry', async () => {
  let status = 'changed'; const f = fixture(async () => { if (status === 'throw') throw new Error('Synthetic offline'); return reply(status); });
  await f.render(); await check(); assert(host.querySelector('[role="status"]')!.textContent!.includes('来源映射已变化'));
  status = 'network'; await check(); assert(host.querySelector('[role="status"]')!.textContent!.includes('网络异常')); assert(!host.textContent!.includes('已删除'));
  status = 'throw'; await check(); assert(host.querySelector('[role="alert"]')!.textContent!.includes('Synthetic offline')); assert.equal(host.querySelector('[role="status"]'), null); await f.render(); assert.equal(f.calls.length, 3);
});
