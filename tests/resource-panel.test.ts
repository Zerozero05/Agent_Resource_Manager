import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { createElement, act } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import type { ResourcePanelDraft } from '../src/resource-panel-state.ts';

const modules = new Map<string, Promise<string>>();
async function moduleURL(url: URL): Promise<string> {
  const cached = modules.get(url.href); if (cached) return cached;
  const loading = (async () => {
    let code = ts.transpileModule(await readFile(url, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText.replace(/import\s+['"][^'"]+\.css['"];?/g, '');
    const replacements = new Map<string, string>();
    for (const match of code.matchAll(/from\s+(['"])([^'"]+)\1/g)) {
      const value = match[2];
      if (!replacements.has(value)) {
        let target: string;
        if (value.startsWith('.')) {
          let path = new URL(/\.tsx?$/.test(value) ? value : value + '.ts', url);
          try { await access(path); } catch { path = new URL(value + '.tsx', url); }
          target = await moduleURL(path);
        } else target = import.meta.resolve(value);
        replacements.set(value, target);
      }
    }
    code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, value) => `from ${JSON.stringify(replacements.get(value))}`);
    return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  })(); modules.set(url.href, loading); return loading;
}
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const { ResourcePanel } = await import(await moduleURL(new URL('../src/ResourcePanel.tsx', import.meta.url)));
const { ResourceActions } = await import(await moduleURL(new URL('../src/ResourceActions.tsx', import.meta.url)));
const { InstallResource, RemoveResource } = await import(await moduleURL(new URL('../src/ResourceLifecycle.tsx', import.meta.url)));
const host = document.getElementById('root')!;
let cleanup = () => {};
function root() { const value = createRoot(host); cleanup = () => value.unmount(); return value; }
afterEach(async () => { await act(async () => cleanup()); cleanup = () => {}; });
const click = async (element: Element) => act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); });
const button = (label: string) => Array.from(host.querySelectorAll('button')).find(item => item.textContent === label)!;

test('persisted tool removal results reopen as a compact read-only record with fresh consent required', async () => {
  const calls: string[] = [];
  const action = async (_label: string, command: string) => { calls.push(command); return {}; };
  const resource = { ...item('one'), installation: { removalState: {
    status: 'processing', fileEntries: [{ path: 'D:/synthetic/tool/one.exe', remove: true }, { path: 'D:/synthetic/tool/two.exe', remove: true }],
    fileResult: { deleted: ['D:/synthetic/tool/one.exe'] }, systemEntryIds: ['entry'],
    systemResults: [{ id: 'entry', status: 'restored', reason: '已核对原值' }],
  } } };
  await act(async () => root().render(createElement(RemoveResource, { resource, action, onChanged: () => {} })));
  const history = host.querySelector<HTMLDetailsElement>('[aria-label="已保存的卸载记录"]')!;
  assert.equal(history.open, false);
  assert(history.textContent!.includes('上次卸载记录未完成'));
  assert.equal(history.querySelectorAll('li').length, 3);
  assert(history.textContent!.includes('已恢复原值'));
  assert(history.textContent!.includes('结果待核对'));
  assert.equal(calls.length, 0);
  await click(button('卸载或停用'));
  assert.equal(host.querySelector('select')!.value, '');
  assert(button('预览本次影响').disabled);
  await click(host.querySelector('[aria-label="关闭卸载"]')!);
  assert(host.querySelector('[aria-label="已保存的卸载记录"]'));
  assert.equal(calls.length, 0);
});

test('unified catalogue saved filters apply to an already mounted tool page once per request', async () => {
  const resources = [{ ...item('one'), name: 'Alpha', kind: 'cli' }, { ...item('two'), name: 'Beta', kind: 'mcp' }];
  const action = async (_label: string, command: string) => { assert.equal(command, 'resource_list'); return { resources }; };
  const mounted = root();
  await act(async () => mounted.render(createElement(ResourcePanel, { action })));
  const show = async (sequence: number, query: string, kind: string) => act(async () => mounted.render(createElement(ResourcePanel, { action, filterRequest: { sequence, filters: { query, kind } } })));
  await show(1, 'Beta', 'mcp');
  assert.equal(host.querySelectorAll('.resource-row').length, 1);
  assert(host.querySelector('.resource-row')!.textContent!.includes('Beta'));
  await show(1, 'Alpha', 'cli');
  assert(host.querySelector('.resource-row')!.textContent!.includes('Beta'));
  await show(2, 'Alpha', 'cli');
  assert(host.querySelector('.resource-row')!.textContent!.includes('Alpha'));
});
const change = async (input: HTMLInputElement, value: string) => act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
const select = async (element: HTMLSelectElement, value: string) => act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
const item = (id: string) => ({ id, name: id, kind: 'cli', rootPath: `D:/synthetic/${id}`, repository: null, version: null, alias: '', notes: '', enabled: true, revision: 4, ownership: 'external', managementScope: 'register', actions: [], capabilities: [], createdAt: '', updatedAt: '' });

test('tool detail wires lazy relation reads to its identity, Basic mode and visibility', async () => {
  const calls: { command: string; args: any }[] = [], resource = item('one');
  const action = async (_label: string, command: string, args: any) => {
    calls.push({ command, args });
    if (command === 'resource_list') return { resources: [resource] };
    if (command === 'resource_runtime') return { runs: [] };
    assert.equal(command, 'resource_relations');
    assert.deepEqual(args, { endpoint: { kind: 'tool', id: 'one' } });
    return { revision: 3, endpoint: { kind: 'tool', id: 'one', name: 'one', ownership: 'external', exists: true, shared: false }, dependencies: [], dependents: [], candidates: [] };
  };
  const view = root();
  await act(async () => view.render(createElement(ResourcePanel, { action, readOnly: true, revision: 100 })));
  await click(button('one')); assert.equal(calls.filter(call => call.command === 'resource_relations').length, 0);
  await click(button('依赖关系')); assert.equal(calls.filter(call => call.command === 'resource_relations').length, 1); assert.equal(button('添加关系'), undefined);
  await act(async () => view.render(createElement(ResourcePanel, { action, readOnly: true, revision: 101, visible: false })));
  assert.equal(calls.filter(call => call.command === 'resource_relations').length, 1);
  await act(async () => view.render(createElement(ResourcePanel, { action, readOnly: true, revision: 103, visible: true })));
  assert.equal(calls.filter(call => call.command === 'resource_relations').length, 2);
});

test('tool detail wires source identity, Basic mode and hidden catch-up without probing the network', async () => {
  const calls: { command: string; args: any }[] = [];
  const action = async (_label: string, command: string, args: any) => {
    calls.push({ command, args });
    if (command === 'resource_list') return { resources: [item('one')] };
    if (command === 'resource_runtime') return { runs: [] };
    assert.equal(command, 'resource_source'); assert.deepEqual(args, { id: 'one' });
    return { id: 'one', resourceRevision: 4, repository: null, installedVersion: null, installationSource: null, binding: null, history: [], mappingStatus: 'repositoryOnly', requiresVerification: false };
  };
  const view = root(), props = { action, readOnly: true };
  await act(async () => view.render(createElement(ResourcePanel, props))); await click(button('one'));
  assert.equal(calls.filter(call => call.command === 'resource_source').length, 0); await click(button('来源与健康'));
  assert.equal(calls.filter(call => call.command === 'resource_source').length, 1); assert.equal(button('检查来源健康'), undefined); assert.equal(button('预览来源关联'), undefined);
  await act(async () => view.render(createElement(ResourcePanel, { ...props, visible: false, revision: 10 })));
  await act(async () => view.render(createElement(ResourcePanel, { ...props, visible: false, revision: 11 })));
  assert.equal(calls.filter(call => call.command === 'resource_source').length, 1);
  await act(async () => view.render(createElement(ResourcePanel, { ...props, visible: true, revision: 11 })));
  assert.equal(calls.filter(call => call.command === 'resource_source').length, 2);
});

test('restored old editor source and version fields cannot bypass source preview while name, alias and notes still save', async () => {
  const current = { ...item('one'), repository: 'https://github.com/old/tool', version: 'installed-v1' };
  const initialDraft: ResourcePanelDraft = { query: '', kind: '', selectedId: null, resourceOrder: ['one'], lastFocusRequest: null, editor: { resourceId: 'one', expectedRevision: 4, fields: { name: '新名称', kind: 'cli', rootPath: current.rootPath, repository: 'https://github.com/unreviewed/tool', version: 'unreviewed-v9', alias: '新别名', notes: '保留备注' } } };
  const calls: { command: string; args: any }[] = []; let saved: ResourcePanelDraft | null = null;
  const action = async (_label: string, command: string, args: any) => {
    calls.push({ command, args });
    if (command === 'resource_list') return { resources: [current] };
    if (command === 'resource_runtime') return { runs: [] };
    assert.equal(command, 'resource_update'); return { resource: { ...current, ...args.changes, revision: 5 } };
  };
  await act(async () => root().render(createElement(ResourcePanel, { action, initialDraft, onDraft: (draft: ResourcePanelDraft) => { saved = draft; } })));
  assert.equal(host.querySelector('.resource-editor input[type="url"]'), null);
  assert.deepEqual([...host.querySelectorAll<HTMLInputElement>('.resource-editor input')].map(field => field.value), ['新名称', '新别名']);
  assert.equal(saved!.editor!.fields.repository, initialDraft.editor!.fields.repository); assert.equal(saved!.editor!.fields.version, 'unreviewed-v9');
  await click(button('保存'));
  assert.deepEqual(calls.find(call => call.command === 'resource_update')!.args, { id: 'one', expectedRevision: 4, changes: { name: '新名称', alias: '新别名', notes: '保留备注' } });
  assert.equal(host.querySelector('.resource-version')!.textContent, 'installed-v1');
});

test('source apply refreshes the tool row and preserves the installed version and personal fields', async () => {
  const oldRepository = 'https://github.com/old/tool', nextRepository = 'https://github.com/next/tool';
  let current = { ...item('one'), repository: oldRepository, version: 'installed-v1', alias: '个人工具', notes: '个人用途' };
  const source = () => ({ id: 'one', resourceRevision: current.revision, repository: current.repository, installedVersion: current.version, installationSource: null, binding: null, history: [], mappingStatus: 'repositoryOnly', requiresVerification: false });
  const calls: string[] = [];
  const action = async (_label: string, command: string, args: any) => {
    calls.push(command);
    if (command === 'resource_list') return { resources: [current] };
    if (command === 'resource_runtime') return { runs: [] };
    if (command === 'resource_source') return source();
    if (command === 'preview_resource_source') return { previewId: 'source-preview', kind: 'resourceSource', id: 'one', resourceRevision: 4, previous: source(), next: { repository: nextRepository, repositoryId: 99, asset: null, verifiedAt: '2026-10-30T00:00:00Z' }, mappingStatus: 'repositoryOnly', canApply: true, warnings: [] };
    assert.equal(command, 'apply_resource_source'); assert.deepEqual(args, { previewId: 'source-preview' }); current = { ...current, repository: nextRepository, revision: 5 }; return source();
  };
  await act(async () => root().render(createElement(ResourcePanel, { action }))); await click(button('个人工具')); await click(button('来源与健康'));
  await change(host.querySelector<HTMLInputElement>('[aria-label="新的 GitHub 来源"]')!, nextRepository); await click(button('预览来源关联')); await click(button('确认保存来源关联'));
  assert.equal(calls.filter(command => command === 'resource_list').length, 2);
  assert(host.querySelector('.resource-row')!.textContent!.includes('next/tool')); assert.equal(host.querySelector('.resource-version')!.textContent, 'installed-v1');
  assert(host.querySelector('.resource-detail')!.textContent!.includes('个人用途')); assert(button('个人工具')); assert(!calls.some(command => /download|install|invoke/.test(command)));
});

test('basic mode keeps resource information and results readable without offering mutations', async () => {
  const calls: string[] = [];
  const resource = { ...item('one'), actions: [{ id: 'inspect', label: '查看状态', mode: 'task', executable: 'D:/synthetic/one/tool.exe', workingDirectory: 'D:/synthetic/one', args: [], parameters: [] }] };
  const run = { runId: 'done', resourceId: 'one', actionId: 'inspect', mode: 'task', status: 'succeeded', startedAt: '2026-10-28T00:00:00Z', exitCode: 0 };
  const action = async (_label: string, command: string) => {
    calls.push(command);
    if (command === 'resource_list') return { resources: [resource] };
    if (command === 'resource_runtime') return { runs: [run, { ...run, runId: 'live', mode: 'service', status: 'running' }] };
    assert.equal(command, 'resource_result', 'basic mode UI must not submit any modifying action');
    return { run, stdout: 'synthetic read-only result', stderr: '', outputTruncated: false };
  };
  await act(async () => root().render(createElement(ResourcePanel, { action, readOnly: true })));
  assert.equal(button('登记现有工具').disabled, true);
  assert.equal(button('编辑').disabled, true);
  assert.equal(button('停用').disabled, true);
  assert(host.textContent?.includes('基本模式只读'));
  await click(host.querySelector('.resource-name-button')!);
  assert.equal(button('登记运行入口').disabled, true);
  assert.equal(button('使用').disabled, true);
  assert.equal(button('停止').disabled, true);
  assert.equal(host.querySelector('[aria-label="卸载工具"]'), null);
  await click(button('查看结果'));
  assert(host.textContent?.includes('synthetic read-only result'));
  await click(button('刷新'));
  assert(calls.every(command => ['resource_list', 'resource_runtime', 'resource_result'].includes(command)));
});

test('registration sends explicit original path and unknown version; metadata success never means running', async () => {
  const calls: { command: string; args: any }[] = [];
  const action = async (_label: string, command: string, args: any) => {
    calls.push({ command, args });
    if (command === 'resource_list') return { resources: [] };
    if (command === 'resource_runtime') return { runs: [] };
    assert.equal(command, 'resource_register'); return { resource: { ...item('new'), ...args } };
  };
  await act(async () => root().render(createElement(ResourcePanel, { action })));
  await click(button('登记现有工具'));
  const form = host.querySelector('form')!;
  const fields = form.querySelectorAll('input');
  await change(fields[0], '字幕工具'); await change(fields[1], 'D:/synthetic/new');
  await act(async () => { form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
  const mutation = calls.find(call => call.command === 'resource_register')!;
  assert.equal(mutation.args.rootPath, 'D:/synthetic/new'); assert.equal(mutation.args.version, null);
  assert(host.textContent?.includes('尚未登记运行入口'));
  assert(!host.textContent?.includes('运行正常')); assert.equal(host.querySelector('form'), null);
});

test('adopting a tool preserves unsaved personal fields and saves them against the adopted identity', async () => {
  const adopted = { ...item('adopted'), revision: 1, name: 'Agent Reach', rootPath: 'D:/synthetic/reach', version: '1.6.0' };
  const calls: { command: string; args: any }[] = [];
  const action = async (_label: string, command: string, args: any) => {
    calls.push({ command, args });
    if (command === 'resource_list') return { resources: [] };
    if (command === 'resource_runtime') return { runs: [] };
    if (command === 'preview_resource_adapter') return { id: 'native-plan', kind: 'resourceAdapter', adapter: 'agentReach', name: 'Agent Reach', rootPath: adopted.rootPath, resourceId: null, resourceRevision: null, detectedVersion: '1.6.0', versionEvidence: 'local metadata', repository: null, sourceVerified: false, license: 'MIT', actions: [], preserved: ['原文件'], warnings: [], canApply: true, deleteGrant: false, automaticUpdateGrant: false, filesChanged: false };
    if (command === 'apply_resource_adapter') return { resource: adopted, complete: true, adopted: true, executed: false, filesChanged: false, ownership: 'external', sourceVerified: false };
    assert.equal(command, 'resource_update'); return { resource: { ...adopted, ...args.changes, revision: 2 } };
  };
  await act(async () => root().render(createElement(ResourcePanel, { action })));
  await click(button('登记现有工具'));
  const fields = host.querySelectorAll<HTMLInputElement>('.resource-editor fieldset > label input');
  await change(fields[0], '个人名称'); await change(fields[1], adopted.rootPath); await change(fields[4], '个人别名');
  const notes = host.querySelector<HTMLTextAreaElement>('.resource-editor textarea')!;
  await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(notes, '未提交的用途'); notes.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
  await click(button('接管现有工具')); await click(button('预览接管')); await click(button('保存接管'));
  assert.deepEqual([...host.querySelectorAll<HTMLInputElement>('.resource-editor input')].map(field => field.value), ['个人名称', '个人别名']);
  assert.equal(host.querySelector<HTMLTextAreaElement>('.resource-editor textarea')!.value, '未提交的用途');
  await click(button('保存'));
  assert.deepEqual(calls.find(call => call.command === 'resource_update')!.args, { id: adopted.id, expectedRevision: 1, changes: { name: '个人名称', alias: '个人别名', notes: '未提交的用途' } });
  assert(!calls.some(call => call.command === 'resource_register'));
});

test('an evidence-write warning remains separate from the actual successful invocation result', async () => {
  const run = { runId: 'completed', resourceId: 'one', actionId: 'check', mode: 'task', status: 'succeeded', startedAt: '2026-10-30T00:00:00Z', exitCode: 0 };
  const action = async (_label: string, command: string) => command === 'resource_runtime' ? { runs: [run] } : { run, capabilityEvidenceWarning: 'synthetic evidence storage unavailable' };
  await act(async () => root().render(createElement(ResourceActions, { resource: item('one'), action, onChanged() {} })));
  await click(button('查看结果'));
  const result = host.querySelector('[aria-label="本次运行结果"]')!;
  assert.equal(result.querySelector('strong')!.textContent, '执行成功');
  assert(result.querySelector('[role="alert"]')!.textContent!.includes('实测记录未保存'));
  assert(result.textContent!.includes('synthetic evidence storage unavailable'));
});

test('conflicting edits keep the draft and submit the original revision', async () => {
  let sent: any;
  const action = async (_label: string, command: string, args: any) => {
    if (command === 'resource_list') return { resources: [item('one')] };
    sent = args; throw new Error('信息已变化，请重新核对');
  };
  await act(async () => root().render(createElement(ResourcePanel, { action })));
  await click(button('编辑'));
  await change(host.querySelector('form input')!, '本地未保存的名称');
  await act(async () => { host.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
  assert.equal(sent.expectedRevision, 4);
  assert.equal(host.querySelector<HTMLInputElement>('form input')!.value, '本地未保存的名称');
  assert(host.querySelector('[role=alert]')?.textContent?.includes('信息已变化'));
});

test('simultaneous toggle clicks submit once and distinguish disable from stop', async () => {
  let finish: (value: unknown) => void = () => {};
  let writes = 0;
  const action = async (_label: string, command: string, args: any) => {
    if (command === 'resource_list') return { resources: [item('one')] };
    writes++; assert.equal(command, 'resource_set_enabled'); assert.equal(args.expectedRevision, 4);
    return new Promise(resolve => { finish = resolve; });
  };
  await act(async () => root().render(createElement(ResourcePanel, { action })));
  const disable = button('停用');
  await act(async () => { disable.click(); disable.click(); });
  assert.equal(writes, 1);
  await act(async () => finish({ resource: { ...item('one'), enabled: false, revision: 5 } }));
  assert(host.querySelector('[role=status]')?.textContent?.includes('现有任务和原生入口保持'));
  assert.equal(button('启用').disabled, false);
});

test('IME confirmation does not submit while entering a resource name', async () => {
  const action = async () => ({ resources: [] });
  await act(async () => root().render(createElement(ResourcePanel, { action })));
  await click(button('登记现有工具'));
  const event = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true });
  host.querySelector('form input')!.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert(host.querySelector('form'));
});

test('command navigation can reopen the same resource and does not refocus on metadata refresh', async () => {
  const resource = item('one');
  let focusCalls = 0;
  const original = dom.window.HTMLElement.prototype.scrollIntoView;
  dom.window.HTMLElement.prototype.scrollIntoView = () => { focusCalls++; };
  const action = async (_label: string, command: string) => command === 'resource_list' ? { resources: [resource] } : { runs: [] };
  const view = root();
  try {
    await act(async () => view.render(createElement(ResourcePanel, { action, focusResourceId: 'one', focusRequest: 1 })));
    assert.equal(focusCalls, 1);
    await click(host.querySelector('[aria-label="关闭工具详情"]')!);
    await act(async () => view.render(createElement(ResourcePanel, { action, focusResourceId: 'one', focusRequest: 2 })));
    assert.equal(focusCalls, 2);
    await act(async () => view.render(createElement(ResourcePanel, { action, focusResourceId: 'one', focusRequest: 2, revision: 2 })));
    assert.equal(focusCalls, 2);
  } finally { dom.window.HTMLElement.prototype.scrollIntoView = original; }
});

test('explicit row detail opening focuses once, refresh does not jump, and closing returns to the same row', async () => {
  const resource = { ...item('one'), version: '1.64.0-alpha-1789764292000', managementScope: 'ownedFiles' };
  let scrolls = 0; const original = dom.window.HTMLElement.prototype.scrollIntoView;
  dom.window.HTMLElement.prototype.scrollIntoView = () => { scrolls++; };
  const action = async (_label: string, command: string) => command === 'resource_list' ? { resources: [resource] } : { runs: [] };
  const view = root();
  try {
    await act(async () => view.render(createElement(ResourcePanel, { action, revision: 1 })));
    const row = button('one'); await click(row);
    assert.equal(scrolls, 1); assert.equal(document.activeElement, host.querySelector('.resource-detail'));
    assert.equal(host.querySelector('.resource-version')!.getAttribute('title'), resource.version);
    assert(host.querySelector('.resource-detail')!.textContent?.includes('已核对文件'));
    await act(async () => view.render(createElement(ResourcePanel, { action, revision: 2 }))); assert.equal(scrolls, 1);
    await click(host.querySelector('[aria-label="关闭工具详情"]')!); assert.equal(document.activeElement, row); assert.equal(scrolls, 1);
    await click(row); assert.equal(scrolls, 2); assert.equal(document.activeElement, host.querySelector('.resource-detail'));
  } finally { dom.window.HTMLElement.prototype.scrollIntoView = original; }
});

const definition = { id: 'read', label: '读取字幕', mode: 'task', executable: 'D:/synthetic/reader.exe', workingDirectory: 'D:/synthetic', args: [{ type: 'parameter', name: 'url' }], parameters: [{ name: 'url', label: '视频地址', kind: 'text', required: true, maxLength: 1000 }] };
const run = { runId: 'owned-run', resourceId: 'one', actionId: 'read', pid: 1234, mode: 'task', cancellable: true, status: 'running', startedAt: '2026-10-28T00:00:00Z' };

function commandFixture(resource = { ...item('one'), actions: [definition] }) {
  const calls: { command: string; args: any }[] = [];
  let current = resource;
  const action = async (_label: string, command: string, args: any) => {
    calls.push({ command, args });
    if (command === 'resource_list') return { resources: [current] };
    if (command === 'resource_runtime') return { runs: [] };
    assert.equal(command, 'resource_invoke');
    return { run: { ...run, status: 'succeeded', exitCode: 0 }, stdout: 'synthetic result', stderr: '' };
  };
  const view = root();
  return { calls, setResource: (value: typeof resource) => { current = value; }, render: async (props: Record<string, unknown> = {}) => {
    await act(async () => view.render(createElement(ResourcePanel, {
      action, focusResourceId: 'one', focusActionId: 'read', focusActionRevision: 4, focusRequest: 1, ...props,
    })));
  } };
}

test('command action navigation only opens and focuses parameters, then submits the current inputs with its revision', async () => {
  const fixture = commandFixture(); await fixture.render();
  const form = host.querySelector<HTMLFormElement>('.resource-call-form')!;
  assert(form); assert.equal(form.getAttribute('aria-label'), '使用读取字幕');
  const input = form.querySelector<HTMLInputElement>('input')!;
  assert(document.activeElement === input, 'command navigation focuses the parameter input');
  assert.deepEqual(fixture.calls.map(call => call.command), ['resource_list', 'resource_runtime']);
  await change(input, 'https://example.org/first'); await change(input, 'https://example.org/current?a=1&b=2');
  await act(async () => form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
  assert.deepEqual(fixture.calls.filter(call => call.command === 'resource_invoke'), [{
    command: 'resource_invoke', args: { id: 'one', actionId: 'read', expectedRevision: 4, parameters: { url: 'https://example.org/current?a=1&b=2' } },
  }]);
});

test('a command for an action without parameters focuses execution but never invokes automatically', async () => {
  const fixture = commandFixture({ ...item('one'), actions: [{ ...definition, args: [], parameters: [] }] });
  await fixture.render();
  const form = host.querySelector<HTMLFormElement>('.resource-call-form')!;
  assert(form);
  assert(document.activeElement === form.querySelector('button[type="submit"]'), 'fixed-argument actions focus their explicit execution button');
  assert(!fixture.calls.some(call => call.command === 'resource_invoke'));
  await click(button('执行'));
  assert.deepEqual(fixture.calls.filter(call => call.command === 'resource_invoke'), [{
    command: 'resource_invoke', args: { id: 'one', actionId: 'read', expectedRevision: 4, parameters: {} },
  }]);
});

for (const scenario of ['basic', 'disabled', 'staleRevision', 'missingRevision', 'removedAction']) {
  test(`command action navigation rejects ${scenario} without opening a call or invoking the resource`, async () => {
    const resource = { ...item('one'), enabled: scenario !== 'disabled', actions: scenario === 'removedAction' ? [] : [definition] };
    const fixture = commandFixture(resource);
    await fixture.render({ readOnly: scenario === 'basic', focusActionRevision: scenario === 'missingRevision' ? undefined : scenario === 'staleRevision' ? 3 : 4 });
    assert(host.querySelector('.resource-detail'), 'the resource information remains readable');
    assert.equal(host.querySelector('.resource-call-form'), null);
    assert(host.querySelector('.resource-actions-panel [role="alert"]'));
    assert(fixture.calls.every(call => ['resource_list', 'resource_runtime'].includes(call.command)));
  });
}

test('an action request is scoped to its resource even when another resource has the same action id', async () => {
  const calls: { command: string; args: any }[] = [];
  const resources = [{ ...item('one'), actions: [definition] }, { ...item('two'), revision: 7, actions: [definition] }];
  const action = async (_label: string, command: string, args: any) => {
    calls.push({ command, args });
    if (command === 'resource_list') return { resources };
    if (command === 'resource_runtime') return { runs: [] };
    assert.equal(command, 'resource_invoke');
    return { run: { ...run, resourceId: args.id, status: 'succeeded', exitCode: 0 }, stdout: '', stderr: '' };
  };
  const view = root();
  await act(async () => view.render(createElement(ResourcePanel, { action, focusResourceId: 'one', focusActionId: 'read', focusActionRevision: 4, focusRequest: 1 })));
  await change(host.querySelector('.resource-call-form input')!, 'https://example.org/one');
  await click(button('two'));
  assert.equal(host.querySelector('.resource-detail')!.getAttribute('aria-label'), 'two 详情');
  assert.equal(host.querySelector('.resource-call-form'), null, 'manually opening a different resource does not inherit the first command');
  assert(!calls.some(call => call.command === 'resource_invoke'));
  await act(async () => view.render(createElement(ResourcePanel, { action, focusResourceId: 'two', focusActionId: 'read', focusActionRevision: 7, focusRequest: 2 })));
  const input = host.querySelector<HTMLInputElement>('.resource-call-form input')!;
  assert.equal(input.value, '');
  assert(document.activeElement === input, 'the new resource command focuses its own input');
  await change(input, 'https://example.org/two');
  await click(button('执行'));
  assert.deepEqual(calls.filter(call => call.command === 'resource_invoke'), [{
    command: 'resource_invoke', args: { id: 'two', actionId: 'read', expectedRevision: 7, parameters: { url: 'https://example.org/two' } },
  }]);
});

test('repeated command identity and metadata refresh preserve parameters while a new command reopens and focuses them', async () => {
  const fixture = commandFixture(); await fixture.render();
  await change(host.querySelector('.resource-call-form input')!, 'https://example.org/keep-draft');
  await fixture.render();
  fixture.setResource({ ...item('one'), notes: 'display refresh', actions: [definition] });
  await fixture.render({ revision: 2 });
  assert.equal(host.querySelector<HTMLInputElement>('.resource-call-form input')!.value, 'https://example.org/keep-draft');
  await fixture.render({ revision: 2, focusRequest: 2 });
  const input = host.querySelector<HTMLInputElement>('.resource-call-form input')!;
  assert.equal(input.value, '');
  assert(document.activeElement === input, 'a new command request refocuses the parameter input');
  await click(host.querySelector('[aria-label="关闭调用参数"]')!);
  await fixture.render({ revision: 2, focusRequest: 2 });
  assert.equal(host.querySelector('.resource-call-form'), null, 'an already consumed request must not reopen a closed form');
  await fixture.render({ revision: 2, focusRequest: 3 });
  assert(host.querySelector('.resource-call-form'));
  assert(document.activeElement === host.querySelector('.resource-call-form input'), 'reopening a closed form focuses the parameter input');
  assert(!fixture.calls.some(call => call.command === 'resource_invoke'));
});

test('a background resource revision change closes stale parameters and requires a new command with the current revision', async () => {
  const fixture = commandFixture(); await fixture.render();
  await change(host.querySelector('.resource-call-form input')!, 'https://example.org/stale-draft');
  fixture.setResource({ ...item('one'), revision: 5, actions: [definition] });
  await fixture.render({ revision: 2 });
  assert.equal(host.querySelector('.resource-call-form'), null);
  assert(host.querySelector('.resource-actions-panel [role="alert"]')?.textContent?.includes('工具信息已变化'));
  await fixture.render({ revision: 2, focusRequest: 2 });
  assert.equal(host.querySelector('.resource-call-form'), null, 'a new request carrying the old revision must still fail');
  await fixture.render({ revision: 2, focusRequest: 3, focusActionRevision: 5 });
  const input = host.querySelector<HTMLInputElement>('.resource-call-form input')!;
  assert(input); assert.equal(input.value, '');
  await change(input, 'https://example.org/current');
  await act(async () => host.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(fixture.calls.filter(call => call.command === 'resource_invoke').length, 1);
  assert.equal(fixture.calls.find(call => call.command === 'resource_invoke')?.args.expectedRevision, 5);
});
test('structured call parameters are submitted once and stopping stays available during invocation', async () => {
  let finish: (value: unknown) => void = () => {};
  const calls: { command: string; args: any }[] = [];
  const action = async (_label: string, command: string, args: any) => {
    calls.push({ command, args });
    if (command === 'resource_runtime') return { runs: [run] };
    if (command === 'resource_stop') return { run: { ...run, status: 'stopped' } };
    if (command === 'resource_invoke') return new Promise(resolve => { finish = resolve; });
    throw new Error(`unexpected ${command}`);
  };
  await act(async () => root().render(createElement(ResourceActions, { resource: { ...item('one'), actions: [definition] }, action, onChanged: () => {} })));
  assert.equal(button('使用').getAttribute('aria-label'), `使用${definition.label}`);
  await click(button('使用'));
  await change(host.querySelector('input')!, 'https://example.org/watch?a=1&b=2');
  const form = host.querySelector('form')!;
  await act(async () => { form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
  assert.equal(calls.filter(call => call.command === 'resource_invoke').length, 1);
  assert.deepEqual(calls.find(call => call.command === 'resource_invoke')?.args.parameters, { url: 'https://example.org/watch?a=1&b=2' });
  await click(button('停止'));
  assert.equal(calls.find(call => call.command === 'resource_stop')?.args.runId, 'owned-run');
  await act(async () => finish({ run: { ...run, status: 'stopped' }, stdout: '', stderr: '' }));
  assert(host.textContent?.includes('已停止'));
});

test('failed calls keep the entered parameters and disabled resources cannot execute', async () => {
  const resource = { ...item('one'), actions: [definition] };
  const action = async (_label: string, command: string) => { if (command === 'resource_runtime') return { runs: [] }; throw new Error('运行入口内容已变化'); };
  const view = root();
  await act(async () => view.render(createElement(ResourceActions, { resource, action, onChanged: () => {} })));
  await click(button('使用')); await change(host.querySelector('input')!, 'https://example.org/video');
  await act(async () => host.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(host.querySelector<HTMLInputElement>('input')!.value, 'https://example.org/video');
  assert(host.querySelector('[role=alert]')?.textContent?.includes('运行入口内容已变化'));
  await act(async () => view.render(createElement(ResourceActions, { resource: { ...resource, enabled: false }, action, onChanged: () => {} })));
  assert.equal(button('使用').disabled, true); assert.equal(button('执行').disabled, true);
});

test('uninstall always starts with an explicit extent and applies only the stored preview identity', async () => {
  const calls: { command: string; args: any }[] = [];
  const action = async (_label: string, command: string, args: any) => {
    calls.push({ command, args });
    if (command === 'preview_resource_remove') return { id: 'fixed-preview', kind: 'resourceRemove', resourceId: 'one', resourceName: 'one', targetPath: 'D:/synthetic/one', extent: args.extent, entries: [{ path: 'D:/synthetic/one/tool.exe', relative: 'tool.exe', role: 'runtime', remove: true, reason: '本次所选范围', expected: { bytes: 10 } }], canApply: true, warnings: [] };
    assert.equal(command, 'apply_resource_remove'); return { resource: item('one'), complete: true, result: { deleted: ['D:/synthetic/one/tool.exe'], retained: [], failures: [] } };
  };
  await act(async () => root().render(createElement(RemoveResource, { resource: item('one'), action, onChanged: () => {} })));
  await click(button('卸载或停用'));
  assert.equal(host.querySelector<HTMLSelectElement>('select')!.value, ''); assert.equal(button('预览本次影响').disabled, true);
  await select(host.querySelector('select')!, 'runtime'); await click(button('预览本次影响'));
  assert.equal(calls[0].args.expectedRevision, 4);
  await click(button('确认按此清单处理'));
  assert.deepEqual(calls[1].args, { previewId: 'fixed-preview' });
  assert(host.textContent?.includes('来源关联保留'));
  await click(host.querySelector('[aria-label="关闭卸载"]')!); await click(button('卸载或停用'));
  assert.equal(host.querySelector<HTMLSelectElement>('select')!.value, ''); assert.equal(calls.length, 2);
});

test('changing an uninstall extent invalidates the visible confirmation and unknown ownership stays blocked', async () => {
  const action = async (_label: string, _command: string, args: any) => ({ id: 'p', kind: 'resourceRemove', resourceId: 'one', resourceName: 'one', targetPath: 'D:/synthetic/one', extent: args.extent, entries: [], canApply: args.extent === 'disable', warnings: ['尚无可核实归属清单'] });
  await act(async () => root().render(createElement(RemoveResource, { resource: item('one'), action, onChanged: () => {} })));
  await click(button('卸载或停用')); await select(host.querySelector('select')!, 'disable'); await click(button('预览本次影响'));
  assert.equal(button('确认按此清单处理').disabled, false);
  await select(host.querySelector('select')!, 'complete'); assert.equal(button('确认按此清单处理'), undefined);
  await click(button('预览本次影响')); assert.equal(button('确认按此清单处理').disabled, true);
  assert(host.textContent?.includes('尚无可核实归属清单'));
});

test('custom removal separates exact system identities from file choices and shows partial system results', async () => {
  const calls: { command: string; args: any }[] = [];
  const entry = { id: 'owned-link', address: { kind: 'directoryLink', path: 'D:/synthetic/entry' }, operation: 'keep', requested: false, reason: '明确归属' };
  const action = async (_label: string, command: string, args: any) => {
    calls.push({ command, args });
    if (command === 'preview_resource_remove') return { id: 'system-preview', kind: 'resourceRemove', resourceId: 'one', resourceName: 'one', targetPath: 'D:/synthetic/one', extent: 'custom', entries: [], systemEntries: [{ ...entry, operation: args.customSystemIds.length ? 'remove' : 'keep', requested: !!args.customSystemIds.length }], canApply: true, warnings: [] };
    assert.equal(command, 'apply_resource_remove');
    return { resource: item('one'), complete: false, systemResult: { complete: false, entries: [{ id: entry.id, status: 'failed', reason: '入口已被其他程序修改，保留' }] } };
  };
  await act(async () => root().render(createElement(RemoveResource, { resource: item('one'), action, onChanged: () => {} })));
  await click(button('卸载或停用')); await select(host.querySelector('select')!, 'custom'); await click(button('读取可选择范围'));
  assert(host.querySelector('[aria-label="系统入口影响"]')!.textContent!.includes('D:/synthetic/entry'));
  await click(host.querySelector<HTMLInputElement>('[aria-label="自定义卸载系统入口"] input')!);
  assert.equal(button('确认按此清单处理'), undefined);
  assert.equal(button('读取可选择范围'), undefined, 'system-only choices still count as a loaded scope');
  await click(button('预览本次影响'));
  assert.deepEqual(calls[1].args.customSystemIds, ['owned-link']); assert.deepEqual(calls[1].args.customFiles, []);
  await click(button('确认按此清单处理'));
  assert.deepEqual(calls[2].args, { previewId: 'system-preview' });
  assert(host.querySelector('[aria-label="系统入口结果"]')!.textContent!.includes('保留'));
  assert(host.querySelector('[role="alert"]')!.textContent!.includes('入口已被其他程序修改'));
});

test('custom removal distinguishes identical file names in current and retained runtime roots', async () => {
  const calls: any[] = [];
  const action = async (_label: string, command: string, args: any) => {
    assert.equal(command, 'preview_resource_remove'); calls.push(args);
    return { id: 'multi-root', kind: 'resourceRemove', resourceId: 'one', resourceName: 'one', targetPath: 'D:/synthetic/v2', extent: 'custom', entries: [
      { path: 'D:/synthetic/v2/tool.exe', relative: 'tool.exe', selectionId: 'tool.exe', runtimeId: 'current', role: 'runtime', remove: false, expected: { bytes: 10 }, reason: '当前版本' },
      { path: 'D:/synthetic/v1/tool.exe', relative: 'tool.exe', selectionId: 'previous:v1::tool.exe', runtimeId: 'previous:v1', role: 'runtime', remove: false, expected: { bytes: 10 }, reason: '保留版本' },
    ], canApply: true, warnings: [] };
  };
  await act(async () => root().render(createElement(RemoveResource, { resource: item('one'), action, onChanged: () => {} })));
  await click(button('卸载或停用')); await select(host.querySelector('select')!, 'custom'); await click(button('读取可选择范围'));
  const boxes = host.querySelectorAll<HTMLInputElement>('[aria-label="自定义卸载文件"] input'); assert.equal(boxes.length, 2);
  await click(boxes[1]); await click(button('预览本次影响'));
  assert.deepEqual(calls[1].customFiles, ['previous:v1::tool.exe']);
});

test('custom removal lists recovery metadata independently and sends exact metadata identities while retaining unknown files', async () => {
  const calls: { command: string; args: any }[] = [];
  const metadata = { id: 'metadata:current', runtimeId: 'current', runtimeLabel: '当前运行版本', path: 'D:/synthetic/one/.agent-resource.json', status: 'owned', requested: false, remove: false, reason: '有明确归属的管理记录' };
  const unknown = { path: 'D:/synthetic/old/unknown.dat', runtimeId: 'old', reason: '只有路径记录，没有摘要归属' };
  const action = async (_label: string, command: string, args: any) => {
    calls.push({ command, args });
    if (command === 'preview_resource_remove') return { id: 'metadata-preview', kind: 'resourceRemove', resourceId: 'one', resourceName: 'one', targetPath: 'D:/synthetic/one', extent: args.extent, entries: [], metadataEntries: [
      { ...metadata, requested: args.customFiles.includes(metadata.id), remove: args.customFiles.includes(metadata.id) },
      { ...metadata, id: 'metadata:old', runtimeId: 'old', runtimeLabel: '上一版本', path: 'D:/synthetic/old/.agent-resource.json', status: 'changed', reason: '管理记录后来有修改，保留' },
    ], protectedEntries: [unknown], canApply: true, warnings: [] };
    assert.equal(command, 'apply_resource_remove');
    return { resource: { ...item('one'), revision: 5 }, complete: false, result: { deleted: [], retained: [], failures: [] }, metadataResult: { complete: false, entries: [{ id: metadata.id, path: metadata.path, status: 'retained', reason: '运行文件仍在使用，保留管理记录' }] } };
  };
  const view = root(), onChanged = () => {};
  await act(async () => view.render(createElement(RemoveResource, { resource: item('one'), action, onChanged })));
  await click(button('卸载或停用')); await select(host.querySelector('select')!, 'custom'); await click(button('读取可选择范围'));
  const choices = host.querySelectorAll<HTMLInputElement>('[aria-label="自定义卸载管理记录"] input'); assert.equal(choices.length, 2); assert.equal(choices[1].disabled, true);
  assert(host.querySelector('[aria-label="管理记录影响"]')!.textContent!.includes(metadata.path));
  assert(host.querySelector('[aria-label="必须保留的文件"]')!.textContent!.includes(unknown.reason));
  await click(choices[0]); assert.equal(button('确认按此清单处理'), undefined);
  await click(button('预览本次影响')); assert.deepEqual(calls[1].args.customFiles, ['metadata:current']);
  assert(host.querySelector('[aria-label="管理记录影响"]')!.textContent!.includes('拟删除'));
  await click(button('确认按此清单处理')); assert.deepEqual(calls[2].args, { previewId: 'metadata-preview' });
  await act(async () => view.render(createElement(RemoveResource, { resource: { ...item('one'), revision: 5 }, action, onChanged })));
  assert(host.querySelector('[aria-label="管理记录结果"]')!.textContent!.includes('运行文件仍在使用，保留管理记录'));
  assert(host.querySelector('[aria-label="保留归属不明的文件"]')!.textContent!.includes(unknown.path));
  assert(host.querySelector('[role="status"]')!.textContent!.includes('未完整完成'));
  assert.equal(host.querySelector<HTMLSelectElement>('select')!.value, '', 'another removal requires a fresh extent');
});

test('removal results keep actual file outcomes and failed metadata visible instead of claiming full success', async () => {
  const action = async (_label: string, command: string, args: any) => command === 'preview_resource_remove'
    ? { id: 'partial-preview', kind: 'resourceRemove', resourceId: 'one', resourceName: 'one', targetPath: 'D:/synthetic/one', extent: args.extent, entries: [], canApply: true, warnings: [] }
    : { resource: item('one'), complete: false, result: { deleted: ['D:/synthetic/one/tool.exe'], retained: ['D:/synthetic/one/config.json'], failures: [] }, metadataResult: { complete: false, entries: [{ id: 'metadata:current', path: 'D:/synthetic/one/.agent-resource.json', status: 'failed', reason: '文件仍被占用' }] }, persistenceError: '结果记录未完整保存' };
  await act(async () => root().render(createElement(RemoveResource, { resource: item('one'), action, onChanged: () => {} })));
  await click(button('卸载或停用')); await select(host.querySelector('select')!, 'complete'); await click(button('预览本次影响')); await click(button('确认按此清单处理'));
  assert(host.querySelector('[aria-label="文件删除结果"]')!.textContent!.includes('tool.exe · 已删除并核验'));
  assert(host.querySelector('[aria-label="文件未删除结果"]')!.textContent!.includes('config.json · 未删除'));
  assert(host.querySelector('[aria-label="管理记录结果"]')!.textContent!.includes('未完成'));
  assert(host.querySelector('[role="alert"]')!.textContent!.includes('文件仍被占用'));
  assert(host.querySelector('[role="alert"]')!.textContent!.includes('结果记录未完整保存'));
});

test('resource revision changes invalidate removal confirmation and drop old async previews', async () => {
  let finish: (value: unknown) => void = () => {};
  const calls: string[] = [];
  const action = async (_label: string, command: string) => { calls.push(command); return new Promise(resolve => { finish = resolve; }); };
  const view = root(), props = { resource: item('one'), action, onChanged: () => {} };
  await act(async () => view.render(createElement(RemoveResource, props)));
  await click(button('卸载或停用')); await select(host.querySelector('select')!, 'complete'); await click(button('预览本次影响'));
  await act(async () => view.render(createElement(RemoveResource, { ...props, resource: { ...item('one'), revision: 5 } })));
  await act(async () => finish({ id: 'old-preview', resourceId: 'one', extent: 'complete', entries: [], canApply: true, warnings: [] }));
  assert.equal(host.querySelector('[aria-label="卸载影响清单"]'), null);
  assert.equal(button('确认按此清单处理'), undefined); assert.deepEqual(calls, ['preview_resource_remove']);
});

test('hidden and Basic mode removal panels discard old permission without replaying a request when restored', async () => {
  let finish: (value: unknown) => void = () => {};
  const calls: string[] = [];
  const action = async (_label: string, command: string) => { calls.push(command); return new Promise(resolve => { finish = resolve; }); };
  const view = root(), props = { resource: item('one'), action, onChanged: () => {} };
  await act(async () => view.render(createElement(RemoveResource, props)));
  await click(button('卸载或停用')); await select(host.querySelector('select')!, 'runtime'); await click(button('预览本次影响'));
  await act(async () => view.render(createElement(RemoveResource, { ...props, visible: false })));
  await act(async () => finish({ id: 'hidden-preview', resourceId: 'one', extent: 'runtime', entries: [], canApply: true, warnings: [] }));
  await act(async () => view.render(createElement(RemoveResource, props)));
  assert.equal(button('确认按此清单处理'), undefined); assert.equal(calls.length, 1);
  await click(button('预览本次影响'));
  await act(async () => finish({ id: 'current-preview', resourceId: 'one', extent: 'runtime', entries: [], canApply: true, warnings: [] }));
  assert(button('确认按此清单处理'));
  await act(async () => view.render(createElement(RemoveResource, { ...props, readOnly: true })));
  assert.equal(host.querySelector('.resource-remove'), null);
  await act(async () => view.render(createElement(RemoveResource, props)));
  assert.equal(button('确认按此清单处理'), undefined); assert.equal(calls.length, 2);
});

test('a running task without cancellation consent does not expose an enabled stop button', async () => {
  const action = async () => ({ runs: [{ ...run, cancellable: false }] });
  await act(async () => root().render(createElement(ResourceActions, { resource: { ...item('one'), actions: [definition] }, action, onChanged: () => {} })));
  assert.equal(button('停止').disabled, true);
  assert(button('停止').title.includes('未声明可安全中止'));
});

test('installation preview includes selected file roles and keeps licenses mandatory', async () => {
  let previewArgs: any;
  const action = async (_label: string, command: string, args: any) => {
    if (command === 'resource_package_inspect') return { archivePath: args.archivePath, unpackedBytes: 30, files: [{ path: 'tool.exe', bytes: 10, license: false }, { path: 'config.json', bytes: 10, license: false }, { path: 'LICENSE', bytes: 10, license: true }] };
    assert.equal(command, 'preview_resource_install'); previewArgs = args;
    return { id: 'install-plan', kind: 'resourceInstall', archivePath: args.archivePath, targetPath: args.destinationPath, files: [], selectedBytes: 30, source: { repository: null, version: null, verification: 'userProvided' }, canApply: true, warnings: [] };
  };
  await act(async () => root().render(createElement(InstallResource, { action, onInstalled: () => {} })));
  await click(button('安装发行包')); await change(host.querySelector('input')!, 'D:/synthetic/package.zip'); await click(button('读取清单'));
  const boxes = host.querySelectorAll<HTMLInputElement>('.resource-file-selection input');
  assert.equal(boxes[2].checked, true); assert.equal(boxes[2].disabled, true);
  await click(boxes[0]); await click(boxes[1]);
  await select(host.querySelector('[aria-label="config.json用途"]')!, 'configuration');
  const field = (text: string) => [...host.querySelectorAll('form label')].find(label => label.textContent === text)!.querySelector<HTMLInputElement>('input')!;
  await change(field('名称'), 'Synthetic tool'); await change(field('新版本保存目录'), 'D:/synthetic/v1');
  await click(button('预览安装'));
  assert.deepEqual(previewArgs.fileRoles, { 'tool.exe': 'runtime', 'config.json': 'configuration' });
  assert(previewArgs.selectedFiles.includes('LICENSE'));
  await select(host.querySelector('[aria-label="config.json用途"]')!, 'userData');
  assert.equal(button('确认安装这些文件'), undefined);
});

function restoredPanelFixture(initialResources = [item('one'), item('two'), item('three')]) {
  const calls: { command: string; args: any }[] = [];
  let resources = initialResources, saved: ResourcePanelDraft | undefined;
  let view = root(), props: Record<string, unknown> = {};
  let notifications = 0;
  const action = async (_label: string, command: string, args: any) => {
    calls.push({ command, args });
    if (command === 'resource_list') return { resources };
    if (command === 'resource_runtime') return { runs: [] };
    assert.equal(command, 'resource_update');
    const current = resources.find(resource => resource.id === args.id)!;
    assert.equal(args.expectedRevision, current.revision);
    const resource = { ...current, ...args.changes, revision: current.revision + 1 };
    resources = resources.map(item => item.id === resource.id ? resource : item);
    return { resource };
  };
  const render = async (changes: Record<string, unknown> = {}) => {
    props = { ...props, ...changes };
    await act(async () => view.render(createElement(ResourcePanel, { action, onDraft: (draft: ResourcePanelDraft) => { saved = draft; notifications++; }, ...props })));
  };
  return { calls, render, draft: () => saved!, notifications: () => notifications,
    setResources: (next: typeof resources) => { resources = next; },
    remount: async (changes: Record<string, unknown> = {}) => {
      const initialDraft = structuredClone(saved);
      await act(async () => view.unmount()); view = root();
      props = { ...props, initialDraft, ...changes }; await render();
    },
  };
}
const resourceNames = () => [...host.querySelectorAll('.resource-name-button')].map(node => node.textContent);

test('unmounting and remounting restores tool filters, detail, identity order and unsubmitted fields without replaying a write', async () => {
  const f = restoredPanelFixture(); await f.render();
  await click(button('two'));
  await change(host.querySelector<HTMLInputElement>('[aria-label="搜索工具"]')!, 'two');
  await select(host.querySelector<HTMLSelectElement>('[aria-label="工具类型"]')!, 'cli');
  await click(button('编辑'));
  await change(host.querySelector<HTMLInputElement>('.resource-editor input')!, '未提交的工具名');
  assert.equal(f.draft().editor?.expectedRevision, 4);
  assert.equal(f.draft().editor?.fields.name, '未提交的工具名');
  assert.deepEqual(Object.keys(f.draft().editor!).sort(), ['expectedRevision', 'fields', 'resourceId']);
  f.setResources([item('three'), item('two'), item('one'), item('four')]);
  await f.remount();
  assert.equal(host.querySelector<HTMLInputElement>('[aria-label="搜索工具"]')!.value, 'two');
  assert.equal(host.querySelector<HTMLSelectElement>('[aria-label="工具类型"]')!.value, 'cli');
  assert.equal(host.querySelector('.resource-detail')!.getAttribute('aria-label'), 'two 详情');
  assert.equal(host.querySelector<HTMLInputElement>('.resource-editor input')!.value, '未提交的工具名');
  assert.deepEqual(f.draft().resourceOrder, ['one', 'two', 'three', 'four']);
  assert(f.calls.every(call => ['resource_list', 'resource_runtime'].includes(call.command)));
  await click(button('保存'));
  const write = f.calls.find(call => call.command === 'resource_update')!;
  assert.equal(write.args.id, 'two'); assert.equal(write.args.expectedRevision, 4);
  assert.equal(write.args.changes.name, '未提交的工具名');
});

test('restored edits keep stale fields and revision but refuse saving until explicit replacement from the current catalogue', async () => {
  const f = restoredPanelFixture([item('one')]); await f.render();
  await click(button('编辑')); await change(host.querySelector<HTMLInputElement>('.resource-editor input')!, '旧版本的未提交草稿');
  f.setResources([{ ...item('one'), revision: 5, name: '当前工具名' }]);
  await f.remount();
  assert.equal(host.querySelector<HTMLInputElement>('.resource-editor input')!.value, '旧版本的未提交草稿');
  assert.equal(f.draft().editor?.expectedRevision, 4);
  assert.equal(button('保存').disabled, true);
  await act(async () => host.querySelector('.resource-editor')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
  assert(!f.calls.some(call => call.command === 'resource_update'));
  await click(button('刷新'));
  assert.equal(f.draft().editor?.expectedRevision, 4, 'ordinary background refresh never rebases an edit');
  await click(button('重新读取（替换草稿）'));
  assert.equal(host.querySelector<HTMLInputElement>('.resource-editor input')!.value, '当前工具名');
  assert.equal(f.draft().editor?.expectedRevision, 5);
  await change(host.querySelector<HTMLInputElement>('.resource-editor input')!, '核对后的工具名');
  await click(button('保存'));
  assert.equal(f.calls.find(call => call.command === 'resource_update')!.args.expectedRevision, 5);
});

test('a hidden tool panel defers catalogue refresh and focus, then reads once when shown again', async () => {
  const f = restoredPanelFixture();
  let scrolls = 0;
  const original = dom.window.HTMLElement.prototype.scrollIntoView;
  dom.window.HTMLElement.prototype.scrollIntoView = () => { scrolls++; };
  try {
    await f.render({ visible: false, focusResourceId: 'two', focusRequest: 1 });
    await f.render({ revision: 2 }); await f.render({ revision: 3 });
    assert.equal(f.calls.length, 0); assert.equal(scrolls, 0);
    await f.render({ visible: true });
    assert.equal(f.calls.filter(call => call.command === 'resource_list').length, 1);
    assert.equal(scrolls, 1);
    await f.render({ visible: false, revision: 4, focusRequest: 2 });
    await f.render({ revision: 5 });
    assert.equal(f.calls.filter(call => call.command === 'resource_list').length, 1);
    assert.equal(scrolls, 1);
    await f.render({ visible: true }); await f.render();
    assert.equal(f.calls.filter(call => call.command === 'resource_list').length, 2);
    assert.equal(f.calls.filter(call => call.command === 'resource_runtime').length, 1, 'retained details do not poll every time the view is shown');
    assert.equal(scrolls, 2);
    assert(f.calls.every(call => ['resource_list', 'resource_runtime'].includes(call.command)));
  } finally { dom.window.HTMLElement.prototype.scrollIntoView = original; }
});

test('restoring a deleted selected tool chooses its neighbor using the saved order and keeps the missing editor draft', async () => {
  const f = restoredPanelFixture(); await f.render();
  await click(button('two'));
  await change(host.querySelector<HTMLInputElement>('[aria-label="搜索工具"]')!, 'two');
  await click(button('编辑')); await change(host.querySelector<HTMLInputElement>('.resource-editor input')!, '被移除工具的草稿');
  f.setResources([item('three'), item('one')]);
  await f.remount();
  assert.equal(f.draft().selectedId, 'three');
  assert.deepEqual(f.draft().resourceOrder, ['one', 'three']);
  assert.equal(host.querySelector('.resource-detail')!.getAttribute('aria-label'), 'three 详情');
  assert.equal(host.querySelector<HTMLInputElement>('.resource-editor input')!.value, '被移除工具的草稿');
  assert.equal(button('保存').disabled, true);
  assert.equal(f.draft().editor?.resourceId, 'two');
  assert(!f.calls.some(call => call.command === 'resource_update'));
});

test('a consumed command survives remount without clearing restored filters and a new command is consumed once', async () => {
  const f = restoredPanelFixture(); await f.render({ focusResourceId: 'two', focusRequest: 1 });
  await change(host.querySelector<HTMLInputElement>('[aria-label="搜索工具"]')!, 'three');
  await select(host.querySelector<HTMLSelectElement>('[aria-label="工具类型"]')!, 'cli');
  await click(host.querySelector('[aria-label="关闭工具详情"]')!);
  await f.remount();
  assert.equal(host.querySelector<HTMLInputElement>('[aria-label="搜索工具"]')!.value, 'three');
  assert.equal(host.querySelector<HTMLSelectElement>('[aria-label="工具类型"]')!.value, 'cli');
  assert.equal(host.querySelector('.resource-detail'), null);
  assert.deepEqual(resourceNames(), ['three']);
  const notifications = f.notifications();
  await f.render();
  assert.equal(f.notifications(), notifications, 'a new callback identity must not cause a draft notification loop');
  await f.render({ focusRequest: 2 });
  assert.equal(host.querySelector<HTMLInputElement>('[aria-label="搜索工具"]')!.value, '');
  assert.equal(host.querySelector<HTMLSelectElement>('[aria-label="工具类型"]')!.value, '');
  assert.equal(f.draft().selectedId, 'two');
  await change(host.querySelector<HTMLInputElement>('[aria-label="搜索工具"]')!, 'one');
  await f.render({ revision: 6 });
  assert.equal(host.querySelector<HTMLInputElement>('[aria-label="搜索工具"]')!.value, 'one');
});

test('restoring in basic mode preserves the draft but exposes no editable form or write entry', async () => {
  const f = restoredPanelFixture([item('one')]); await f.render();
  await click(button('编辑')); await change(host.querySelector<HTMLInputElement>('.resource-editor input')!, '只读恢复草稿');
  await f.remount({ readOnly: true });
  assert.equal(host.querySelector('.resource-editor'), null);
  assert.equal(f.draft().editor?.fields.name, '只读恢复草稿');
  assert.equal(button('编辑').disabled, true);
  assert(f.calls.every(call => call.command === 'resource_list'));
});

test('a restored editor cannot save before its first current catalogue read has completed', async () => {
  const f = restoredPanelFixture([item('one')]); await f.render();
  await click(button('编辑')); await change(host.querySelector<HTMLInputElement>('.resource-editor input')!, '等待核对的草稿');
  let finish!: (value: unknown) => void;
  const reads: string[] = [];
  const delayedAction = async (_label: string, command: string) => {
    reads.push(command); assert.equal(command, 'resource_list');
    return new Promise(resolve => { finish = resolve; });
  };
  await f.remount({ action: delayedAction });
  assert.equal(button('保存').disabled, true);
  assert.equal(host.querySelector<HTMLInputElement>('.resource-editor input')!.value, '等待核对的草稿');
  await act(async () => host.querySelector('.resource-editor')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
  assert.deepEqual(reads, ['resource_list']);
  await act(async () => finish({ resources: [item('one')] }));
  assert.equal(button('保存').disabled, false);
  assert.equal(f.draft().editor?.expectedRevision, 4);
});

test('a new registration draft restores its fields without registering or restoring installation permissions', async () => {
  const f = restoredPanelFixture([]); await f.render();
  await click(button('登记现有工具'));
  const fields = host.querySelectorAll<HTMLInputElement>('.resource-editor input');
  await change(fields[0], '新工具草稿'); await change(fields[1], 'D:/synthetic/new-draft');
  await f.remount();
  const restored = host.querySelectorAll<HTMLInputElement>('.resource-editor input');
  assert.equal(restored[0].value, '新工具草稿'); assert.equal(restored[1].value, 'D:/synthetic/new-draft');
  assert.equal(f.draft().editor?.resourceId, null); assert.equal(f.draft().editor?.expectedRevision, null);
  assert.equal(button('确认安装这些文件'), undefined);
  assert.equal(button('确认按此清单处理'), undefined);
  assert(f.calls.every(call => call.command === 'resource_list'));
});

test('hiding the tool view keeps an owned invocation alive without refreshing, replaying or stopping it', async () => {
  const resource = { ...item('one'), actions: [definition] };
  const calls: string[] = [];
  let finish!: (value: unknown) => void;
  const action = async (_label: string, command: string) => {
    calls.push(command);
    if (command === 'resource_list') return { resources: [resource] };
    if (command === 'resource_runtime') return { runs: [] };
    assert.equal(command, 'resource_invoke');
    return new Promise(resolve => { finish = resolve; });
  };
  const view = root();
  const props = { action, focusResourceId: 'one', focusActionId: 'read', focusActionRevision: 4, focusRequest: 1 };
  await act(async () => view.render(createElement(ResourcePanel, props)));
  await change(host.querySelector<HTMLInputElement>('.resource-call-form input')!, 'https://example.org/owned-task');
  await click(button('执行'));
  await act(async () => view.render(createElement(ResourcePanel, { ...props, visible: false, revision: 2 })));
  assert.deepEqual(calls, ['resource_list', 'resource_runtime', 'resource_invoke']);
  await act(async () => finish({ run: { ...run, status: 'succeeded', exitCode: 0 }, stdout: 'owned task completed', stderr: '' }));
  await act(async () => view.render(createElement(ResourcePanel, { ...props, visible: true, revision: 2 })));
  assert.deepEqual(calls, ['resource_list', 'resource_runtime', 'resource_invoke', 'resource_list']);
  assert(host.querySelector('.resource-run-result')?.textContent?.includes('owned task completed'));
});

test('a reusable Edge connection is distinct from its completed read and disconnects only that session', async () => {
  const entry = { ...definition, id: 'edge-tabs', label: '列出 Edge 标签页', parameters: [] };
  const resource = { ...item('one'), actions: [entry] };
  const completed = { runId: 'read-one', resourceId: 'one', actionId: 'edge-tabs', pid: 321, mode: 'task', status: 'succeeded', startedAt: '2026-10-31T00:00:01Z', exitCode: null };
  const connection = { ...completed, runId: 'owned-connection', mode: 'service', status: 'running', startedAt: '2026-10-31T00:00:00Z', protocolSession: true };
  const calls: { command: string; args: unknown }[] = [];
  const action = async (_label: string, command: string, args: unknown) => {
    calls.push({ command, args });
    if (command === 'resource_runtime') return { runs: [connection, completed] };
    assert.equal(command, 'resource_stop');
    assert.deepEqual(args, { runId: 'owned-connection' });
    return { run: { ...connection, status: 'stopped' } };
  };
  await act(async () => root().render(createElement(ResourceActions, { resource, action, onChanged: () => {} })));
  const names = [...host.querySelectorAll('.resource-run-row strong')].map(node => node.textContent);
  assert.deepEqual(names, ['Edge 浏览器连接', '列出 Edge 标签页']);
  assert.equal(button('停止'), undefined);
  await click(button('断开连接'));
  assert.equal(button('断开连接'), undefined);
  assert.equal(host.querySelectorAll('.resource-run-row').length, 2);
  assert(host.querySelectorAll('.resource-run-row')[0].textContent?.includes('执行成功'));
  assert.deepEqual(calls.map(call => call.command), ['resource_runtime', 'resource_stop']);
});

test('scene exclusion blocks future calls but keeps parameters, owned task stopping and entry editing available', async () => {
  const base = { ...item('one'), actions: [definition], sceneEligible: true, effectiveEnabled: true, sceneReason: '' };
  const calls: string[] = []; const view = root();
  const action = async (_label: string, command: string) => { calls.push(command); if (command === 'resource_runtime') return { runs: [run] }; assert.equal(command, 'resource_stop'); return { run: { ...run, status: 'stopped' } }; };
  const render = async (resource = base) => act(async () => view.render(createElement(ResourceActions, { resource, action, onChanged: () => {} })));
  await render(); await click(button('使用')); await change(host.querySelector<HTMLInputElement>('.resource-call-form input')!, 'https://example.org/kept');
  await render({ ...base, sceneEligible: false, effectiveEnabled: false, sceneReason: '当前场景未包含此工具。' });
  assert.equal(button('使用').disabled, true); assert.equal(button('执行').disabled, true); assert.equal(button('停止').disabled, false); assert.equal(button('登记运行入口').disabled, false);
  assert.equal(host.querySelector<HTMLInputElement>('.resource-call-form input')!.value, 'https://example.org/kept');
  await act(async () => host.querySelector('.resource-call-form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))); assert(!calls.includes('resource_invoke'));
  await click(button('停止')); assert.deepEqual(calls, ['resource_runtime', 'resource_stop']);
  await render({ ...base, enabled: false, sceneEligible: true, effectiveEnabled: false }); assert.equal(button('使用').disabled, true); assert.equal(button('执行').disabled, true);
});
