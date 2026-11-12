import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import type { Resource } from '../src/resources.ts';
import type { IdleSnapshot } from '../src/ResourceIdleControls.tsx';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
let code = ts.transpileModule(await readFile(new URL('../src/ResourceIdleControls.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText.replace(/import\s+['"][^'"]+\.css['"];?/g, '');
code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, name: string) => `from ${JSON.stringify(import.meta.resolve(name))}`);
const { ResourceIdleControls } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const host = document.getElementById('root')!;
let cleanup = () => {};
afterEach(async () => { await act(async () => cleanup()); cleanup = () => {}; });
const resource = (revision = 4, id = 'one'): Resource => ({ id, name: id, kind: 'cli', rootPath: 'D:/synthetic/tool', enabled: true, ownership: 'external', revision, alias: '', notes: '', managementScope: 'register', actions: [], capabilities: [], createdAt: '', updatedAt: '' });
const snapshot = (revision = 4, id = 'one'): IdleSnapshot => ({ id, resourceRevision: revision, actions: [{ actionId: 'serve', label: '阅读服务', mode: 'service', idleReleaseSafe: false, idleUsageTracked: false, idleTimeoutSeconds: 600 }], runs: [] });
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!;
const click = async (label: string) => act(async () => button(label).click());
const input = () => host.querySelector<HTMLInputElement>('input[type="number"]')!;
const change = async (value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
  input().dispatchEvent(new dom.window.Event('input', { bubbles: true }));
});
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(handler: (action: string, args: any) => unknown = () => snapshot()) {
  const calls: { action: string; args: any }[] = []; let changed = 0;
  const root = createRoot(host); cleanup = () => root.unmount();
  const action = async (_label: string, command: string, args: any) => { calls.push({ action: command, args }); return handler(command, args); };
  return { calls, changed: () => changed, render: async (props = {}) => act(async () => root.render(createElement(ResourceIdleControls, { resource: resource(), action, onChanged: () => { changed++; }, ...props }))) };
}

test('idle controls stay lazy and hidden, then read existing settings without launching or stopping', async () => {
  const f = fixture(); await f.render({ visible: false }); await click('闲置与保活'); assert.equal(f.calls.length, 0);
  await f.render({ visible: true }); assert.deepEqual(f.calls, [{ action: 'resource_idle', args: { id: 'one' } }]);
  assert(host.textContent!.includes('保持运行，不自动释放')); await f.render(); assert.equal(f.calls.length, 1);
});

test('basic mode can read idle policy but exposes no write or keepalive controls', async () => {
  const f = fixture(); await f.render({ readOnly: true }); await click('闲置与保活');
  assert.equal(button('调整阅读服务的闲置设置'), undefined); assert.equal(host.querySelector('input'), null);
  await click('重新读取闲置状态'); assert.equal(f.calls.length, 2); assert(f.calls.every(call => call.action === 'resource_idle'));
});

test('explicit idle policy save binds the displayed resource revision and repeated clicks submit once', async () => {
  const pending = deferred<IdleSnapshot>();
  const f = fixture(command => command === 'resource_idle' ? snapshot() : pending.promise);
  await f.render(); await click('闲置与保活'); await click('调整阅读服务的闲置设置'); await change('5');
  await act(async () => { for (const box of host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) box.click(); });
  await act(async () => { button('保存闲置设置').click(); button('保存闲置设置').click(); });
  assert.deepEqual(f.calls.filter(call => call.action === 'resource_idle_set'), [{ action: 'resource_idle_set', args: { id: 'one', actionId: 'serve', expectedRevision: 4, idleReleaseSafe: true, idleUsageTracked: true, idleTimeoutSeconds: 300 } }]);
  await act(async () => pending.resolve({ ...snapshot(5), actions: [{ ...snapshot().actions[0], idleReleaseSafe: true, idleUsageTracked: true, idleTimeoutSeconds: 300 }] }));
  assert.equal(f.changed(), 1); assert.equal(input(), null); assert(host.textContent!.includes('闲置 5 分钟后释放'));
});

test('failed saves preserve drafts and revision drift prevents applying old edits', async () => {
  const f = fixture(command => { if (command === 'resource_idle_set') throw new Error('synthetic save failure'); return snapshot(); });
  await f.render(); await click('闲置与保活'); await click('调整阅读服务的闲置设置'); await change('7'); await click('保存闲置设置');
  assert.equal(input().value, '7'); assert(host.textContent!.includes('synthetic save failure')); assert.equal(f.changed(), 0);
  await f.render({ resource: resource(5) }); assert.equal(input().value, '7'); assert(button('保存闲置设置').disabled);
  await click('保存闲置设置'); assert.equal(f.calls.filter(call => call.action === 'resource_idle_set').length, 1);
});

test('invalid time never writes and zero is an explicit disable value', async () => {
  const f = fixture(command => command === 'resource_idle' ? snapshot() : snapshot(5));
  await f.render(); await click('闲置与保活'); await click('调整阅读服务的闲置设置'); await change(''); await click('保存闲置设置');
  assert.equal(f.calls.length, 1); await change('0'); await click('保存闲置设置');
  assert.equal(f.calls.at(-1)?.args.idleTimeoutSeconds, 0); assert.equal(f.changed(), 1);
});

test('a delayed idle read cannot replace the next resource', async () => {
  const pending = deferred<IdleSnapshot>();
  const f = fixture((_command, args) => args.id === 'one' ? pending.promise : snapshot(4, 'two'));
  await f.render(); await click('闲置与保活'); await f.render({ resource: resource(4, 'two') });
  await act(async () => pending.resolve({ ...snapshot(), actions: [{ ...snapshot().actions[0], label: '旧工具记录' }] }));
  assert(!host.textContent!.includes('旧工具记录')); assert.equal(f.calls.filter(call => call.args.id === 'two').length, 1);
});

test('keepalive targets one existing service and does not call stop or start', async () => {
  const run = { runId: 'run-one', resourceId: 'one', actionId: 'serve', pid: 123, mode: 'service' as const, status: 'running', startedAt: '', keepAlive: false, activeUses: 0, loginUses: 0, idleEligible: true, idleTimeoutSeconds: 600 };
  const f = fixture(command => command === 'resource_idle' ? { ...snapshot(), runs: [run] } : { run: { ...run, keepAlive: true } });
  await f.render(); await click('闲置与保活'); await click('保持此服务运行');
  assert.deepEqual(f.calls.at(-1), { action: 'resource_keep_alive', args: { runId: 'run-one', enabled: true } });
  assert(button('解除明确保活')); assert(f.calls.every(call => ['resource_idle', 'resource_keep_alive'].includes(call.action)));
});

test('automatic release failures remain visible without replaying any operation', async () => {
  const run = { runId: 'run-one', resourceId: 'one', actionId: 'serve', pid: 123, mode: 'service' as const, status: 'running', startedAt: '', keepAlive: false, activeUses: 0, loginUses: 0, idleEligible: false, idleTimeoutSeconds: 600, idleError: '自动释放已停止尝试；保留当前服务，请核查后手动处理或重新启动。' };
  const f = fixture(() => ({ ...snapshot(), runs: [run] }));
  await f.render(); await click('闲置与保活'); await f.render();
  assert.equal(host.querySelector('[role="alert"]')?.textContent, run.idleError);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].action, 'resource_idle');
});
