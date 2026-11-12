import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import type { SceneData, SceneDraft, SceneMember } from '../src/SceneControls.tsx';
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
let code = ts.transpileModule(await readFile(new URL('../src/SceneControls.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText.replace(/import\s+['"][^'"]+\.css['"];?/g, '');
code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, specifier: string) => `from ${JSON.stringify(import.meta.resolve(specifier))}`);
const host = document.getElementById('root')!; let cleanup = () => {}, instance = 0;
afterEach(async () => { await act(async () => cleanup()); cleanup = () => {}; });
const member = (kind: SceneMember['kind'], id: string, extra: Partial<SceneMember> = {}): SceneMember => ({ kind, id, name: `${kind}-${id}`, exists: true, enabled: true, sceneEligible: true, effectiveEnabled: true, sceneReason: '', ...extra });
const skill = member('skill', 'same'), tool = member('tool', 'same', { enabled: false, effectiveEnabled: false });
const missing = member('tool', 'missing', { exists: false, enabled: false, effectiveEnabled: false });
const data = (revision = 7): SceneData => ({ revision, activeSceneId: null, scenes: [{ id: 'scene-one', name: '工作', members: [skill, missing] }], candidates: [skill, tool] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(handler: (command: string, args: any) => Promise<SceneData> = async () => data(), copies = 1) {
  const { SceneControls } = await import(`data:text/javascript;base64,${Buffer.from(code + `\n// fixture ${++instance}`).toString('base64')}`);
  const calls: { command: string; args: any }[] = []; let saved: SceneDraft | undefined;
  let root = createRoot(host); cleanup = () => root.unmount();
  const action = async (_label: string, command: string, args: any) => { calls.push({ command, args }); return handler(command, args); };
  const render = async (props = {}) => act(async () => root.render(createElement('div', null, ...Array.from({ length: copies }, (_, index) => createElement(SceneControls, { key: index, action, revision: 100, onDraft: (value: SceneDraft) => { saved = value; }, ...props })))));
  return { calls, render, draft: () => saved!, remount: async () => { const initialDraft = structuredClone(saved); await act(async () => root.unmount()); root = createRoot(host); await render({ initialDraft }); } };
}
const button = (text: string, scope: Element = host) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)!;
async function click(text: string, scope = host) { assert(button(text, scope), text); await act(async () => button(text, scope).click()); }
async function choose(value: string) { await act(async () => { const select = host.querySelector<HTMLSelectElement>('[aria-label="场景定义"]')!; select.value = value; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); }); }
async function name(value: string) { await act(async () => { const input = host.querySelector<HTMLInputElement>('[aria-label="场景名称"]')!; Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); }); }
async function check(label: string) { await act(async () => host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!.click()); }

test('collapsed and hidden scene controls read nothing, and visible controls share one in-flight read', async () => {
  const pending = deferred<SceneData>(); const f = await fixture(() => pending.promise, 2); await f.render({ visible: false }); assert.equal(f.calls.length, 0);
  await f.render(); const controls = [...host.querySelectorAll<HTMLElement>('[aria-label="场景设置"]')];
  await click('管理场景', controls[0]); await click('管理场景', controls[1]); assert.equal(f.calls.length, 1);
  await act(async () => pending.resolve(data())); await f.render(); assert.equal(f.calls.length, 1);
  assert(controls.every(control => control.textContent!.includes('无场景限制')));
});

test('creating a scene submits explicit Skill/tool identities and independent CAS without activating or launching anything', async () => {
  const f = await fixture(async (command, args) => command === 'resource_scenes' ? data() : { ...data(8), scenes: [...data().scenes, { id: 'new-scene', name: args.name, members: [skill, tool] }] });
  await f.render(); await click('管理场景'); await click('新建场景'); await name('工作'); await check('Skill skill-same'); await check('工具 tool-same'); await click('保存场景');
  assert.deepEqual(f.calls.at(-1), { command: 'resource_scene_save', args: { expectedRevision: 7, name: '工作', members: [{ kind: 'skill', id: 'same' }, { kind: 'tool', id: 'same' }] } });
  assert.equal(host.querySelector<HTMLSelectElement>('[aria-label="场景定义"]')!.value, 'new-scene', 'same names must not select the old scene');
  assert(host.textContent!.includes('无场景限制')); assert(host.textContent!.includes('已手动停用')); assert(f.calls.every(call => ['resource_scenes', 'resource_scene_save'].includes(call.command)));
});

test('existing missing members are visible, preserved by editing and removable only through an explicit unchecked choice', async () => {
  let current = data(); const f = await fixture(async (command, args) => { if (command !== 'resource_scenes') current = { ...data(8), scenes: [{ id: args.id, name: args.name, members: args.members.map((value: SceneMember) => value.id === 'missing' ? missing : skill) }] }; return current; });
  await f.render(); await click('管理场景'); await choose('scene-one'); assert(host.textContent!.includes('失效引用')); await click('编辑场景'); await name('仍保留'); await click('保存场景');
  assert(f.calls.at(-1)!.args.members.some((value: SceneMember) => value.id === 'missing'));
  await click('编辑场景'); await check('工具 tool-missing'); await click('保存场景'); assert(!f.calls.at(-1)!.args.members.some((value: SceneMember) => value.id === 'missing'));
});

test('activation and leaving a scene only change activeSceneId and keep manual disable untouched', async () => {
  const f = await fixture(async (command, args) => command === 'resource_scenes' ? data() : { ...data(8), activeSceneId: args.id });
  await f.render(); await click('管理场景'); await choose('scene-one'); await click('启用此场景');
  assert.deepEqual(f.calls.at(-1), { command: 'resource_scene_activate', args: { expectedRevision: 7, id: 'scene-one' } }); assert(host.textContent!.includes('当前：工作'));
  await click('退出当前场景'); assert.deepEqual(f.calls.at(-1), { command: 'resource_scene_activate', args: { expectedRevision: 8, id: null } });
  assert(host.textContent!.includes('手动停用始终优先')); assert(!f.calls.some(call => /invoke|stop|enabled|connect/.test(call.command)));
});

test('same-turn save clicks and scene switches share one write lock', async () => {
  const pending = deferred<SceneData>(); const f = await fixture(async command => command === 'resource_scenes' ? data() : pending.promise);
  await f.render(); await click('管理场景'); await choose('scene-one'); await click('编辑场景'); await name('新名称');
  await act(async () => { button('保存场景').click(); button('保存场景').click(); button('启用此场景').click(); });
  assert.equal(f.calls.filter(call => call.command !== 'resource_scenes').length, 1); await act(async () => pending.resolve(data(8)));
});

test('conflicting saves retain the draft and require explicit refresh before saving with the new revision', async () => {
  let reads = 0; const f = await fixture(async command => { if (command === 'resource_scenes') return data(++reads === 1 ? 7 : 9); throw new Error('场景已变化，请刷新'); });
  await f.render(); await click('管理场景'); await choose('scene-one'); await click('编辑场景'); await name('失败保留'); await click('保存场景');
  assert.equal(host.querySelector<HTMLInputElement>('[aria-label="场景名称"]')!.value, '失败保留'); assert.equal(button('保存场景').disabled, true);
  await click('重新读取（替换场景草稿）'); assert.equal(host.querySelector<HTMLInputElement>('[aria-label="场景名称"]')!.value, '工作'); await name('已核对'); await click('保存场景'); assert.equal(f.calls.at(-1)!.args.expectedRevision, 9);
});

test('background revisions keep dirty edits and hidden changes cause only one catch-up read', async () => {
  let reads = 0; const f = await fixture(async () => data(++reads === 1 ? 7 : 9)); await f.render(); await click('管理场景'); await choose('scene-one'); await click('编辑场景'); await name('未提交');
  await f.render({ visible: false, revision: 101 }); await f.render({ visible: false, revision: 102 }); assert.equal(reads, 1);
  await f.render({ visible: true, revision: 102 }); assert.equal(reads, 2); assert.equal(host.querySelector<HTMLInputElement>('[aria-label="场景名称"]')!.value, '未提交'); assert.equal(button('保存场景').disabled, true);
  await f.render({ revision: 102 }); assert.equal(reads, 2);
});

test('a read invalidated while pending never clears stale status and follows up once', async () => {
  const pending = deferred<SceneData>(); let reads = 0; const f = await fixture(async () => ++reads === 1 ? pending.promise : { ...data(9), activeSceneId: 'scene-one' });
  await f.render(); await click('管理场景'); await f.render({ revision: 101 }); await f.render({ revision: 102 }); await act(async () => pending.resolve(data()));
  assert.equal(reads, 2); assert(host.textContent!.includes('当前：工作')); assert.equal(button('新建场景').disabled, false);
});

test('read failures preserve existing records and wait for explicit retry rather than rerender polling', async () => {
  let reads = 0; const f = await fixture(async () => { if (++reads > 1) throw new Error('Synthetic read failed'); return data(); }); await f.render(); await click('管理场景'); await choose('scene-one'); await click('刷新场景');
  assert(host.textContent!.includes('失效引用')); assert(host.textContent!.includes('Synthetic read failed')); await f.render(); assert.equal(reads, 2);
});

test('Basic can inspect scenes and missing members but offers no writes', async () => {
  const f = await fixture(); await f.render({ readOnly: true }); await click('管理场景'); await choose('scene-one'); assert(host.textContent!.includes('失效引用'));
  for (const label of ['新建场景', '编辑场景', '启用此场景', '退出当前场景', '移除场景定义']) assert.equal(button(label), undefined);
  await click('刷新场景'); assert(f.calls.every(call => call.command === 'resource_scenes'));
});

test('remounting restores an unsaved draft without rereading fresh data or replaying a save', async () => {
  const f = await fixture(); await f.render(); await click('管理场景'); await click('新建场景'); await name('稍后保存'); await check('Skill skill-same'); await f.remount();
  assert.equal(host.querySelector<HTMLInputElement>('[aria-label="场景名称"]')!.value, '稍后保存'); assert.equal(host.querySelector<HTMLInputElement>('[aria-label="Skill skill-same"]')!.checked, true); assert.equal(f.calls.length, 1);
});

test('removing the active scene follows the backend result and does not delete resources or stop tasks', async () => {
  const f = await fixture(async command => command === 'resource_scenes' ? { ...data(), activeSceneId: 'scene-one' } : { ...data(8), scenes: [] });
  await f.render(); await click('管理场景'); await click('移除场景定义'); assert.deepEqual(f.calls.at(-1), { command: 'resource_scene_remove', args: { expectedRevision: 7, id: 'scene-one' } }); assert(host.textContent!.includes('无场景限制')); assert.equal(f.calls.length, 2);
});
