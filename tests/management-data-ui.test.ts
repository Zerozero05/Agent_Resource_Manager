import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act, createElement, useState } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import type { ManagementData, SkillViewFilters, ToolViewFilters } from '../src/management-data.ts';

// Render the actual components; every action below uses synthetic in-memory data.
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
async function component(name: string) {
  const file = new URL(`../src/${name}.tsx`, import.meta.url);
  let code = ts.transpileModule(await readFile(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, specifier: string) => `from ${JSON.stringify(specifier.startsWith('.') ? new URL(`${specifier}.ts`, file).href : import.meta.resolve(specifier))}`);
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`))[name];
}
const SkillMetadata = await component('SkillMetadata'), SavedViews = await component('SavedViews');
const host = document.getElementById('root')!;
let unmount = () => {};
afterEach(async () => { await act(async () => unmount()); unmount = () => {}; });
const skillFilters: SkillViewFilters = { query: 'math', sourceFilter: 'linked', statusFilter: 'attention', categoryFilter: 'favorites', sort: 'checked', mode: 'cards', pageSize: 50 };
const toolFilters: ToolViewFilters = { query: 'runner', kind: 'cli' };
const initial = (): ManagementData => ({ revision: 1, skillAnnotations: [{ skillId: 'one', revision: 1, alias: '原别名', notes: '原备注' }], savedViews: [
  { id: 'skills-1', revision: 1, name: '技能视图', view: 'skills', filters: { ...skillFilters } },
  { id: 'tools-1', revision: 1, name: '工具视图', view: 'tools', filters: { ...toolFilters } },
] });
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!;
const input = (label: string) => host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
async function click(text: string) { const target = button(text); assert(target, `Missing button: ${text}`); await act(async () => target.click()); }
async function change(label: string, value: string) {
  const target = input(label); assert(target);
  const prototype = target instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(target, value); target.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
}
async function select(value: string) { await act(async () => { const target = host.querySelector<HTMLSelectElement>('select')!; target.value = value; target.dispatchEvent(new dom.window.Event('change', { bubbles: true })); }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(Component: any, defaults: Record<string, unknown>, handler?: (action: string, args: any, data: ManagementData) => Promise<ManagementData>) {
  let data = initial(), update!: (value: ManagementData) => void;
  const calls: { action: string; args: any }[] = [], applied: unknown[] = [], root = createRoot(host);
  unmount = () => root.unmount();
  function Harness(props: Record<string, unknown>) {
    const [current, setCurrent] = useState(data); update = setCurrent;
    return createElement(Component, { ...defaults, data: current, onChanged: (value: ManagementData) => { data = value; setCurrent(value); }, onApply: (filters: unknown) => applied.push(filters),
      action: async (_label: string, action: string, args: any) => { calls.push({ action, args }); return handler ? handler(action, args, data) : data; }, ...props });
  }
  return { calls, applied, render: async (props = {}) => act(async () => root.render(createElement(Harness, props))), external: async (value: ManagementData) => act(async () => { data = value; update(value); }) };
}

test('Skill metadata starts collapsed, saves only annotations, and preserves a failed draft', async () => {
  let fails = true;
  const f = fixture(SkillMetadata, { skillId: 'one', originalName: 'original-skill' }, async (_action, args, data) => { if (fails) throw new Error('Synthetic write failed'); return { ...data, revision: 2, skillAnnotations: [{ skillId: args.skillId, revision: 2, alias: args.alias, notes: args.notes }] }; });
  await f.render(); assert.equal(host.querySelector('textarea'), null); assert.equal(f.calls.length, 0);
  await click('别名与备注'); assert(host.textContent!.includes('original-skill'));
  await change('Skill 别名', '我的别名'); await change('Skill 备注', '保留草稿\n第二行'); await click('保存别名与备注');
  assert.equal(input('Skill 备注').value, '保留草稿\n第二行'); assert(host.textContent!.includes('Synthetic write failed'));
  assert.deepEqual(f.calls[0], { action: 'skill_annotation_set', args: { skillId: 'one', expectedRevision: 1, alias: '我的别名', notes: '保留草稿\n第二行' } });
  fails = false; await click('保存别名与备注'); assert.equal(host.querySelector('textarea'), null); assert(host.textContent!.includes('我的别名')); assert.equal(document.activeElement, button('别名与备注'));
});

test('concurrent Skill edits keep the draft and require explicit reload before saving the new revision', async () => {
  const f = fixture(SkillMetadata, { skillId: 'one', originalName: 'one' }); await f.render(); await click('别名与备注'); await change('Skill 别名', '本地草稿');
  await f.external({ ...initial(), revision: 2, skillAnnotations: [{ skillId: 'one', revision: 2, alias: '其他面板', notes: '最新备注' }] });
  assert.equal(input('Skill 别名').value, '本地草稿'); assert.equal(button('保存别名与备注').disabled, true);
  await click('保存别名与备注'); assert.equal(f.calls.length, 0);
  await click('重新读取（替换草稿）'); assert.equal(input('Skill 别名').value, '其他面板'); assert.equal(button('保存别名与备注').disabled, false);
  await change('Skill 别名', '新草稿'); await click('保存别名与备注'); assert.equal(f.calls.at(-1)!.args.expectedRevision, 2);
});

test('a server conflict also blocks blind resubmission and failed reload preserves the draft', async () => {
  const f = fixture(SkillMetadata, { skillId: 'one', originalName: 'one' }, async action => { throw new Error(action === 'management_data' ? 'Synthetic read failed' : 'revision conflict'); });
  await f.render(); await click('别名与备注'); await change('Skill 别名', '草稿'); await click('保存别名与备注');
  assert.equal(button('保存别名与备注').disabled, true); await click('重新读取（替换草稿）');
  assert.equal(input('Skill 别名').value, '草稿'); assert.equal(button('保存别名与备注').disabled, true);
});

test('Skill identity changes reset the editor; new annotations use revision zero and writes coalesce', async () => {
  const pending = deferred<ManagementData>(), f = fixture(SkillMetadata, { skillId: 'one', originalName: 'one' }, () => pending.promise);
  await f.render(); await click('别名与备注'); await change('Skill 别名', '旧草稿');
  await f.render({ skillId: 'new', originalName: 'new-skill' }); assert.equal(host.querySelector('textarea'), null);
  await click('别名与备注'); assert.equal(input('Skill 别名').value, ''); await change('Skill 别名', '新别名');
  await act(async () => { button('保存别名与备注').click(); button('保存别名与备注').click(); });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].args.skillId, 'new'); assert.equal(f.calls[0].args.expectedRevision, 0);
  await act(async () => pending.resolve(initial()));
});

test('read-only metadata displays plain text without exposing writes', async () => {
  const f = fixture(SkillMetadata, { skillId: 'one', originalName: 'one', readOnly: true }); await f.render();
  await f.external({ ...initial(), skillAnnotations: [{ skillId: 'one', revision: 1, alias: '<b>alias</b>', notes: '<script>unsafe()</script>' }] }); await click('别名与备注');
  assert.equal(host.querySelector('input,textarea,script,b'), null); assert(host.textContent!.includes('<script>unsafe()</script>')); assert.equal(f.calls.length, 0); assert.equal(button('保存别名与备注'), undefined);
});

test('Basic can apply an existing skill view, without any backend action or changing display preferences', async () => {
  const f = fixture(SavedViews, { view: 'skills', filters: { ...skillFilters, query: '' }, readOnly: true }); await f.render();
  assert.equal(host.querySelectorAll('option').length, 2); assert.equal(button('保存当前视图'), undefined); await select('skills-1');
  assert.equal(f.applied.length, 0); await click('应用视图'); assert.deepEqual(f.applied, [skillFilters]); assert.equal(f.calls.length, 0);
  (f.applied[0] as SkillViewFilters).query = 'changed caller copy'; await click('应用视图'); assert.equal((f.applied[1] as SkillViewFilters).query, 'math');
});

test('tool view applies only tool filters and selection alone has no effect', async () => {
  const f = fixture(SavedViews, { view: 'tools', filters: { query: '', kind: '' } }); await f.render(); await select('tools-1');
  assert.equal(f.applied.length, 0); assert.equal(host.querySelectorAll('option').length, 2); await click('应用视图');
  assert.deepEqual(f.applied, [toolFilters]); assert.equal(f.calls.length, 0);
});

test('new view captures current filters, omits id, keeps failed draft and uses an immediate submit lock', async () => {
  const pending = deferred<ManagementData>(); let fails = true;
  const f = fixture(SavedViews, { view: 'skills', filters: skillFilters }, async () => { if (fails) throw new Error('Synthetic save failed'); return pending.promise; });
  await f.render(); await click('保存当前视图'); assert.equal(button('保存视图').disabled, true);
  await change('视图名称', '我的视图'); await f.render({ filters: { ...skillFilters, query: 'changed after opening' } });
  await click('保存视图'); assert.equal(input('视图名称').value, '我的视图'); assert.deepEqual(f.calls[0].args, { expectedRevision: 0, name: '我的视图', view: 'skills', filters: skillFilters });
  assert.equal(Object.hasOwn(f.calls[0].args, 'id'), false); fails = false;
  await act(async () => { button('保存视图').click(); button('保存视图').click(); }); assert.equal(f.calls.length, 2);
  await act(async () => pending.resolve(initial())); assert.equal(host.querySelector('input'), null); assert.equal(document.activeElement, button('保存当前视图'));
});

test('renaming an existing view retains its filters unless explicitly replaced', async () => {
  const current = { ...skillFilters, query: 'currently displayed' };
  const f = fixture(SavedViews, { view: 'skills', filters: current }); await f.render(); await select('skills-1'); await click('编辑视图');
  await change('视图名称', '新名称'); await click('保存视图'); assert.deepEqual(f.calls[0].args.filters, skillFilters); assert.equal(f.calls[0].args.id, 'skills-1'); assert.equal(f.calls[0].args.expectedRevision, 1);
  await click('编辑视图'); await click('使用当前筛选条件'); await click('保存视图'); assert.deepEqual(f.calls[1].args.filters, current);
});

test('creating a view with an existing name selects the new ID and preserves the older view', async () => {
  const filters = { ...skillFilters, query: 'new view search' };
  const f = fixture(SavedViews, { view: 'skills', filters }, async (_action, args, data) => ({ ...data, revision: 2, savedViews: [
    ...data.savedViews, { id: 'skills-new', revision: 2, name: args.name, view: 'skills', filters: args.filters },
  ] }));
  await f.render(); await click('保存当前视图'); await change('视图名称', '技能视图'); await click('保存视图');
  assert.equal(host.querySelector<HTMLSelectElement>('select')!.value, 'skills-new');
  assert(host.querySelector('option[value="skills-1"]')); await click('应用视图'); assert.deepEqual(f.applied, [filters]);
  assert.equal(f.calls.length, 1); assert.equal(Object.hasOwn(f.calls[0].args, 'id'), false);
});

test('concurrent same-name creates select only the unique newly added view with matching filters', async () => {
  const f = fixture(SavedViews, { view: 'tools', filters: toolFilters }, async (_action, args, data) => ({ ...data, revision: 3, savedViews: [
    ...data.savedViews,
    { id: 'tools-other', revision: 2, name: args.name, view: 'tools', filters: { ...toolFilters, query: 'another window' } },
    { id: 'tools-new', revision: 3, name: args.name, view: 'tools', filters: { kind: args.filters.kind, query: args.filters.query } },
  ] }));
  await f.render(); await click('保存当前视图'); await change('视图名称', '工具视图'); await click('保存视图');
  assert.equal(host.querySelector<HTMLSelectElement>('select')!.value, 'tools-new'); await click('应用视图'); assert.deepEqual(f.applied, [toolFilters]);
});

test('indistinguishable concurrent same-name creates leave selection empty instead of guessing an ID', async () => {
  const f = fixture(SavedViews, { view: 'tools', filters: toolFilters }, async (_action, args, data) => ({ ...data, revision: 3, savedViews: [
    ...data.savedViews,
    { id: 'tools-other', revision: 2, name: args.name, view: 'tools', filters: { ...args.filters } },
    { id: 'tools-new', revision: 3, name: args.name, view: 'tools', filters: { ...args.filters } },
  ] }));
  await f.render(); await select('tools-1'); await click('保存当前视图'); await change('视图名称', '工具视图'); await click('保存视图');
  assert.equal(host.querySelector<HTMLSelectElement>('select')!.value, ''); assert.equal(button('应用视图').disabled, true);
  await click('应用视图'); assert.equal(f.applied.length, 0); assert.equal(f.calls.length, 1);
});

test('view concurrency preserves name draft and reload supplies the revision for remove', async () => {
  const f = fixture(SavedViews, { view: 'tools', filters: toolFilters }); await f.render(); await select('tools-1'); await click('编辑视图'); await change('视图名称', '本地视图草稿');
  const newer = initial(); newer.revision = 3; newer.savedViews[1] = { ...newer.savedViews[1], revision: 3, name: '外部新名称' }; await f.external(newer);
  assert.equal(input('视图名称').value, '本地视图草稿'); assert.equal(button('保存视图').disabled, true); assert.equal(button('删除视图').disabled, true);
  await click('重新读取（替换草稿）'); assert.equal(input('视图名称').value, '外部新名称'); await click('删除视图');
  assert.deepEqual(f.calls.at(-1), { action: 'saved_view_remove', args: { id: 'tools-1', expectedRevision: 3 } }); assert.equal(f.applied.length, 0);
});

test('removal elsewhere disables stale updates and explicit reload safely exits the editor', async () => {
  const f = fixture(SavedViews, { view: 'tools', filters: toolFilters }); await f.render(); await select('tools-1'); await click('编辑视图');
  await f.external({ ...initial(), revision: 2, savedViews: [] }); assert.equal(button('保存视图').disabled, true); await click('重新读取（替换草稿）');
  assert.equal(host.querySelector('input'), null); assert(host.textContent!.includes('此视图已被删除')); assert.equal(f.calls.length, 1);
  assert.equal(host.querySelector('select'), null, 'an empty saved-view selector does not occupy the toolbar');
  assert(document.activeElement === button('保存当前视图'), 'focus returns to the remaining view creation action');
});
