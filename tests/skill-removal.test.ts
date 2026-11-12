import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
const dom = new JSDOM('<html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
let historyCode = ts.transpileModule(await readFile(new URL('../src/RemovalHistory.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText.replace(/import\s+['"][^'"]+\.css['"];?/g, '');
historyCode = historyCode.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, name: string) => `from ${JSON.stringify(import.meta.resolve(name))}`);
const historyURL = `data:text/javascript;base64,${Buffer.from(historyCode).toString('base64')}`;
let code = ts.transpileModule(await readFile(new URL('../src/SkillRemoval.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText.replace(/import\s+['"][^'"]+\.css['"];?/g, '');
code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, name: string) => `from ${JSON.stringify(name === './RemovalHistory' ? historyURL : import.meta.resolve(name))}`);
const { SkillRemoval } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const host = document.getElementById('root')!;
let dispose = () => {};
afterEach(async () => { await act(async () => dispose()); });
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!;
const click = async (label: string) => act(async () => button(label).click());
async function extent(value: string) { await act(async () => { const select = host.querySelector('select')!; select.value = value; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); }); }
const plan = { id: 'preview', kind: 'skillRemove', skillId: 'skill', extent: 'runtime', targetPath: 'D:/synthetic/skill', entries: [{ path: 'D:/synthetic/skill/SKILL.md', relative: 'SKILL.md', remove: true, expected: { sha256: 'fixed' }, reason: '归属及摘要已核对' }], linkEntries: [], warnings: ['来源和未知文件保留'], canApply: true };
function fixture(handler: (command: string, args: any) => unknown = () => plan) {
  const root = createRoot(host); dispose = () => root.unmount();
  const calls: { command: string; args: any }[] = [], changes: boolean[] = [];
  const props = { skillId: 'skill', name: 'Skill', revision: 1, action: async (_label: string, command: string, args: any) => { calls.push({ command, args }); return handler(command, args); }, onChanged: () => changes.push(true) };
  return { calls, changes, render: async (changes = {}) => act(async () => root.render(createElement(SkillRemoval, { ...props, ...changes }))) };
}
test('each Skill removal needs a fresh extent and exact preview, reopening cannot reuse consent', async () => {
  const f = fixture(command => command === 'apply_skill_remove' ? { complete: true } : plan);
  await f.render(); assert.equal(f.calls.length, 0); await click('卸载或停用 Skill');
  assert.equal(host.querySelector('select')!.value, ''); assert(button('预览本次影响').disabled);
  await extent('runtime'); await click('预览本次影响');
  assert(host.textContent!.includes(plan.entries[0].path)); assert(host.textContent!.includes('来源和未知文件保留'));
  assert.deepEqual(f.calls[0], { command: 'preview_skill_remove', args: { skillId: 'skill', extent: 'runtime', customFiles: [] } });
  await click('确认按此清单处理 Skill');
  assert.deepEqual(f.calls[1], { command: 'apply_skill_remove', args: { previewId: 'preview' } });
  assert.deepEqual(f.changes, [true]); assert.equal(host.querySelector('select')!.value, '');
  await click('关闭'); await click('卸载或停用 Skill'); assert.equal(host.querySelector('select')!.value, ''); assert.equal(host.querySelector('[aria-label="Skill 卸载影响清单"]'), null);
});
test('unowned or changed Skill cannot apply and a failed removal requires a new preview', async () => {
  const f = fixture(command => { if (command === 'apply_skill_remove') throw new Error('目录内容已变化'); return plan; });
  await f.render(); await click('卸载或停用 Skill'); await extent('runtime'); await click('预览本次影响');
  await click('确认按此清单处理 Skill'); assert(host.textContent!.includes('目录内容已变化'));
  assert.equal(host.querySelector('[aria-label="Skill 卸载影响清单"]'), null); assert.equal(f.changes.length, 0);
  await extent('full'); await click('预览本次影响'); await f.render({ revision: 2 });
  assert.equal(host.querySelector('[aria-label="Skill 卸载影响清单"]'), null);
});
test('hidden or Basic pages cannot submit, and late preview results do not revive confirmation', async () => {
  let resolve!: (value: unknown) => void;
  const f = fixture(() => new Promise(yes => { resolve = yes; }));
  await f.render({ readOnly: true }); assert(button('卸载或停用 Skill').disabled); await click('卸载或停用 Skill'); assert.equal(f.calls.length, 0);
  await f.render(); await click('卸载或停用 Skill'); await extent('runtime'); await click('预览本次影响');
  await f.render({ visible: false }); await act(async () => resolve(plan));
  assert.equal(host.querySelector('[aria-label="Skill 卸载影响清单"]'), null); assert.equal(f.calls.length, 1);
});
test('partial removal keeps clear outcome, never repeats automatically or calls forget', async () => {
  const f = fixture(command => command === 'apply_skill_remove' ? { complete: false, result: { failures: [['D:/synthetic/skill/SKILL.md', '正在使用']] } } : plan);
  await f.render(); await click('卸载或停用 Skill'); await extent('runtime'); await click('预览本次影响'); await click('确认按此清单处理 Skill');
  assert(host.textContent!.includes('本次未完整完成')); assert(host.textContent!.includes('正在使用'));
  assert.equal(f.calls.length, 2); assert.equal(f.changes.length, 1); assert(!f.calls.some(call => call.command === 'forget'));
  assert(button('预览本次影响').disabled);
});

test('persisted interrupted Skill removal remains visible without replaying the old intent', async () => {
  const path = 'D:/synthetic/skill/script.py';
  const lastRemoval = { status: 'processing', entries: [{ path, remove: true }, { path: 'D:/synthetic/skill/notes.md', remove: false }] };
  const f = fixture();
  await f.render({ lastRemoval });
  const history = host.querySelector<HTMLDetailsElement>('[aria-label="已保存的卸载记录"]')!;
  assert.equal(history.open, false);
  assert(history.textContent!.includes('上次卸载记录未完成'));
  assert(history.textContent!.includes(path));
  assert(history.textContent!.includes('结果待核对'));
  assert(!history.textContent!.includes('notes.md'));
  assert.equal(f.calls.length, 0);
  await click('卸载或停用 Skill');
  assert.equal(host.querySelector('select')!.value, '');
  assert(button('预览本次影响').disabled);
  await extent('runtime'); await click('预览本次影响');
  assert.deepEqual(f.calls.map(call => call.command), ['preview_skill_remove']);
  await f.render({ revision: 2, lastRemoval: { status: 'partial', result: { deleted: [path], failures: [['D:/synthetic/skill/locked.py', '正在使用']] } } });
  assert(host.textContent!.includes('上次卸载部分完成'));
  assert(host.textContent!.includes('正在使用'));
  assert.equal(f.calls.length, 1);
});
