import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const file = new URL('../src/NetworkSettings.tsx', import.meta.url);
let code = ts.transpileModule(await readFile(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, name: string) => `from ${JSON.stringify(name.startsWith('.') ? new URL(`${name}.ts`, file).href : import.meta.resolve(name))}`);
const { NetworkSettings } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const host = document.getElementById('root')!;
let unmount = () => {};
afterEach(async () => { await act(async () => unmount()); unmount = () => {}; });

type Configuration = { mode: 'auto' | 'direct' | 'manual'; proxyUrl?: string; hasProxyCredentials?: boolean };
type Call = { action: string; args?: Record<string, unknown> };
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!;
const mode = () => host.querySelector<HTMLSelectElement>('select')!;
async function mount(request: (action: string, args?: Record<string, unknown>) => Promise<unknown>, extra: Record<string, unknown> = {}) {
  const root = createRoot(host); unmount = () => root.unmount();
  await act(async () => root.render(createElement(NetworkSettings, { request, notify: () => {}, ...extra })));
}
async function chooseMode(value: Configuration['mode']) {
  await act(async () => { mode().value = value; mode().dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
}
async function click(text: string) { await act(async () => button(text).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))); }
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
}

test('failed initial settings read can retry in place without writing or discarding the restored draft', async () => {
  const calls: Call[] = [], drafts: unknown[] = [];
  const original = { mode: 'manual', proxyUrl: 'http://127.0.0.1:43101' } satisfies Configuration;
  let reads = 0;
  await mount(async (action, args) => {
    calls.push({ action, args });
    assert.equal(action, 'get_network_settings');
    if (++reads === 1) throw new Error('连接设置暂时不可读取：合成测试错误');
    return { mode: 'auto', hasProxyCredentials: true };
  }, { initialDraft: { config: original }, onDraftChange: (draft: unknown) => drafts.push(draft) });
  assert(mode().disabled);
  assert(host.querySelector('[role="alert"]')?.textContent?.includes('网络设置读取失败'));
  assert(host.querySelector('[role="alert"]')?.textContent?.includes('连接设置暂时不可读取：合成测试错误'));
  await click('重新读取网络设置');
  assert.equal(mode().value, 'manual');
  assert.equal(mode().disabled, false);
  assert.equal(host.querySelector<HTMLInputElement>('input[placeholder^="http://"]')?.value, original.proxyUrl);
  assert.equal(button('测试已保存设置').disabled, false);
  assert.equal(host.querySelector('[role="alert"]'), null);
  assert.deepEqual(calls.map(call => call.action), ['get_network_settings', 'get_network_settings']);
  assert.deepEqual(drafts.at(-1), { config: { ...original, hasProxyCredentials: true } });
});

test('a rejected network save keeps the edited selection and complete error without claiming success', async () => {
  const calls: Call[] = [], notices: unknown[] = [];
  await mount(async (action, args) => {
    calls.push({ action, args });
    if (action === 'get_network_settings') return { mode: 'auto' };
    if (action === 'set_network_settings') throw new Error('保存被拒绝：合成测试权限错误');
    throw new Error(`Unexpected test action: ${action}`);
  }, { notify: (...args: unknown[]) => notices.push(args) });
  await chooseMode('direct'); await click('保存网络设置');
  assert.equal(mode().value, 'direct');
  assert.equal(button('保存网络设置').disabled, false);
  const alert = host.querySelector('[role="alert"]')?.textContent || '';
  assert(alert.includes('网络设置保存未完成'));
  assert(alert.includes('保存被拒绝：合成测试权限错误'));
  assert(!alert.includes('已保存'));
  assert.equal(calls.filter(call => call.action === 'set_network_settings').length, 1);
  assert.deepEqual(notices, []);
});

test('a saved setting with a failed follow-up refresh is distinguished from a failed write', async () => {
  const calls: Call[] = [], notices: unknown[] = [];
  let reads = 0;
  await mount(async (action, args) => {
    calls.push({ action, args });
    if (action === 'get_network_settings') {
      if (++reads === 2) throw new Error('合成测试状态刷新失败');
      return { mode: reads === 1 ? 'auto' : 'direct' };
    }
    if (action === 'set_network_settings') return { saved: true };
    throw new Error(`Unexpected test action: ${action}`);
  }, { notify: (...args: unknown[]) => notices.push(args) });
  await chooseMode('direct'); await click('保存网络设置');
  const alert = host.querySelector('[role="alert"]')?.textContent || '';
  assert(alert.includes('网络设置已保存，后续状态刷新未完成'));
  assert(alert.includes('合成测试状态刷新失败'));
  assert.equal(mode().value, 'direct');
  assert.equal(button('保存网络设置').disabled, true);
  await click('重新读取保存结果');
  assert.equal(host.querySelector('[role="alert"]'), null);
  assert(host.textContent?.includes('已重新读取保存结果。'));
  assert.equal(button('保存网络设置').disabled, true, 'the accepted draft now matches the read-back baseline');
  assert.deepEqual(calls.map(call => call.action), ['get_network_settings', 'set_network_settings', 'get_network_settings', 'get_network_settings']);
  assert.equal(calls.filter(call => call.action === 'set_network_settings').length, 1);
  assert.deepEqual(notices, []);
});

test('reading back an accepted save preserves later configuration and credential edits without another write', async () => {
  const calls: Call[] = [];
  let reads = 0;
  await mount(async (action, args) => {
    calls.push({ action, args });
    if (action === 'get_network_settings') {
      if (++reads === 2) throw new Error('合成测试刷新中断');
      return { mode: reads === 1 ? 'auto' : 'direct', hasProxyCredentials: true };
    }
    if (action === 'set_network_settings') return { saved: true };
    throw new Error(`Unexpected test action: ${action}`);
  });
  await chooseMode('direct'); await click('保存网络设置');
  await chooseMode('manual');
  await fill(host.querySelector<HTMLInputElement>('input[placeholder^="http://"]')!, 'http://127.0.0.1:43102');
  await fill(host.querySelector<HTMLInputElement>('input[autocomplete="off"]')!, 'synthetic-user');
  await fill(host.querySelector<HTMLInputElement>('input[type="password"]')!, 'synthetic-password');
  assert.equal(button('保存网络设置').disabled, true);
  await click('重新读取保存结果');
  assert.equal(mode().value, 'manual');
  assert.equal(host.querySelector<HTMLInputElement>('input[placeholder^="http://"]')?.value, 'http://127.0.0.1:43102');
  assert.equal(host.querySelector<HTMLInputElement>('input[autocomplete="off"]')?.value, 'synthetic-user');
  assert.equal(host.querySelector<HTMLInputElement>('input[type="password"]')?.value, 'synthetic-password');
  assert.equal(button('保存网络设置').disabled, false);
  assert.equal(button('移除代理凭据').disabled, true, 'new draft edits must be resolved before credentials can be removed');
  assert.equal(calls.filter(call => call.action === 'set_network_settings').length, 1);
  assert.equal(calls.at(-1)?.action, 'get_network_settings');
});

test('credential removal stays separate, invalidates changed confirmation and writes once only after confirmation', async () => {
  const calls: Call[] = [];
  let removed = false;
  await mount(async (action, args) => {
    calls.push({ action, args });
    if (action === 'get_network_settings') return { mode: 'manual', proxyUrl: 'http://127.0.0.1:43103', hasProxyCredentials: !removed };
    if (action === 'set_network_settings') { removed = true; return { saved: true }; }
    throw new Error(`Unexpected test action: ${action}`);
  });
  const group = host.querySelector('[aria-label="代理凭据管理"]')!;
  assert(group.contains(button('移除代理凭据')));
  await click('移除代理凭据'); await click('取消');
  assert.equal(calls.filter(call => call.action === 'set_network_settings').length, 0);
  await click('移除代理凭据'); await chooseMode('direct');
  assert.equal(button('确认移除代理凭据'), undefined);
  assert.equal(button('移除代理凭据').disabled, true);
  await chooseMode('manual'); await click('移除代理凭据');
  const confirm = button('确认移除代理凭据');
  await act(async () => {
    confirm.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    confirm.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  const writes = calls.filter(call => call.action === 'set_network_settings');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].args, { settings: { mode: 'manual', proxyUrl: 'http://127.0.0.1:43103' }, clearProxyCredentials: true });
  assert.equal(host.querySelector('[aria-label="代理凭据管理"]'), null);
});

test('testing a saved configuration leaves unsaved edits untouched and distinguishes API and file failures', async () => {
  const calls: Call[] = [];
  await mount(async (action, args) => {
    calls.push({ action, args });
    if (action === 'get_network_settings') return { mode: 'auto' };
    if (action === 'test_network') return { api: { ok: true, status: 200, durationMs: 12.2 }, raw: { ok: false, status: 500, durationMs: 20.6 } };
    throw new Error(`Unexpected test action: ${action}`);
  });
  await chooseMode('direct'); await click('测试已保存设置');
  assert.equal(mode().value, 'direct');
  assert(host.textContent?.includes('当前有未保存的修改'));
  const rows = [...host.querySelectorAll('.network-result-row')];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].getAttribute('data-diagnostic-ok'), 'true');
  assert.equal(rows[1].getAttribute('data-diagnostic-ok'), 'false');
  assert(rows[0].textContent?.includes('HTTP 200'));
  assert(rows[1].textContent?.includes('HTTP 500'));
  assert.equal(calls.filter(call => call.action === 'set_network_settings').length, 0);
});
