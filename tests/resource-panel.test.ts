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
const { ResourceRelocation } = await import(await moduleURL(new URL('../src/ResourceRelocation.tsx', import.meta.url)));
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

function relocationResource() {
  const resource = item('one');
  return { ...resource, name: '我的工具', repository: 'https://github.com/synthetic/reader', version: 'original-v1', managementScope: 'ownedFiles',
    actions: [{ ...definition, executable: `${resource.rootPath}/Scripts/agent-reach.exe`, workingDirectory: resource.rootPath }] };
}
function relocationPlan(resource = relocationResource(), newRootPath = 'D:/synthetic/relocated') {
  return { previewId: 'relocation-preview', kind: 'resourceRelocation', resourceId: resource.id, resourceRevision: resource.revision,
    oldRootPath: resource.rootPath, newRootPath, adapter: 'agentReach', version: 'detected-v2', license: 'MIT',
    actions: resource.actions.map(entry => ({ id: entry.id, label: entry.label, oldExecutable: entry.executable, newExecutable: entry.executable.replace(resource.rootPath, newRootPath), oldWorkingDirectory: entry.workingDirectory, newWorkingDirectory: newRootPath })),
    preserved: ['原资源与动作身份、管理范围、策略及授权历史'], warnings: ['仅保存目录与路径，不移动文件或执行工具。'], canApply: true, filesChanged: false, executed: false, actionsAdded: 0 };
}
function relocationReceipt(resource = relocationResource(), plan = relocationPlan(resource)) {
  return { resource: { ...resource, rootPath: plan.newRootPath, revision: resource.revision + 1, actions: resource.actions.map(entry => {
    const mapping = plan.actions.find(candidate => candidate.id === entry.id)!;
    return { ...entry, executable: mapping.newExecutable, workingDirectory: mapping.newWorkingDirectory };
  }) }, complete: true, filesChanged: false, executed: false, actionsAdded: 0 };
}

test('directory relocation chooses and previews the existing resource before saving while preserving list identity and order', async () => {
  const resource = relocationResource(), newRoot = 'D:/synthetic/目录迁移后/很长的工具路径/reader';
  const plan = relocationPlan(resource, newRoot), calls: { command: string; args: any }[] = [];
  let finish!: (value: unknown) => void;
  const action = async (_label: string, command: string, args: any) => {
    calls.push({ command, args });
    if (command === 'resource_list') return { resources: [item('two'), resource] };
    if (command === 'resource_runtime') return { runs: [] };
    if (command === 'preview_resource_relocate') return plan;
    assert.equal(command, 'apply_resource_relocate');
    return new Promise(resolve => { finish = resolve; });
  };
  let draft: ResourcePanelDraft | undefined;
  await act(async () => root().render(createElement(ResourcePanel, { action, onDraft: (value: ResourcePanelDraft) => { draft = value; } })));
  await click(button(resource.name));
  const disclosure = button('重新定位目录…');
  assert.equal(disclosure.getAttribute('aria-expanded'), 'false');
  assert.equal(host.querySelector('[aria-label="工具现在所在目录"]'), null);
  assert.deepEqual(calls.map(call => call.command), ['resource_list', 'resource_runtime']);
  await click(disclosure);
  assert(host.textContent!.includes('当前仅支持可核对的 Agent Reach、Playwright MCP 和 DragonCodexBoot'));
  const internals = (dom.window as any).__TAURI_INTERNALS__;
  try {
    (dom.window as any).__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      assert.equal(command, 'plugin:dialog|open'); assert.deepEqual(args.options, { directory: true, multiple: false, title: '选择工具现在所在的目录' }); return newRoot;
    } };
    await click(button('选择目录'));
  } finally { (dom.window as any).__TAURI_INTERNALS__ = internals; }
  assert.equal(host.querySelector<HTMLInputElement>('[aria-label="工具现在所在目录"]')!.value, newRoot);
  await click(button('预览目录变化'));
  assert.deepEqual(calls.at(-1), { command: 'preview_resource_relocate', args: { id: resource.id, expectedRevision: resource.revision, rootPath: newRoot } });
  const preview = host.querySelector('[aria-label="目录重新定位预览"]')!;
  for (const path of [resource.rootPath, newRoot, resource.actions[0].executable, plan.actions[0].newExecutable]) {
    assert([...preview.querySelectorAll('.resource-path')].some(value => value.textContent === path), `complete preview path: ${path}`);
  }
  assert(preview.textContent!.includes(plan.warnings[0]));
  assert.equal(calls.filter(call => call.command === 'apply_resource_relocate').length, 0);
  const confirm = button('确认重新定位');
  await act(async () => { confirm.click(); confirm.click(); });
  assert.deepEqual(calls.filter(call => call.command === 'apply_resource_relocate'), [{ command: 'apply_resource_relocate', args: { previewId: plan.previewId } }]);
  assert(button('正在保存目录…').disabled); assert(disclosure.disabled);
  const receipt = relocationReceipt(resource, plan);
  await act(async () => finish(receipt));
  assert.deepEqual([...host.querySelectorAll('.resource-name-button span')].map(value => value.textContent), ['two', resource.name]);
  assert.equal(host.querySelector('.resource-row.selected .resource-name-button span')!.textContent, resource.name);
  assert.equal(draft!.selectedId, resource.id); assert.deepEqual(draft!.resourceOrder, ['two', resource.id]);
  assert.equal(host.querySelector('.resource-detail > dl .resource-path')!.textContent, newRoot);
  assert.equal(host.querySelector('.resource-row.selected .resource-version')!.textContent, 'original-v1');
  assert.equal(button('确认重新定位'), undefined); assert(host.querySelector('.resource-notice')!.textContent!.includes('原管理记录已保留'));
  assert.deepEqual(calls.map(call => call.command), ['resource_list', 'resource_runtime', 'preview_resource_relocate', 'apply_resource_relocate']);
});

test('directory relocation supports a statically identified zero-action tool without guessing from its displayed name', async () => {
  const resource = { ...relocationResource(), kind: 'portable', name: '个人启动器', actions: [] };
  const plan = { ...relocationPlan(resource), adapter: 'dragonCodexBoot', version: null };
  let saved: any;
  const action = async (_label: string, command: string) => command === 'preview_resource_relocate' ? plan : relocationReceipt(resource, plan);
  await act(async () => root().render(createElement(ResourceRelocation, { resource, action, onChanged: (value: any) => { saved = value; } })));
  await click(button('重新定位目录…')); await change(host.querySelector('input')!, plan.newRootPath); await click(button('预览目录变化'));
  assert(host.querySelector('[aria-label="目录重新定位预览"]')!.textContent!.includes('DragonCodexBoot'));
  assert(host.textContent!.includes('没有已登记动作，保留原生启动入口'));
  await click(button('确认重新定位'));
  assert.equal(saved.id, resource.id); assert.deepEqual(saved.actions, []);
});

function edgeRelocationFixture() {
  const base = { ...relocationResource(), rootPath: 'D:/synthetic/Browser_Tools/Playwright-MCP' }, nodePath = 'D:/synthetic/shared-runtime/node.exe';
  const newRoot = 'D:/synthetic/Web_Tools/Playwright-MCP', oldCli = `${base.rootPath}/node_modules/@playwright/mcp/cli.js`, newCli = `${newRoot}/node_modules/@playwright/mcp/cli.js`;
  const resource = { ...base, kind: 'mcp', name: '团队浏览器工具', actions: ['edge-version', 'edge-help', 'edge-tabs', 'edge-snapshot'].map(id => ({
    ...base.actions[0], id, label: id, executable: nodePath, workingDirectory: base.rootPath,
    args: [oldCli, ...(id === 'edge-version' ? ['--version'] : id === 'edge-help' ? ['--help'] : ['--extension', '--browser', 'msedge', '--profile-dir-name', 'Default', '--output-dir', `${base.rootPath}/runtime`])].map(value => ({ type: 'literal', value })), parameters: [],
  })) };
  const basicPlan = relocationPlan(resource, newRoot);
  const plan = { ...basicPlan, adapter: 'edgeControl', license: 'Apache-2.0', actions: basicPlan.actions.map((mapping, index) => ({
    ...mapping, argumentPaths: [{ index: 0, oldPath: oldCli, newPath: newCli }, ...(resource.actions[index].args.length === 8 ? [{ index: 7, oldPath: `${base.rootPath}/runtime`, newPath: `${newRoot}/runtime` }] : [])],
  })) };
  const receipt = relocationReceipt(resource, plan);
  receipt.resource.actions = receipt.resource.actions.map(entry => ({ ...entry, args: entry.args.map(argument => ({ ...argument, value: argument.value === oldCli ? newCli : argument.value === `${base.rootPath}/runtime` ? `${newRoot}/runtime` : argument.value })) }));
  return { resource, plan, receipt, nodePath, oldCli, newCli };
}

test('Playwright MCP relocation previews all changed CLI and output paths while retaining shared Node and original actions', async () => {
  const { resource, plan, receipt, nodePath, oldCli, newCli } = edgeRelocationFixture();
  const calls: { command: string; args: any }[] = []; let saved: any;
  const action = async (_label: string, command: string, args: any) => {
    calls.push({ command, args });
    if (command === 'preview_resource_relocate') return plan;
    assert.equal(command, 'apply_resource_relocate'); return receipt;
  };
  await act(async () => root().render(createElement(ResourceRelocation, { resource, action, onChanged: (value: any) => { saved = value; } })));
  await click(button('重新定位目录…')); await change(host.querySelector('input')!, plan.newRootPath); await click(button('预览目录变化'));
  const preview = host.querySelector('[aria-label="目录重新定位预览"]')!;
  assert(preview.textContent!.includes('Playwright MCP')); assert.equal(saved, undefined);
  assert.equal([...preview.querySelectorAll('.resource-path')].filter(path => path.textContent === nodePath).length, 8);
  for (const mapping of plan.actions) { assert.equal(mapping.oldExecutable, nodePath); assert.equal(mapping.newExecutable, nodePath); }
  for (const [path, count] of [[oldCli, 4], [newCli, 4], [`${resource.rootPath}/runtime`, 2], [`${plan.newRootPath}/runtime`, 2]] as const) {
    assert.equal([...preview.querySelectorAll('.resource-path')].filter(value => value.textContent === path).length, count, `complete changed parameter path: ${path}`);
  }
  assert(preview.textContent!.includes('原参数路径（第8项）')); assert(!preview.textContent!.includes('--browser'));
  await click(button('确认重新定位'));
  assert.deepEqual(calls, [{ command: 'preview_resource_relocate', args: { id: resource.id, expectedRevision: resource.revision, rootPath: plan.newRootPath } }, { command: 'apply_resource_relocate', args: { previewId: plan.previewId } }]);
  assert.equal(saved.id, resource.id); assert.deepEqual(saved.actions.map((entry: any) => entry.id), resource.actions.map(entry => entry.id));
  assert(saved.actions.every((entry: any) => entry.executable === nodePath && entry.workingDirectory === plan.newRootPath));
  assert.deepEqual(saved.actions.map((entry: any) => entry.args), receipt.resource.actions.map(entry => entry.args));
});

test('Playwright MCP relocation checks changed parameter paths against both original actions and the save receipt', async () => {
  const { resource, plan, receipt } = edgeRelocationFixture(); let previews = 0;
  const wrongOriginal = structuredClone(plan); wrongOriginal.actions[0].argumentPaths[0].oldPath = 'D:/synthetic/unrelated/cli.js';
  const unchangedReceipt = structuredClone(receipt); unchangedReceipt.resource.actions[0].args = resource.actions[0].args;
  const action = async (_label: string, command: string) => command === 'preview_resource_relocate' ? (++previews === 1 ? wrongOriginal : plan) : unchangedReceipt;
  await act(async () => root().render(createElement(ResourceRelocation, { resource, action, onChanged: () => assert.fail('mismatched argument paths must not replace the resource') })));
  await click(button('重新定位目录…')); await change(host.querySelector('input')!, plan.newRootPath); await click(button('预览目录变化'));
  assert(host.querySelector('[role="alert"]')!.textContent!.includes('目录预览与当前工具不一致')); assert.equal(button('确认重新定位'), undefined);
  await click(button('预览目录变化')); await click(button('确认重新定位'));
  assert(host.querySelector('[role="alert"]')!.textContent!.includes('保存回执不完整')); assert.equal(button('确认重新定位'), undefined);
});

function edgeRuntimeChangeFixture() {
  const fixture = edgeRelocationFixture();
  const runtimeChange = { path: fixture.nodePath, previousSha256: 'a'.repeat(64), currentSha256: 'b'.repeat(64) };
  const resource = { ...fixture.resource, actions: fixture.resource.actions.map(entry => ({ ...entry, executableSha256: runtimeChange.previousSha256 })) };
  const plan = { ...fixture.plan, runtimeChange };
  const receipt = { ...fixture.receipt, resource: { ...fixture.receipt.resource, actions: fixture.receipt.resource.actions.map(entry => ({ ...entry, executableSha256: runtimeChange.currentSha256 })) } };
  return { resource, plan, receipt };
}

test('Playwright MCP relocation shows a changed shared runtime file before confirming the same Node path and new hashes', async () => {
  const { resource, plan, receipt } = edgeRuntimeChangeFixture(); let saved: any;
  const calls: string[] = [];
  const action = async (_label: string, command: string) => { calls.push(command); return command === 'preview_resource_relocate' ? plan : receipt; };
  await act(async () => root().render(createElement(ResourceRelocation, { resource, action, onChanged: (value: any) => { saved = value; } })));
  await click(button('重新定位目录…')); await change(host.querySelector('input')!, plan.newRootPath); await click(button('预览目录变化'));
  const runtime = [...host.querySelectorAll('details')].find(detail => detail.querySelector('summary')?.textContent === '共享运行环境校验信息已变化')!;
  assert(runtime.open); assert(runtime.textContent!.includes(plan.runtimeChange.path));
  assert(runtime.textContent!.includes(plan.runtimeChange.previousSha256)); assert(runtime.textContent!.includes(plan.runtimeChange.currentSha256));
  assert.equal(saved, undefined); assert.deepEqual(calls, ['preview_resource_relocate']);
  await click(button('确认重新定位'));
  assert.equal(saved.id, resource.id); assert.equal(saved.actions.length, 4);
  assert(saved.actions.every((entry: any) => entry.executable === plan.runtimeChange.path && entry.executableSha256 === plan.runtimeChange.currentSha256));
});

test('Playwright MCP relocation rejects mismatched original Node proofs and a receipt with an unrefreshed hash', async () => {
  const { resource, plan, receipt } = edgeRuntimeChangeFixture(); let previews = 0;
  const wrongHash = { ...plan, runtimeChange: { ...plan.runtimeChange, previousSha256: 'c'.repeat(64) } };
  const wrongPath = { ...plan, runtimeChange: { ...plan.runtimeChange, path: 'D:/synthetic/another/node.exe' } };
  const unchangedReceipt = structuredClone(receipt); unchangedReceipt.resource.actions[0].executableSha256 = plan.runtimeChange.previousSha256;
  const action = async (_label: string, command: string) => command === 'preview_resource_relocate' ? [wrongHash, wrongPath, plan][previews++] : unchangedReceipt;
  await act(async () => root().render(createElement(ResourceRelocation, { resource, action, onChanged: () => assert.fail('mismatched Node proof must not replace the resource') })));
  await click(button('重新定位目录…')); await change(host.querySelector('input')!, plan.newRootPath);
  for (let attempt = 0; attempt < 2; attempt++) {
    await click(button('预览目录变化'));
    assert(host.querySelector('[role="alert"]')!.textContent!.includes('目录预览与当前工具不一致')); assert.equal(button('确认重新定位'), undefined);
  }
  await click(button('预览目录变化')); await click(button('确认重新定位'));
  assert(host.querySelector('[role="alert"]')!.textContent!.includes('保存回执不完整')); assert.equal(button('确认重新定位'), undefined);
});

test('Playwright MCP relocation accepts unchanged runtime hashes when file identity or metadata changed', async () => {
  const fixture = edgeRuntimeChangeFixture(), sameHash = fixture.plan.runtimeChange.previousSha256;
  const plan = { ...fixture.plan, runtimeChange: { ...fixture.plan.runtimeChange, currentSha256: sameHash } };
  const receipt = { ...fixture.receipt, resource: { ...fixture.receipt.resource, actions: fixture.receipt.resource.actions.map(entry => ({ ...entry, executableSha256: sameHash })) } };
  let saved: any;
  const action = async (_label: string, command: string) => command === 'preview_resource_relocate' ? plan : receipt;
  await act(async () => root().render(createElement(ResourceRelocation, { resource: fixture.resource, action, onChanged: (value: any) => { saved = value; } })));
  await click(button('重新定位目录…')); await change(host.querySelector('input')!, plan.newRootPath); await click(button('预览目录变化'));
  const preview = host.querySelector('[aria-label="目录重新定位预览"]')!;
  assert(preview.textContent!.includes('共享运行环境校验信息已变化'));
  assert(preview.textContent!.includes('内容摘要相同，文件身份或修改信息已变化'));
  assert.equal(saved, undefined); assert(button('确认重新定位'));
  await click(button('确认重新定位'));
  assert.equal(saved.id, fixture.resource.id); assert(saved.actions.every((entry: any) => entry.executableSha256 === sameHash));
});

test('directory input changes and collapsing discard confirmed or late previews without saving', async () => {
  const resource = relocationResource(), calls: string[] = [];
  let finish!: (value: unknown) => void;
  const action = async (_label: string, command: string) => { calls.push(command); return new Promise(resolve => { finish = resolve; }); };
  await act(async () => root().render(createElement(ResourceRelocation, { resource, action, onChanged: () => assert.fail('no relocation was confirmed') })));
  const disclosure = button('重新定位目录…'); await click(disclosure);
  const input = host.querySelector('input')!;
  await change(input, 'D:/synthetic/first'); await click(button('预览目录变化'));
  assert.equal(button('正在核对目录…').disabled, true); assert.equal(input.disabled, false);
  await change(input, 'D:/synthetic/second'); await act(async () => finish(relocationPlan(resource, 'D:/synthetic/first')));
  assert.equal(button('确认重新定位'), undefined);
  await click(button('预览目录变化')); await act(async () => finish(relocationPlan(resource, 'D:/synthetic/second')));
  assert(button('确认重新定位'));
  await change(input, 'D:/synthetic/third'); assert.equal(button('确认重新定位'), undefined);
  await click(button('预览目录变化')); await click(disclosure);
  assert.equal(document.activeElement, disclosure);
  await act(async () => finish(relocationPlan(resource, 'D:/synthetic/third')));
  await click(disclosure); assert.equal(button('确认重新定位'), undefined);
  assert.deepEqual(calls, ['preview_resource_relocate', 'preview_resource_relocate', 'preview_resource_relocate']);
});

for (const scenario of ['hidden', 'basic', 'revision', 'identity']) {
  test(`directory relocation drops a late ${scenario} preview and never replays it when restored`, async () => {
    const resource = relocationResource(), calls: string[] = [];
    let finish!: (value: unknown) => void;
    const action = async (_label: string, command: string) => { calls.push(command); return new Promise(resolve => { finish = resolve; }); };
    const view = root(), props = { resource, action, onChanged: () => assert.fail('no relocation was confirmed') };
    await act(async () => view.render(createElement(ResourceRelocation, props)));
    await click(button('重新定位目录…')); await change(host.querySelector('input')!, 'D:/synthetic/new'); await click(button('预览目录变化'));
    const changed = scenario === 'hidden' ? { visible: false } : scenario === 'basic' ? { readOnly: true } : { resource: { ...resource, ...(scenario === 'revision' ? { revision: 5 } : { id: 'another-tool' }) } };
    await act(async () => view.render(createElement(ResourceRelocation, { ...props, ...changed })));
    if (scenario === 'hidden' || scenario === 'basic') assert.equal(host.querySelector('[aria-label="工具目录重新定位"]'), null);
    await act(async () => finish(relocationPlan(resource, 'D:/synthetic/new')));
    await act(async () => view.render(createElement(ResourceRelocation, props)));
    assert.equal(button('确认重新定位'), undefined); assert.deepEqual(calls, ['preview_resource_relocate']);
    await click(button('预览目录变化')); await act(async () => finish(relocationPlan(resource, 'D:/synthetic/new')));
    assert(button('确认重新定位'));
  });
}

test('an unsupported directory reports the backend reason without replacing the resource or inventing a preview', async () => {
  const calls: string[] = [], resource = { ...relocationResource(), name: 'Agent Reach', actions: [] };
  const action = async (_label: string, command: string) => { calls.push(command); throw new Error('当前登记缺少可核对的原适配记录，不能重新定位。'); };
  await act(async () => root().render(createElement(ResourceRelocation, { resource, action, onChanged: () => assert.fail('unsupported relocation must not save') })));
  await click(button('重新定位目录…')); await change(host.querySelector('input')!, 'D:/synthetic/unsupported'); await click(button('预览目录变化'));
  assert(host.querySelector('[role="alert"]')!.textContent!.includes('缺少可核对的原适配记录'));
  assert.equal(host.querySelector('[aria-label="目录重新定位预览"]'), null);
  assert.equal(button('确认重新定位'), undefined); assert.deepEqual(calls, ['preview_resource_relocate']);
});

test('directory relocation reports a failed save, consumes that preview and requires a fresh confirmation for retry', async () => {
  const resource = relocationResource(), plan = relocationPlan(resource), calls: { command: string; args: any }[] = [];
  let previews = 0, saved = 0;
  const action = async (_label: string, command: string, args: any) => {
    calls.push({ command, args });
    if (command === 'preview_resource_relocate') return { ...plan, previewId: `preview-${++previews}` };
    assert.equal(command, 'apply_resource_relocate');
    if (args.previewId === 'preview-1') throw new Error('所选目录已发生变化，未保存。');
    return relocationReceipt(resource, plan);
  };
  await act(async () => root().render(createElement(ResourceRelocation, { resource, action, onChanged: () => { saved++; } })));
  await click(button('重新定位目录…')); await change(host.querySelector('input')!, plan.newRootPath); await click(button('预览目录变化')); await click(button('确认重新定位'));
  assert.equal(saved, 0); assert.equal(button('确认重新定位'), undefined);
  assert(host.querySelector('[role="alert"]')!.textContent!.includes('所选目录已发生变化'));
  assert(host.querySelector('[role="alert"]')!.textContent!.includes('请重新预览后再确认'));
  await click(button('预览目录变化')); await click(button('确认重新定位'));
  assert.equal(saved, 1);
  assert.deepEqual(calls.filter(call => call.command === 'apply_resource_relocate').map(call => call.args), [{ previewId: 'preview-1' }, { previewId: 'preview-2' }]);
});

test('directory relocation refuses a preview for another resource and an incomplete save receipt', async () => {
  const resource = relocationResource(), plan = relocationPlan(resource);
  let previews = 0;
  const action = async (_label: string, command: string) => command === 'preview_resource_relocate'
    ? { ...plan, resourceId: ++previews === 1 ? 'another-tool' : resource.id }
    : { ...relocationReceipt(resource, plan), complete: false };
  await act(async () => root().render(createElement(ResourceRelocation, { resource, action, onChanged: () => assert.fail('invalid response must not replace current resource') })));
  await click(button('重新定位目录…')); await change(host.querySelector('input')!, plan.newRootPath); await click(button('预览目录变化'));
  assert(host.querySelector('[role="alert"]')!.textContent!.includes('目录预览与当前工具不一致')); assert.equal(button('确认重新定位'), undefined);
  await click(button('预览目录变化')); await click(button('确认重新定位'));
  assert(host.querySelector('[role="alert"]')!.textContent!.includes('保存回执不完整')); assert.equal(host.querySelector('[role="status"]'), null);
});

test('a completed directory save still updates the current resource while its panel is hidden', async () => {
  const resource = relocationResource(), plan = relocationPlan(resource);
  let finish!: (value: unknown) => void, saved: any;
  const action = async (_label: string, command: string) => command === 'preview_resource_relocate' ? plan : new Promise(resolve => { finish = resolve; });
  const view = root(), props = { resource, action, onChanged: (value: any) => { saved = value; } };
  await act(async () => view.render(createElement(ResourceRelocation, props)));
  await click(button('重新定位目录…')); await change(host.querySelector('input')!, plan.newRootPath); await click(button('预览目录变化')); await click(button('确认重新定位'));
  await act(async () => view.render(createElement(ResourceRelocation, { ...props, visible: false })));
  await act(async () => finish(relocationReceipt(resource, plan)));
  assert.equal(saved.id, resource.id); assert.equal(saved.rootPath, plan.newRootPath);
  await act(async () => view.render(createElement(ResourceRelocation, { ...props, resource: saved })));
  assert.equal(button('确认重新定位'), undefined);
});

test('changing the resource root refreshes only the untouched default working directory and keeps displayed runtime results', async () => {
  const resource = relocationResource();
  const action = async (_label: string, command: string) => {
    if (command === 'resource_runtime') return { runs: [{ ...run, status: 'succeeded' }] };
    assert.equal(command, 'resource_result'); return { run: { ...run, status: 'succeeded' }, stdout: 'retained result' };
  };
  const view = root(), props = { resource, action, onChanged: () => {} };
  await act(async () => view.render(createElement(ResourceActions, props)));
  await click(button('查看结果')); await click(button('登记运行入口'));
  const field = () => [...host.querySelectorAll('.resource-action-editor label')].find(label => label.textContent === '工作目录')!.querySelector<HTMLInputElement>('input')!;
  assert.equal(field().value, resource.rootPath);
  await act(async () => view.render(createElement(ResourceActions, { ...props, resource: { ...resource, rootPath: 'D:/synthetic/new-root', revision: 5 } })));
  assert.equal(field().value, 'D:/synthetic/new-root'); assert(host.querySelector('.resource-run-result')!.textContent!.includes('retained result'));
  await change(field(), 'D:/synthetic/my-custom-working-directory');
  await act(async () => view.render(createElement(ResourceActions, { ...props, resource: { ...resource, rootPath: 'D:/synthetic/another-root', revision: 6 } })));
  assert.equal(field().value, 'D:/synthetic/my-custom-working-directory'); assert(host.querySelector('.resource-run-result')!.textContent!.includes('retained result'));
});

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
