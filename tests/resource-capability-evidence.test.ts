import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
let code = ts.transpileModule(await readFile(new URL('../src/ResourceCapabilityEvidence.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, specifier: string) => `from ${JSON.stringify(import.meta.resolve(specifier))}`);
const { ResourceCapabilityEvidence } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const host = document.getElementById('root')!;
let cleanup = () => {};
function root() { const view = createRoot(host); cleanup = () => view.unmount(); return view; }
afterEach(async () => { await act(async () => cleanup()); cleanup = () => {}; });
const resource = (extra: any = {}) => ({ id: 'one', name: 'Resource', kind: 'cli', rootPath: 'D:/synthetic/tool/v1', repository: 'https://github.com/synthetic/tool', version: 'v1', alias: '', notes: '', enabled: true, ownership: 'external', managementScope: 'invoke', revision: 2, actions: [{ id: 'version', label: 'Version command', mode: 'task', executable: 'D:/synthetic/tool/v1/tool.exe', workingDirectory: 'D:/synthetic/tool/v1', args: [], parameters: [] }], capabilities: [], createdAt: '', updatedAt: '', ...extra });
const evidence = (extra: any = {}) => ({ runId: 'run-one', resourceId: 'one', actionId: 'version', version: 'v1', rootPath: 'D:/synthetic/tool/v1', entryPath: 'D:/synthetic/tool/v1/tool.exe', scope: 'cliVersionCommand', startedAt: '2026-10-30T00:00:00Z', finishedAt: '2026-10-30T00:00:01Z', processStatus: 'succeeded', exitCode: 0, ...extra });
const status = (extra: any = {}) => ({ resourceId: 'one', version: 'v1', rootPath: 'D:/synthetic/tool/v1', checkedAt: '2026-10-30T00:00:02Z', actions: [{ actionId: 'version', label: 'Version command', mode: 'task', status: 'passed', reason: '本次版本命令进程成功退出，不代表平台调用通过。', latest: evidence() }], removedActionEvidence: [], history: [evidence()], total: 1, historyLimit: 50, scope: 'ownedActionCompletion', parametersStored: false, outputStored: false, platformCallsVerified: false, userSessionVerified: false, ...extra });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(override?: () => Promise<unknown>) { const calls: any[] = []; const action = async (_label: string, command: string, args: unknown) => { calls.push({ command, args }); return override ? override() : status(); }; return { calls, action }; }
const button = (label: string) => Array.from(host.querySelectorAll('button')).find(item => item.textContent === label)!;
async function click(element: Element) { await act(async () => { assert(element); element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); }); }
async function mount(props: any, extra: any = {}) { const view = root(); await act(async () => view.render(createElement(ResourceCapabilityEvidence, { resource: resource(), ...props, ...extra }))); return view; }
async function read() { await click(button('调用证据')); await click(button('读取调用证据')); }

test('evidence reads and file hashing are on demand, never startup/prop/visibility polling', async () => {
  const f = fixture(), view = await mount(f); assert.equal(f.calls.length, 0); await click(button('调用证据')); assert.equal(f.calls.length, 0);
  await act(async () => view.render(createElement(ResourceCapabilityEvidence, { resource: resource({ version: 'v2' }), ...f }))); assert.equal(f.calls.length, 0);
  await act(async () => view.render(createElement(ResourceCapabilityEvidence, { resource: resource(), ...f, visible: false }))); assert.equal(host.childElementCount, 0); assert.equal(f.calls.length, 0);
});

test('read uses a readonly resource ID and shows actual version/entry/time without claiming platform success', async () => {
  const f = fixture(); await mount(f); await read(); assert.deepEqual(f.calls, [{ command: 'resource_capability_evidence', args: { resourceId: 'one' } }]);
  assert(host.textContent?.includes('命令完成')); assert(host.textContent?.includes('v1')); assert(host.textContent?.includes('D:/synthetic/tool/v1/tool.exe')); assert(host.textContent?.includes('版本命令退出')); assert(host.textContent?.includes('上次核对')); assert(!host.textContent?.includes('登录已通过'));
});

test('alias, notes, name and revision-only refresh preserve the read result and do not trigger rehash', async () => {
  const f = fixture(), view = await mount(f); await read();
  await act(async () => view.render(createElement(ResourceCapabilityEvidence, { resource: resource({ name: 'New name', alias: 'Personal', notes: 'Changed', revision: 9 }), ...f })));
  assert(host.querySelector('[aria-label="动作核验结果"]')); assert(host.textContent?.includes('命令完成')); assert.equal(f.calls.length, 1);
});

test('relevant version/entry changes clear old current evidence while history is returned with stale status', async () => {
  const f = fixture(), view = await mount(f); await read();
  await act(async () => view.render(createElement(ResourceCapabilityEvidence, { resource: resource({ version: 'v2', rootPath: 'D:/synthetic/tool/v2' }), ...f })));
  assert(!host.querySelector('[aria-label="动作核验结果"]')); assert.equal(f.calls.length, 1);
  const newer = fixture(async () => status({ version: 'v2', actions: [{ actionId: 'version', label: 'Version command', mode: 'task', status: 'stale', reason: '版本已变化，原记录保留为历史', latest: evidence() }] }));
  await act(async () => view.render(createElement(ResourceCapabilityEvidence, { resource: resource({ version: 'v2', rootPath: 'D:/synthetic/tool/v2' }), ...newer })));
  await click(button('读取调用证据')); assert(host.textContent?.includes('需复核')); assert(host.textContent?.includes('历史')); assert(host.textContent?.includes('当时版本'));
});

for (const claim of ['platformCallsVerified', 'userSessionVerified', 'parametersStored', 'outputStored']) test(`unexpected ${claim} is rejected instead of displayed as success`, async () => {
  const f = fixture(async () => status({ [claim]: true })); await mount(f); await read(); assert(host.querySelector('[role="alert"]')!.textContent?.includes('证明范围异常')); assert(!host.querySelector('[aria-label="动作核验结果"]'));
});

test('a service without task evidence stays unverified and has no invented exit proof', async () => {
  const f = fixture(async () => status({ actions: [{ actionId: 'server', label: 'Browser connection', mode: 'service', status: 'unverified', reason: '服务启动不代表能力实测通过', latest: null }], total: 0, history: [] }));
  await mount(f); await read(); assert(host.textContent?.includes('未核验')); assert(!host.textContent?.includes('命令完成')); assert(host.textContent?.includes('尚无已完成的受管任务'));
});

test('late reads after path change or hiding do not resurrect old evidence or make writes', async () => {
  const pending = deferred<unknown>(), f = fixture(() => pending.promise), view = await mount(f); await read();
  await act(async () => view.render(createElement(ResourceCapabilityEvidence, { resource: resource(), ...f, visible: false })));
  await act(async () => pending.resolve(status())); assert.equal(host.childElementCount, 0);
  await act(async () => view.render(createElement(ResourceCapabilityEvidence, { resource: resource({ rootPath: 'D:/other' }), ...f }))); assert(!host.querySelector('[aria-label="动作核验结果"]')); assert.equal(f.calls.length, 1);
});

test('duplicate reads share one request, and collapsing keeps its trigger in place', async () => {
  const pending = deferred<unknown>(), f = fixture(() => pending.promise); await mount(f); await click(button('调用证据'));
  await act(async () => { button('读取调用证据').click(); button('正在核对…')?.click(); }); assert.equal(f.calls.length, 1);
  await act(async () => pending.resolve(status())); const disclosure = button('调用证据'); await click(disclosure); assert.equal(document.activeElement, disclosure); assert.equal(disclosure.getAttribute('aria-expanded'), 'false');
});

test('removed actions and limited recent history are explicit without discarding their journal', async () => {
  const old = evidence({ runId: 'old-run', actionId: 'removed-action' }), f = fixture(async () => status({ removedActionEvidence: [old], history: [old], total: 120 })); await mount(f); await read();
  assert(host.textContent?.includes('已移除动作的历史（1）')); assert(host.textContent?.includes('removed-action')); assert(host.textContent?.includes('最近 50 条')); assert(host.textContent?.includes('仍保存在管理数据库'));
});

const protocol = (extra: any = {}) => ({ method: 'tools/call', toolName: 'browser_tabs', protocolVersion: '2025-11-25', rpcResultReceived: true, isError: false, jsonRpcError: false, ...extra });
const mcpEvidence = (extra: any = {}) => evidence({ actionId: 'edge-tabs', completionKind: 'mcpToolCall', scope: 'mcpToolCall', exitCode: null, protocol: protocol(), ...extra });
function mcpStatus(value = mcpEvidence(), result = 'passed') { return status({ actions: [{ actionId: value.actionId, label: '列出 Edge 标签页', mode: 'task', status: result, reason: '仅证明此固定 MCP 动作，不代表其他浏览器动作或登录能力。', latest: value }], history: [value] }); }

test('a real MCP result shows its concrete tool, negotiated version and time without a process exit claim', async () => {
  const f = fixture(async () => mcpStatus()); await mount(f); await read();
  assert(host.textContent?.includes('MCP调用完成')); assert(host.textContent?.includes('browser_tabs')); assert(host.textContent?.includes('列出标签页')); assert(host.textContent?.includes('2025-11-25')); assert(host.textContent?.includes('单个 MCP 工具调用')); assert(host.textContent?.includes('D:/synthetic/tool/v1/tool.exe'));
  assert(!host.textContent?.includes('退出码')); assert(!host.textContent?.includes('登录已通过'));
});

test('handshake timeout and protocol failures remain explicit completed MCP failures', async () => {
  const value = mcpEvidence({ processStatus: 'timed_out', protocol: protocol({ protocolVersion: null, rpcResultReceived: false, isError: null }) });
  const f = fixture(async () => mcpStatus(value, 'failed')); await mount(f); await read();
  assert(host.textContent?.includes('MCP调用失败')); assert(host.textContent?.includes('未完成协商')); assert(host.textContent?.includes('timed_out')); assert(!host.textContent?.includes('未核验')); assert(!host.textContent?.includes('退出码'));
});

for (const [name, change] of [
  ['missing RPC result', { protocol: protocol({ rpcResultReceived: false }) }],
  ['tool error', { protocol: protocol({ isError: true }) }],
  ['JSON-RPC error', { protocol: protocol({ jsonRpcError: true }) }],
  ['unsupported negotiation', { protocol: protocol({ protocolVersion: '2099-01-01' }) }],
  ['wrong fixed tool', { protocol: protocol({ toolName: 'browser_snapshot' }) }],
  ['exit zero instead of MCP completion', { exitCode: 0 }],
  ['legacy process-only exit zero', { completionKind: 'processExit', protocol: undefined, exitCode: 0 }],
  ['unapproved persisted session field', { protocol: protocol({ sessionId: 'PRIVATE_SESSION_IDENTIFIER' }) }],
] as const) test(`MCP passed status with ${name} cannot display a success`, async () => {
  const f = fixture(async () => mcpStatus(mcpEvidence(change))); await mount(f); await read();
  assert(host.querySelector('[role="alert"]')); assert(!host.querySelector('[aria-label="动作核验结果"]')); assert(!host.textContent?.includes('PRIVATE_SESSION_IDENTIFIER'));
});

test('snapshot evidence is separate from tabs and old API scope is rejected', async () => {
  const value = mcpEvidence({ actionId: 'edge-snapshot', protocol: protocol({ toolName: 'browser_snapshot' }) });
  const f = fixture(async () => mcpStatus(value)); const view = await mount(f); await read(); assert(host.textContent?.includes('browser_snapshot')); assert(!host.textContent?.includes('browser_tabs'));
  const old = fixture(async () => status({ scope: 'ownedTaskExit' })); await act(async () => view.render(createElement(ResourceCapabilityEvidence, { resource: resource(), ...old }))); await click(button('重新核对'));
  assert(host.querySelector('[role="alert"]')); assert(!host.querySelector('[aria-label="动作核验结果"]'));
});
