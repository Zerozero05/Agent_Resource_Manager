import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import type { SkillBackupPlan } from '../src/BackupPlanConsent.tsx';

const source = new URL('../src/BackupPlanConsent.tsx', import.meta.url);
let code = ts.transpileModule(await readFile(source, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, name: string) => `from ${JSON.stringify(import.meta.resolve(name))}`);
const { BackupPlanConsent, useBackupConsent } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const host = document.getElementById('root')!;
let unmount = () => {};
afterEach(async () => { await act(async () => unmount()); unmount = () => {}; });

const plan: SkillBackupPlan = {
  id: 'backup-one', required: true, sourceRoot: 'D:\\fixtures\\skill', recoveryRoot: 'D:\\fixtures\\data\\recovery',
  destination: 'D:\\fixtures\\data\\recovery\\backup-one\\before', method: 'copy-existing-files',
  fileCount: 1, totalBytes: 12, summary: '将复制需替换的原文件。',
  files: [{ relativePath: 'SKILL.md', sourcePath: 'D:\\fixtures\\skill\\SKILL.md', destinationPath: 'D:\\fixtures\\data\\recovery\\backup-one\\before\\SKILL.md', sha256: 'a'.repeat(64), bytes: 12 }],
};
type Preview = { id: string; backupPlan?: SkillBackupPlan };
let consent: ReturnType<typeof useBackupConsent>;
function Harness({ preview, owned = true, disabled = false }: { preview: Preview; owned?: boolean; disabled?: boolean }) {
  consent = useBackupConsent(preview, owned);
  return createElement(BackupPlanConsent, { plan: preview.backupPlan, checked: consent.checked, disabled: disabled || !owned, onChange: consent.change });
}
function mount() { const root = createRoot(host); unmount = () => root.unmount(); return root; }
async function choose() { await act(async () => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click()); }

test('existing-file backup begins unapproved and displays exact objects, destination and method', async () => {
  const root = mount();
  await act(async () => root.render(createElement(Harness, { preview: { id: 'preview-one', backupPlan: plan } })));
  assert.equal(consent.allowed, false);
  assert.deepEqual(consent.request, {});
  assert.equal(host.querySelector<HTMLInputElement>('input')!.checked, false);
  assert(host.textContent!.includes(plan.sourceRoot));
  assert(host.textContent!.includes(plan.destination));
  assert(host.textContent!.includes(plan.files[0].sourcePath));
  assert(host.textContent!.includes(plan.files[0].destinationPath));
  assert(host.textContent!.includes('逐项复制'));
  await choose();
  assert.equal(consent.allowed, true);
  assert.deepEqual(consent.request, { backupPlanId: plan.id });
  await choose();
  assert.equal(consent.allowed, false);
  assert.deepEqual(consent.request, {});
});

test('changing preview, transferring ownership and explicit submission reset backup permission', async () => {
  const root = mount();
  const first = { id: 'preview-one', backupPlan: plan };
  await act(async () => root.render(createElement(Harness, { preview: first })));
  await choose();
  const refreshed = { ...first };
  await act(async () => root.render(createElement(Harness, { preview: refreshed })));
  assert.equal(consent.allowed, false, 'even the same preview id cannot carry permission into a newly loaded object');
  await choose();
  await act(async () => root.render(createElement(Harness, { preview: refreshed, owned: false })));
  assert.equal(consent.allowed, false);
  assert.deepEqual(consent.request, {});
  await act(async () => root.render(createElement(Harness, { preview: refreshed, owned: true })));
  assert.equal(consent.allowed, false, 'returned ownership does not restore an earlier permission');
  await choose();
  await act(async () => consent.reset());
  assert.equal(consent.allowed, false);
  assert.deepEqual(consent.request, {});
});

test('new-file-only plans and unrelated previews do not ask for or send backup permission', async () => {
  const root = mount();
  await act(async () => root.render(createElement(Harness, { preview: { id: 'install', backupPlan: { ...plan, required: false, files: [], fileCount: 0, totalBytes: 0 } } })));
  assert.equal(consent.allowed, true);
  assert.deepEqual(consent.request, {});
  assert.equal(host.querySelector('input'), null);
  await act(async () => root.render(createElement(Harness, { preview: { id: 'upload' } })));
  assert.equal(consent.allowed, true);
  assert.deepEqual(consent.request, {});
  assert.equal(host.querySelector('input'), null);
});

test('busy or unowned preview cannot check the permission control', async () => {
  const root = mount();
  const preview = { id: 'preview-one', backupPlan: plan };
  await act(async () => root.render(createElement(Harness, { preview, disabled: true })));
  await choose();
  assert.equal(consent.allowed, false);
  await act(async () => root.render(createElement(Harness, { preview, owned: false })));
  await choose();
  assert.equal(consent.allowed, false);
});
