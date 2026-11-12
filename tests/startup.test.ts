import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareStartup, type StartupStatus } from '../src/startup.ts';
import { observeMotion } from '../src/appearance.ts';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

test('basic mode is resolved before workspace mounting and does not alter saved appearance', async () => {
  const root = { dataset: { theme: 'eye', motion: 'light', accent: 'teal' } };
  let release!: (status: StartupStatus) => void;
  let mounted = false;
  const pending = prepareStartup(root as unknown as HTMLElement, () => new Promise(resolve => { release = resolve; })).then(status => {
    assert.equal((root.dataset as Record<string, string>).basicMode, 'true');
    assert.equal(root.dataset.motion, 'none');
    mounted = true;
    return status;
  });
  assert.equal(mounted, false);
  release({ basicMode: true, readOnly: true });
  await pending;
  assert.equal(root.dataset.theme, 'eye');
  assert.equal(root.dataset.accent, 'teal');
});

test('failed or invalid startup status never supplies an assumed normal mode', async () => {
  const root = { dataset: {} };
  await assert.rejects(prepareStartup(root as HTMLElement, async () => { throw new Error('unavailable'); }), /unavailable/);
  await assert.rejects(prepareStartup(root as HTMLElement, async () => ({}) as StartupStatus), /启动模式/);
  assert.deepEqual(root.dataset, {});
  await prepareStartup(root as HTMLElement, async () => ({ basicMode: false }));
  assert.deepEqual(root.dataset, { basicMode: 'false' });
});

test('basic startup keeps decorative motion off after saved preferences and focus events arrive', async () => {
  const root = { dataset: {} };
  await prepareStartup(root as HTMLElement, async () => ({ basicMode: true }));
  const media = Object.assign(new EventTarget(), { matches: false });
  const doc = Object.assign(new EventTarget(), { documentElement: root, hidden: false, hasFocus: () => true });
  const win = Object.assign(new EventTarget(), { matchMedia: () => media });
  const stop = observeMotion(doc as unknown as Document, win as unknown as Window, 'light');
  for (const target of [media, doc, win]) target.dispatchEvent(new Event(target === media ? 'change' : target === doc ? 'visibilitychange' : 'focus'));
  assert.equal((root.dataset as Record<string, string>).motion, 'none');
  stop();
});

// Execute the real entrypoint, replacing only its browser, bridge and module-loading boundaries.
const entrySource = ts.transpileModule(await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
}).outputText.replace(/^import .*;\r?$/gm, '')
  .replace(/import\(['"]\.\/WorkspaceApp['"]\)/g, 'loadWorkspace()')
  .replace('void start();', 'globalThis.completed = start();');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function entryHarness() {
  const status = deferred<StartupStatus>(), module = deferred<{ default: string }>();
  const calls: string[] = [], renders: { element: any; dataset: Record<string, string> }[] = [];
  const root = { dataset: {} as Record<string, string> };
  const context = {
    document: { documentElement: root, getElementById: () => ({}) },
    React: { StrictMode: 'strict', createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }) },
    ReactDOM: { createRoot: () => ({ render: (element: unknown) => renders.push({ element, dataset: { ...root.dataset } }) }) },
    prepareStartup,
    isTauri: () => true,
    invoke: (command: string, args: unknown) => {
      assert.equal(command, 'manager_request');
      assert.equal(JSON.stringify(args), JSON.stringify({ request: { action: 'get_startup_status' } }));
      calls.push('status'); return status.promise;
    },
    loadWorkspace: () => { calls.push('code'); return module.promise; },
    completed: undefined as Promise<void> | undefined,
  };
  runInNewContext(entrySource, context);
  return { status, module, calls, renders, completed: context.completed! };
}

for (const first of ['code', 'status'] as const) {
  test(`entry loads code alongside session status, with ${first} ready first`, async () => {
    const h = entryHarness();
    assert.deepEqual(h.calls, ['status', 'code']);
    const status = { basicMode: true, readOnly: true };
    if (first === 'code') h.module.resolve({ default: 'workspace' });
    else h.status.resolve(status);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(h.renders.length, 0, 'the workspace cannot mount with only one prerequisite ready');
    if (first === 'code') h.status.resolve(status);
    else h.module.resolve({ default: 'workspace' });
    await h.completed;
    assert.equal(h.renders.length, 1);
    assert.equal(h.renders[0].element.children[0].type, 'workspace');
    assert.equal(h.renders[0].element.children[0].props.startup, status);
    assert.deepEqual(h.renders[0].dataset, { basicMode: 'true', motion: 'none' });
  });
}

for (const failure of ['status', 'code'] as const) {
  test(`entry preserves startup failure when ${failure} fails and the other prerequisite finishes later`, async () => {
    const h = entryHarness();
    h[failure === 'code' ? 'module' : 'status'].reject(new Error(`${failure} unavailable`));
    await h.completed;
    assert.equal(h.renders.length, 1);
    assert.equal(h.renders[0].element.type, 'main');
    assert.equal(h.renders[0].element.props.role, 'alert');
    assert.match(JSON.stringify(h.renders[0].element), new RegExp(`${failure} unavailable`));
    if (failure === 'code') h.status.resolve({ basicMode: false });
    else h.module.resolve({ default: 'workspace' });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(h.renders.length, 1, 'late success must not replace the startup failure with a workspace');
  });
}
