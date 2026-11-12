import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
let code = ts.transpileModule(await readFile(new URL('../src/ConfigurationTransfer.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText.replace(/import\s+['"][^'"]+\.css['"];?/g, '');
code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, name: string) => `from ${JSON.stringify(import.meta.resolve(name))}`);
const { ConfigurationTransfer } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const host = document.getElementById('root')!;
let cleanup = () => {};
afterEach(async () => { await act(async () => cleanup()); cleanup = () => {}; });
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!;
const click = async (label: string) => act(async () => button(label).click());
const row = (key: string, status = 'new') => ({ key: `skill:${key}`, id: key, kind: 'skill', name: key, status, current: null, incoming: { name: key }, effect: '仅登记，保持停用' });
const preview = () => ({ previewId: 'preview', revision: 10, path: 'D:/selected.json', items: [row('new'), row('conflict', 'conflict'), { ...row('blocked', 'blocked'), reason: '本机来源不同' }, row('same', 'same')] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(handler: (command: string, args: any) => unknown = () => preview()) {
  const calls: { command: string; args: any }[] = [], imports: unknown[] = [], root = createRoot(host); cleanup = () => root.unmount();
  let importDialog = 0, exportDialog = 0;
  const props = { action: async (_label: string, command: string, args: any) => { calls.push({ command, args }); return handler(command, args); }, chooseImport: async () => { importDialog++; return 'D:/selected.json'; }, chooseExport: async () => { exportDialog++; return 'D:/chosen.json'; }, onImported: (state: unknown) => imports.push(state), revision: 10 };
  return { calls, imports, dialogs: () => ({ importDialog, exportDialog }), render: async (changes = {}) => act(async () => root.render(createElement(ConfigurationTransfer, { ...props, ...changes }))) };
}

test('configuration preview shows stable reference destinations and follows explicit subset selection', async () => {
  const value = preview();
  value.items[0] = { ...value.items[0], references: [
    { key: 'source:existing', kind: 'source', id: 'existing', status: 'local' },
    { key: 'skill:conflict', kind: 'skill', id: 'conflict', status: 'incoming' },
    { key: 'category:missing', kind: 'category', id: 'missing', status: 'unresolved' },
  ] } as any;
  const f = fixture(() => value); await f.render(); await click('选择配置文件');
  const description = () => host.querySelector('[aria-label="new的关联去向"]')!.textContent!;
  assert(description().includes('沿用本机记录')); assert(description().includes('需一并选择导入')); assert(description().includes('未找到对应记录'));
  await act(async () => host.querySelector<HTMLInputElement>('[aria-label="导入 conflict"]')!.click());
  assert(description().includes('随所选项目导入'));
  assert.equal(f.calls.length, 1);
});

test('configuration does no startup IO and import conflicts need explicit selection', async () => {
  const f = fixture((command) => command === 'apply_configuration_import' ? { applied: 2, state: { skills: [] } } : preview());
  await f.render(); assert.equal(f.calls.length, 0); assert.deepEqual(f.dialogs(), { importDialog: 0, exportDialog: 0 });
  await click('选择配置文件');
  const checkbox = (name: string) => host.querySelector<HTMLInputElement>(`[aria-label="导入 ${name}"]`)!;
  assert(checkbox('new').checked); assert(!checkbox('conflict').checked); assert(checkbox('blocked').disabled); assert(checkbox('same').disabled);
  await act(async () => checkbox('conflict').click()); await click('导入所选管理信息');
  assert.deepEqual(f.calls[1], { command: 'apply_configuration_import', args: { previewId: 'preview', selected: ['skill:new', 'skill:conflict'] } });
  assert.deepEqual(f.imports, [{ skills: [] }]); assert(host.textContent!.includes('已导入 2 项')); assert.equal(host.querySelector('.configuration-preview'), null);
});

test('failed import preserves choices and stale state blocks application without automatic retries', async () => {
  const f = fixture(command => { if (command === 'apply_configuration_import') throw new Error('原数据已保留'); return preview(); });
  await f.render(); await click('选择配置文件'); await click('导入所选管理信息'); assert(host.textContent!.includes('原数据已保留'));
  assert(host.querySelector<HTMLInputElement>('[aria-label="导入 new"]')!.checked); assert.equal(f.imports.length, 0);
  await f.render({ revision: 11 }); assert(button('导入所选管理信息').disabled); assert(host.textContent!.includes('管理信息已变化')); assert.equal(f.calls.length, 2);
});

test('export requires preview and a separately chosen destination, cancelled dialogs never write', async () => {
  const f = fixture(command => command === 'preview_configuration_export' ? { previewId: 'export', revision: 10, document: { formatVersion: 1, items: [{ kind: 'annotation', id: 'one', data: { notes: 'example' } }] } } : { path: 'D:/chosen.json' });
  await f.render({ chooseExport: async () => null }); await click('预览导出配置'); assert(host.querySelector('textarea')!.value.includes('example'));
  await click('选择位置并导出'); assert.equal(f.calls.length, 1);
  await f.render(); await click('选择位置并导出'); assert.deepEqual(f.calls[1], { command: 'export_configuration', args: { previewId: 'export', path: 'D:/chosen.json' } }); assert(host.textContent!.includes('配置已保存'));
});

test('Basic and hidden windows cannot transfer, duplicate requests are coalesced and hidden results ignored', async () => {
  const pending = deferred<ReturnType<typeof preview>>(); const f = fixture(() => pending.promise);
  await f.render({ readOnly: true }); assert(button('选择配置文件').disabled); await click('选择配置文件'); assert.equal(f.calls.length, 0);
  await f.render(); await act(async () => { button('选择配置文件').click(); button('选择配置文件').click(); }); assert.equal(f.calls.length, 1);
  await f.render({ visible: false }); await act(async () => pending.resolve(preview())); assert.equal(host.querySelector('.configuration-preview'), null); assert(button('预览导出配置').disabled);
});

test('large configuration previews render only one page while retaining full selection', async () => {
  const f = fixture(() => ({ ...preview(), items: Array.from({ length: 1100 }, (_, index) => row(`item-${index}`)) }));
  await f.render(); await click('选择配置文件'); assert.equal(host.querySelectorAll('.configuration-item').length, 50); assert(host.textContent!.includes('已选 1100 / 1100'));
  await click('下一页'); assert(host.querySelector('[aria-label="导入 item-50"]')); await click('取消选择'); assert(button('导入所选管理信息').disabled);
});
