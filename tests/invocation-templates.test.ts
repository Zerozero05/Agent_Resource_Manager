import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { sensitiveResourceParameter, templateParameterAllowed, type Resource, type ResourceActionDefinition } from '../src/resources.ts';

const modules = new Map<string, Promise<string>>();
async function moduleURL(url: URL): Promise<string> {
  const found = modules.get(url.href); if (found) return found;
  const loading = (async () => {
    let code = ts.transpileModule(await readFile(url, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const replacements = new Map<string, string>();
    for (const match of code.matchAll(/from\s+(['"])([^'"]+)\1/g)) {
      const value = match[2]; if (replacements.has(value)) continue;
      let resolved: string;
      if (value.startsWith('.')) { let path = new URL(`${value}.ts`, url); try { await access(path); } catch { path = new URL(`${value}.tsx`, url); } resolved = await moduleURL(path); }
      else resolved = import.meta.resolve(value);
      replacements.set(value, resolved);
    }
    code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, value) => `from ${JSON.stringify(replacements.get(value))}`);
    return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  })(); modules.set(url.href, loading); return loading;
}
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const { ResourceActions } = await import(await moduleURL(new URL('../src/ResourceActions.tsx', import.meta.url)));
const host = document.getElementById('root')!; let unmount = () => {};
afterEach(async () => { await act(async () => unmount()); unmount = () => {}; });
const definition: ResourceActionDefinition = { id: 'read', label: '读取内容', mode: 'task', executable: 'D:/synthetic/tool.exe', workingDirectory: 'D:/synthetic', args: [], parameters: [
  { name: 'query', label: '查询', kind: 'text', required: true, templateAllowed: true },
  { name: 'language', label: '语言', kind: 'choice', choices: ['en', 'zh'], templateAllowed: true },
  { name: 'count', label: '数量', kind: 'integer', templateAllowed: true },
  { name: 'api_token', label: '令牌', kind: 'text', templateAllowed: true },
  { name: 'custom', label: '敏感自定义', kind: 'text', sensitive: true, templateAllowed: true },
  { name: 'url', label: '未允许地址', kind: 'text' },
] };
const resource = (): Resource => ({ id: 'tool', name: 'Tool', kind: 'cli', rootPath: 'D:/synthetic', alias: '', notes: '', enabled: true, ownership: 'external', revision: 4, managementScope: 'register', actions: [structuredClone(definition)], capabilities: [], createdAt: '', updatedAt: '' });
const template = () => ({ id: 'saved', revision: 2, name: '常用内容', resourceId: 'tool', actionId: 'read', parameterNames: ['language', 'count'], compatible: true });
const listed = () => ({ templates: [template()], resourceRevision: 4 });
const prepared = () => ({ parameters: { language: 'zh', count: 3 }, resourceRevision: 4, actionId: 'read', templateId: 'saved' });
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)!;
const input = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
async function click(label: string) { assert(button(label), `Missing button ${label}`); await act(async () => button(label).click()); }
async function change(label: string, value: string) { await act(async () => { const target = input(label); Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(target, value); target.dispatchEvent(new dom.window.Event('input', { bubbles: true })); }); }
async function selectTemplate() { await act(async () => { const target = host.querySelector<HTMLSelectElement>('[aria-label="调用模板"]')!; target.value = 'saved'; target.dispatchEvent(new dom.window.Event('change', { bubbles: true })); }); }
async function check(label: string) { await act(async () => input(`保存参数：${label}`).click()); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(handler?: (command: string, args: any) => Promise<any>, initial = resource()) {
  const calls: { command: string; args: any }[] = [], root = createRoot(host); unmount = () => root.unmount();
  const action = async (_label: string, command: string, args: any) => {
    calls.push({ command, args }); if (command === 'resource_runtime') return { runs: [] };
    if (handler) return handler(command, args);
    if (command === 'resource_templates') return listed();
    if (command === 'resource_template_prepare') return prepared();
    if (command === 'resource_template_save') return { ...listed(), templateId: args.templateId || 'new' };
    if (command === 'resource_template_remove') return { templates: [], resourceRevision: 4 };
    if (command === 'resource_invoke') return { run: { runId: 'synthetic', resourceId: 'tool', actionId: 'read', status: 'succeeded', mode: 'task', pid: 1, startedAt: '2026-10-30T00:00:00Z' } };
    assert.fail(command);
  };
  return { calls, render: async (props = {}) => act(async () => root.render(createElement(ResourceActions, { resource: initial, action, onChanged: () => {}, ...props }))) };
}
async function openTemplates() { await click('使用'); await click('常用模板'); }

test('template permissions require explicit opt-in and reject sensitive flags and normalized secret names', () => {
  for (const name of ['api_key', 'API-TOKEN', 'cookie', 'password', 'sessionKey', 'authorization', 'private_key', 'pwd', 'credentials', 'mySecret']) {
    const parameter = { name, label: name, kind: 'text' as const, templateAllowed: true };
    assert(sensitiveResourceParameter(parameter), name); assert.equal(templateParameterAllowed(parameter), false);
  }
  assert.equal(templateParameterAllowed({ name: 'query', label: 'q', kind: 'text' }), false);
  assert.equal(templateParameterAllowed({ name: 'query', label: 'q', kind: 'text', templateAllowed: true }), true);
  assert.equal(templateParameterAllowed({ name: 'custom', label: 'q', kind: 'text', templateAllowed: true, sensitive: true }), false);
});

test('templates load only when expanded, preserve command focus, and do not request again when merely collapsed', async () => {
  const f = fixture(); await f.render(); assert.deepEqual(f.calls.map(call => call.command), ['resource_runtime']);
  await click('使用'); assert.equal(document.activeElement, input('查询')); assert.equal(f.calls.length, 1);
  await click('常用模板'); assert.equal(f.calls.at(-1)!.command, 'resource_templates'); assert.equal(document.activeElement, input('查询'));
  await click('常用模板'); await click('常用模板'); assert.equal(f.calls.filter(call => call.command === 'resource_templates').length, 1);
});

test('only checked eligible parameters are saved; secrets use password inputs and required values may be omitted', async () => {
  const f = fixture(); await f.render(); await openTemplates();
  assert.equal(input('令牌').type, 'password'); assert.equal(input('敏感自定义').type, 'password');
  await change('查询', 'current query'); await change('数量', '7'); await change('令牌', 'private-token-value'); await change('敏感自定义', 'private-custom-value'); await change('未允许地址', 'https://private.invalid');
  await click('保存当前为模板'); await change('模板名称', '少量参数');
  const boxes = [...host.querySelectorAll<HTMLInputElement>('.invocation-template-editor input[type=checkbox]')]; assert.equal(boxes.length, 3); assert(boxes.every(node => !node.checked));
  await check('数量'); await click('保存模板');
  const saved = f.calls.find(call => call.command === 'resource_template_save')!;
  assert.deepEqual(saved.args, { id: 'tool', actionId: 'read', expectedResourceRevision: 4, expectedRevision: 0, name: '少量参数', parameters: { count: 7 } });
  assert(!JSON.stringify(f.calls).includes('private-token-value')); assert(!JSON.stringify(f.calls).includes('private-custom-value')); assert(!JSON.stringify(f.calls).includes('private.invalid'));
  assert.equal(dom.window.localStorage.length, 0); assert.equal(dom.window.sessionStorage.length, 0);
});

test('an action with no allowed parameter can save an empty entry template', async () => {
  const current = resource(); current.actions[0].parameters = [{ name: 'url', label: '地址', kind: 'text', required: true }];
  const f = fixture(undefined, current); await f.render(); await openTemplates(); await click('保存当前为模板');
  assert(host.textContent!.includes('未声明可记录参数')); await change('模板名称', '入口'); await click('保存模板');
  assert.deepEqual(f.calls.find(call => call.command === 'resource_template_save')!.args.parameters, {});
});

test('prepare fills only returned fields, preserves other inputs, and execution requires a separate current-revision submit', async () => {
  const f = fixture(); await f.render(); await openTemplates(); await change('查询', 'keep this request'); await selectTemplate(); await click('填入参数');
  assert.equal(input('查询').value, 'keep this request'); assert.equal(input('数量').value, '3');
  assert.equal(host.querySelector<HTMLSelectElement>('[aria-label="语言"]')!.value, 'zh');
  assert.equal(f.calls.filter(call => call.command === 'resource_invoke').length, 0);
  assert.deepEqual(f.calls.find(call => call.command === 'resource_template_prepare')!.args, { id: 'tool', actionId: 'read', templateId: 'saved', expectedRevision: 2, expectedResourceRevision: 4 });
  await click('执行'); assert.deepEqual(f.calls.find(call => call.command === 'resource_invoke')!.args, { id: 'tool', actionId: 'read', expectedRevision: 4, parameters: { query: 'keep this request', language: 'zh', count: 3 } });
});

test('incompatible templates show their reason and cannot prepare', async () => {
  const f = fixture(async command => { assert.equal(command, 'resource_templates'); return { ...listed(), templates: [{ ...template(), compatible: false, reason: '入口定义已变化' }] }; });
  await f.render(); await openTemplates(); await selectTemplate(); assert(host.textContent!.includes('入口定义已变化')); assert.equal(button('填入参数').disabled, true);
  await click('填入参数'); assert.equal(f.calls.filter(call => call.command === 'resource_template_prepare').length, 0);
});

test('save errors retain the name and checked names, while Enter in the template editor cannot invoke the resource', async () => {
  const f = fixture(async command => { if (command === 'resource_templates') return listed(); throw new Error('Synthetic revision conflict'); });
  await f.render(); await openTemplates(); await click('保存当前为模板'); await change('模板名称', '未丢失草稿'); await check('查询');
  const event = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }); await act(async () => input('模板名称').dispatchEvent(event)); assert(event.defaultPrevented);
  await click('保存模板'); assert.equal(input('模板名称').value, '未丢失草稿'); assert(input('保存参数：查询').checked); assert(host.textContent!.includes('Synthetic revision conflict'));
  assert(!f.calls.some(call => call.command === 'resource_invoke'));
});

test('update and removal use the selected template revision and leave invocation untouched', async () => {
  const f = fixture(); await f.render(); await openTemplates(); await selectTemplate(); await click('编辑模板');
  assert([...host.querySelectorAll<HTMLInputElement>('.invocation-template-editor input[type=checkbox]')].every(node => !node.checked));
  await change('模板名称', '新名称'); await click('保存并替换模板');
  assert.deepEqual(f.calls.find(call => call.command === 'resource_template_save')!.args, { id: 'tool', actionId: 'read', expectedResourceRevision: 4, templateId: 'saved', expectedRevision: 2, name: '新名称', parameters: {} });
  await click('删除模板'); assert.deepEqual(f.calls.at(-1), { command: 'resource_template_remove', args: { id: 'tool', actionId: 'read', templateId: 'saved', expectedRevision: 2 } });
  assert(!f.calls.some(call => call.command === 'resource_invoke'));
});

test('read errors wait for explicit retry instead of polling', async () => {
  let reads = 0; const f = fixture(async command => { assert.equal(command, 'resource_templates'); if (++reads === 1) throw new Error('Synthetic read failed'); return listed(); });
  await f.render(); await openTemplates(); await f.render(); assert.equal(reads, 1); await click('重试读取模板'); assert.equal(reads, 2);
});

test('Basic lists existing templates without opening a call form or offering writes or preparation', async () => {
  const f = fixture(); await f.render({ readOnly: true }); assert.equal(f.calls.length, 1); await click('查看模板'); await selectTemplate();
  assert.equal(host.querySelector('.resource-call-form'), null); assert.equal(button('填入参数'), undefined); assert.equal(button('保存当前为模板'), undefined); assert.equal(button('删除模板'), undefined);
  assert(f.calls.every(call => ['resource_runtime', 'resource_templates'].includes(call.command)));
});

test('prepare is single-flight and a resource revision change prevents the late reply filling a reopened form', async () => {
  const pending = deferred<any>(); const f = fixture(async command => command === 'resource_templates' ? listed() : pending.promise);
  await f.render(); await openTemplates(); await selectTemplate(); await act(async () => { button('填入参数').click(); button('填入参数').click(); });
  assert.equal(f.calls.filter(call => call.command === 'resource_template_prepare').length, 1); assert.equal(button('执行').disabled, true);
  const current = resource(); current.revision = 5; await f.render({ resource: current }); assert.equal(host.querySelector('.resource-call-form'), null);
  await click('使用'); await change('查询', 'new revision input'); await act(async () => pending.resolve(prepared()));
  assert.equal(input('查询').value, 'new revision input'); assert.equal(input('数量').value, '');
});

test('a new command request invalidates a pending prepare even when the action ID is unchanged', async () => {
  const pending = deferred<any>(); const f = fixture(async command => command === 'resource_templates' ? listed() : pending.promise);
  await f.render({ focusActionId: 'read', focusActionRevision: 4, focusRequest: 1 }); await click('常用模板'); await selectTemplate(); await click('填入参数');
  await f.render({ focusActionId: 'read', focusActionRevision: 4, focusRequest: 2 }); await change('查询', 'new command'); await act(async () => pending.resolve(prepared()));
  assert.equal(input('数量').value, ''); assert.equal(input('查询').value, 'new command');
});

test('prepare replies cannot insert undeclared or sensitive parameters into the current form', async () => {
  const f = fixture(async command => command === 'resource_templates' ? listed() : { ...prepared(), parameters: { count: 6, api_token: 'injected-token', custom: 'injected-custom', url: 'not-opted-in', unknown: 'no' } });
  await f.render(); await openTemplates(); await selectTemplate(); await click('填入参数');
  assert.equal(input('数量').value, '6'); assert.equal(input('令牌').value, ''); assert.equal(input('敏感自定义').value, ''); assert.equal(input('未允许地址').value, '');
});

test('a template preparation immediately blocks a simultaneous form submit until its parameters are ready', async () => {
  const pending = deferred<any>(); const f = fixture(async command => command === 'resource_templates' ? listed() : pending.promise);
  await f.render(); await openTemplates(); await selectTemplate(); await change('查询', 'query');
  await act(async () => { button('填入参数').click(); host.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
  assert(!f.calls.some(call => call.command === 'resource_invoke')); await act(async () => pending.resolve(prepared())); assert.equal(input('数量').value, '3');
});

test('a late save response cannot replace template state after switching to a different action', async () => {
  const pending = deferred<any>(), current = resource(); current.actions.push({ ...structuredClone(definition), id: 'second', label: '第二动作' });
  const f = fixture(async (command, args) => command === 'resource_templates' ? { templates: [], resourceRevision: 4 } : pending.promise, current);
  await f.render({ focusActionId: 'read', focusActionRevision: 4, focusRequest: 1 }); await click('常用模板'); await click('保存当前为模板'); await change('模板名称', '旧动作模板'); await click('保存模板');
  await f.render({ focusActionId: 'second', focusActionRevision: 4, focusRequest: 2 }); await click('常用模板');
  await act(async () => pending.resolve({ ...listed(), templateId: 'saved' }));
  assert.equal(host.querySelector('form')!.getAttribute('aria-label'), '使用第二动作');
  assert.equal(host.querySelectorAll('[aria-label="调用模板"] option').length, 1); assert(!host.textContent!.includes('常用内容'));
});

test('prepare rejects a reply whose resource revision or action identity no longer matches', async () => {
  const f = fixture(async command => command === 'resource_templates' ? listed() : { ...prepared(), resourceRevision: 5, actionId: 'other' });
  await f.render(); await openTemplates(); await selectTemplate(); await click('填入参数');
  assert.equal(input('数量').value, ''); assert(host.textContent!.includes('动作信息已变化')); assert(!f.calls.some(call => call.command === 'resource_invoke'));
});
