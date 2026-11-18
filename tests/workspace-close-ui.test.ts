import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { createElement, act } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import type { WindowWorkspace, WorkspacePane } from '../src/workspace.ts';

// Exercise WorkspaceApp's real close handshake; only native IPC and unrelated panes are replaced.
const data = (code: string) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const native = data('export const invoke=(command,args)=>globalThis.workspaceCloseTest.invoke(command,args); export const isTauri=()=>true; export const listen=(name,callback)=>globalThis.workspaceCloseTest.listen(name,callback); export const getCurrentWindow=()=>globalThis.workspaceCloseTest.window;');
const taskStub = data('export const useTasks=()=>globalThis.workspaceCloseTest.tasks; export const terminalTask=()=>false;');
const shellStub = data(`import {createElement} from ${JSON.stringify(import.meta.resolve('react'))}; export const WorkspaceShell=props=>{globalThis.workspaceCloseTest.panes=props.panes;return createElement('div',null,createElement('button',{onClick:props.onShowHelp},'帮助'),props.onToggleSidebar&&createElement('button',{'aria-label':props.sidebarExpanded?'收起侧栏':'展开侧栏','aria-expanded':props.sidebarExpanded,disabled:props.shortcutsBlocked,onClick:props.onToggleSidebar},'侧栏'),...props.panes.map(pane=>{const node=props.renderPane(pane,true,true); globalThis.workspaceCloseTest.session=node.props.value; return node;}));};`);
const emptyPane = data('export default function SessionApp(){return null}');
const emptyControl = data('export function CheckControl(){return null}');
const modules = new Map<string, Promise<string>>();
async function moduleURL(url: URL): Promise<string> {
  const previous = modules.get(url.href); if (previous) return previous;
  const pending = (async () => {
    let code = ts.transpileModule(await readFile(url, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText.replace(/import\s+['"][^'"]+\.css['"];?/g, '');
    const replacements = new Map<string, string>();
    for (const match of code.matchAll(/from\s+(['"])([^'"]+)\1/g)) {
      const name = match[2]; if (replacements.has(name)) continue;
      if (name.startsWith('@tauri-apps/api/')) replacements.set(name, native);
      else if (url.pathname.endsWith('/WorkspaceApp.tsx') && name === './tasks') replacements.set(name, taskStub);
      else if (name === './App') replacements.set(name, emptyPane);
      else if (name === './WorkspaceShell') replacements.set(name, shellStub);
      else if (name === './CheckControl') replacements.set(name, emptyControl);
      else if (!name.startsWith('.')) replacements.set(name, import.meta.resolve(name));
      else {
        let found: URL | undefined;
        for (const suffix of ['.ts', '.tsx']) { const candidate = new URL(name + suffix, url); try { await access(candidate); found = candidate; break; } catch {} }
        assert(found, `unresolved ${name}`); replacements.set(name, await moduleURL(found));
      }
    }
    code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, name) => `from ${JSON.stringify(replacements.get(name))}`);
    return data(code);
  })(); modules.set(url.href, pending); return pending;
}
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const { default: WorkspaceApp } = await import(await moduleURL(new URL('../src/WorkspaceApp.tsx', import.meta.url)));
const host = document.getElementById('root')!;
let unmount = () => {};
let restoreClock = () => {};
afterEach(async () => { await act(async () => unmount()); unmount = () => {}; restoreClock(); restoreClock = () => {}; });
async function mount(failSave = false, options: { snapshot?: Record<string, unknown>; workspace?: WindowWorkspace; basicMode?: boolean; readPaneRuntime?: (paneId: string) => Record<string, unknown>; taskResult?: (attempt: number) => { snapshot?: Record<string, unknown>; error?: string } } = {}) {
  const calls: Record<string, unknown>[] = [], listeners = new Map<string, (event: unknown) => void>();
  const taskCalls: { action: string; args: Record<string, unknown>; foreground: boolean }[] = [];
  const readReplies: (() => Promise<unknown> | unknown)[] = [];
  let managerSnapshot = options.snapshot || { skills: [], sources: [], connections: [], settings: {}, stateRevision: 1 };
  const workspace = { revision: 1, windows: [options.workspace || { label: 'main', activePaneId: 'home', panes: [{ id: 'home', kind: 'home', state: {} }] }] };
  const reply = { windowLabel: 'main', workspace, closing: false, nativeCloseRequested: false };
  let destroyed = 0;
  const fixture = {
    panes: [] as WorkspacePane[],
    session: undefined as unknown as { pane: WorkspacePane; requestStorageRestart: (id: string) => Promise<void>; managerSnapshot: { stateRevision?: number; settings?: { marker?: string }; maintenance?: { automaticAllowed?: boolean } }; acceptSnapshot: (snapshot: unknown) => void },
    tasks: { tasks: [], run: async (_label: string, action: string, args: Record<string, unknown>, _origin: unknown, foreground: boolean) => {
      if (!options.snapshot) throw new Error('Window closure must not run a resource task');
      taskCalls.push({ action, args, foreground });
      const result = options.taskResult?.(taskCalls.length);
      if (result?.snapshot) managerSnapshot = result.snapshot;
      if (result?.error) throw new Error(result.error);
      return managerSnapshot;
    } },
    window: { label: 'main', onCloseRequested: async (callback: (event: unknown) => void) => { listeners.set('native-close', callback); return () => listeners.delete('native-close'); }, setTheme: async () => {}, scaleFactor: async () => 1, outerPosition: async () => ({ x: 0, y: 0 }), innerSize: async () => ({ width: 1280, height: 850 }), isMaximized: async () => false, destroy: async () => { destroyed++; } },
    listen: async (name: string, callback: (event: unknown) => void) => { listeners.set(name, callback); return () => listeners.delete(name); },
    invoke: async (command: string, args: { request: Record<string, unknown> }) => {
      assert.equal(command, 'manager_request'); const request = args.request; calls.push(request);
      switch (request.action) {
        case 'get_state': return readReplies.length ? readReplies.shift()!() : managerSnapshot;
        case 'workspace_get_pane_runtime': return { runtime: options.readPaneRuntime?.(String(request.paneId)) ?? {} };
        case 'workspace_save': if (failSave) throw new Error('synthetic save failure'); return reply;
        case 'workspace_close_intent': return { final: true, closeId: 'fixed-close' };
        case 'workspace_finish_close': return { ready: true };
        default: return reply;
      }
    },
  };
  Object.assign(globalThis, { workspaceCloseTest: fixture });
  const root = createRoot(host); unmount = () => root.unmount();
  await act(async () => root.render(createElement(WorkspaceApp, { startup: { basicMode: options.basicMode || false } })));
  assert(calls.some(call => call.action === 'workspace_ready'));
  return { calls, taskCalls, listeners, queueRead: (read: () => Promise<unknown> | unknown) => readReplies.push(read), setSnapshot: (next: Record<string, unknown>) => { managerSnapshot = next; }, updateSnapshot: (next: Record<string, unknown>) => {
    managerSnapshot = next; listeners.get('state-changed')?.({ payload: { stateRevision: next.stateRevision } });
  }, destroyed: () => destroyed, session: () => fixture.session, panes: () => fixture.panes, nativeClose: () => {
    reply.nativeCloseRequested = true;
    let prevented = false;
    listeners.get('native-close')?.({ preventDefault: () => { prevented = true; } });
    assert(prevented);
  } };
}
const button = (text: string) => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(node => node.textContent === text)!;
const click = async (node: Element) => act(async () => { node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });

test('home sidebar registration reaches the outer toolbar without changing saved navigation or business bridges', async () => {
  const fixture = await mount(); const before = fixture.calls.length;
  const register = (fixture.session() as unknown as { register: (id: string, bridge: unknown) => () => void }).register;
  let toggled = 0, firstDispose!: () => void, nextDispose!: () => void, businessDispose!: () => void;
  await act(async () => { firstDispose = register('home', { capture: () => ({}), flush: async () => true, sidebar: { expanded: true, toggle: () => toggled++ } }); });
  const toolbar = () => host.querySelector<HTMLButtonElement>('[aria-label$="侧栏"]');
  assert.equal(toolbar()?.getAttribute('aria-expanded'), 'true'); await click(toolbar()!); assert.equal(toggled, 1);
  await act(async () => { nextDispose = register('home', { capture: () => ({}), flush: async () => true, sidebar: { expanded: false, toggle: () => toggled++ } }); businessDispose = register('business', { capture: () => ({}), flush: async () => true }); firstDispose(); });
  assert.equal(toolbar()?.getAttribute('aria-expanded'), 'false'); await click(toolbar()!); assert.equal(toggled, 2);
  await act(async () => businessDispose()); assert(toolbar()); await act(async () => nextDispose()); assert.equal(toolbar(), null);
  assert.equal(fixture.calls.length, before); assert.equal(fixture.taskCalls.length, 0);
});

test('restored detail labels follow current Skill and cached alias without changing pane identity or saving navigation', async () => {
  const { managementDataCache } = await import(await moduleURL(new URL('../src/management-data.ts', import.meta.url)));
  const detail: WorkspacePane = { id: 'detail', skillId: 'renamed-skill', kind: 'detail', title: 'Old display', state: { section: 'files', scrollTop: 240 } };
  const operation: WorkspacePane = { id: 'upload', skillId: detail.skillId, kind: 'operation', title: 'Review upload', state: { operation: 'preview' } };
  const workspace: WindowWorkspace = { label: 'main', activePaneId: detail.id, panes: [{ id: 'home', kind: 'home', state: {} }, operation, detail] };
  const snapshot = (stateRevision: number, displayName?: string) => ({ stateRevision, sources: [], connections: [], settings: {}, skills: displayName ? [{ id: detail.skillId, name: 'same-skill', displayName }] : [] });
  const fixture = await mount(false, { workspace, snapshot: snapshot(1) });
  assert.equal(fixture.panes().at(-1), detail, 'keep the saved label while the current skill is unavailable');
  const before = fixture.calls.length;
  await act(async () => fixture.updateSnapshot(snapshot(2, 'New display')));
  assert.deepEqual(fixture.panes().at(-1), { ...detail, title: 'New display' });
  assert.equal(fixture.session().pane, fixture.panes().at(-1), 'active detail receives the same current label for its toolbar');
  assert.equal(fixture.panes()[1], operation, 'the operation keeps its independent title');
  await act(async () => managementDataCache.accept({ revision: 1, skillAnnotations: [{ skillId: detail.skillId, revision: 1, alias: 'Personal name', notes: '' }], savedViews: [] }));
  assert.deepEqual(fixture.panes().at(-1), { ...detail, title: 'Personal name' });
  await act(async () => managementDataCache.accept({ revision: 2, skillAnnotations: [], savedViews: [] }));
  assert.deepEqual(fixture.panes().at(-1), { ...detail, title: 'New display' });
  assert.equal(detail.title, 'Old display', 'the restored navigation record is untouched');
  assert.deepEqual(fixture.calls.slice(before), [{ action: 'get_state' }]);
  assert.deepEqual(fixture.taskCalls, []);
});

test('a failed pane read does not prevent another pane in the same snapshot from restoring on retry', async () => {
  let failSecondRead = true;
  const firstPane: WorkspacePane = { id: 'detail-first', skillId: 'first', kind: 'detail', state: {} };
  const secondPane: WorkspacePane = { id: 'detail-second', skillId: 'second', kind: 'detail', state: {} };
  const fixture = await mount(false, { readPaneRuntime: id => {
    if (id === secondPane.id && failSecondRead) throw new Error('synthetic unavailable pane draft');
    return id === firstPane.id ? { scrollTop: 177 } : {};
  } });
  const workspace = { revision: 2, windows: [{ label: 'main', activePaneId: firstPane.id,
    panes: [...fixture.panes(), firstPane, secondPane] }] };
  const publish = () => fixture.listeners.get('workspace-changed')!({ payload: workspace });
  const callStart = fixture.calls.length;
  await act(async () => publish());
  assert.deepEqual(fixture.panes().map(pane => pane.id), ['home']);
  assert.match(host.textContent || '', /synthetic unavailable pane draft/);

  failSecondRead = false;
  await act(async () => publish());
  assert.deepEqual(fixture.panes().map(pane => pane.id), ['home', firstPane.id, secondPane.id]);
  assert.doesNotMatch(host.textContent || '', /正在恢复页面/);
  assert.deepEqual(fixture.calls.slice(callStart).map(call => [call.action, call.paneId]),
    [firstPane.id, secondPane.id, firstPane.id, secondPane.id].map(id => ['workspace_get_pane_runtime', id]));
});

test('state events share one in-flight read and preserve a subsequent snapshot after a burst', async () => {
  const fixture = await mount();
  let deliverFirst!: (value: unknown) => void, deliverLatest!: (value: unknown) => void;
  const first = new Promise(resolve => { deliverFirst = resolve; });
  const latest = new Promise(resolve => { deliverLatest = resolve; });
  let inFlight = 0, maximumInFlight = 0;
  const track = (pending: Promise<unknown>) => () => {
    inFlight++; maximumInFlight = Math.max(maximumInFlight, inFlight);
    return pending.finally(() => { inFlight--; });
  };
  fixture.queueRead(track(first)); fixture.queueRead(track(latest));
  const snapshot = (revision: number, marker: string) => ({ skills: [], sources: [], connections: [], settings: { marker }, stateRevision: revision });
  const before = fixture.calls.filter(call => call.action === 'get_state').length;
  try {
    await act(async () => fixture.updateSnapshot(snapshot(2, 'first')));
    await act(async () => { for (let revision = 3; revision <= 13; revision++) fixture.updateSnapshot(snapshot(revision, `latest-${revision}`)); });
    assert.equal(fixture.calls.filter(call => call.action === 'get_state').length - before, 1);
    assert.equal(maximumInFlight, 1, 'new events must not launch concurrent complete state reads');
    await act(async () => deliverFirst(snapshot(2, 'first')));
    assert.equal(fixture.calls.filter(call => call.action === 'get_state').length - before, 2, 'one follow-up must read changes that occurred during the old request');
    assert.equal(fixture.session().managerSnapshot.stateRevision, 2);
    await act(async () => deliverLatest(snapshot(13, 'latest-13')));
    assert.equal(fixture.session().managerSnapshot.stateRevision, 13);
    assert.equal(fixture.session().managerSnapshot.settings?.marker, 'latest-13');
    assert.equal(maximumInFlight, 1);
    assert.equal(inFlight, 0);
    assert.equal(fixture.calls.filter(call => call.action === 'get_state').length - before, 2);
  } finally {
    await act(async () => { deliverFirst(snapshot(2, 'first')); deliverLatest(snapshot(13, 'latest-13')); });
  }
});

test('events arriving during the follow-up retain only one more read and adopt its actual latest state', async () => {
  const fixture = await mount();
  let deliverFirst!: (value: unknown) => void, deliverFollowUp!: (value: unknown) => void;
  const first = new Promise(resolve => { deliverFirst = resolve; });
  const followUp = new Promise(resolve => { deliverFollowUp = resolve; });
  fixture.queueRead(() => first); fixture.queueRead(() => followUp);
  const snapshot = (revision: number) => ({ skills: [], sources: [], connections: [], settings: { marker: `revision-${revision}` }, stateRevision: revision });
  const before = fixture.calls.filter(call => call.action === 'get_state').length;
  await act(async () => { fixture.updateSnapshot(snapshot(2)); fixture.updateSnapshot(snapshot(3)); });
  await act(async () => deliverFirst(snapshot(2)));
  assert.equal(fixture.calls.filter(call => call.action === 'get_state').length - before, 2);
  await act(async () => { fixture.updateSnapshot(snapshot(4)); fixture.updateSnapshot(snapshot(5)); });
  assert.equal(fixture.calls.filter(call => call.action === 'get_state').length - before, 2);
  await act(async () => deliverFollowUp(snapshot(3)));
  assert.equal(fixture.calls.filter(call => call.action === 'get_state').length - before, 3);
  assert.equal(fixture.session().managerSnapshot.stateRevision, 5);
  assert.equal(fixture.session().managerSnapshot.settings?.marker, 'revision-5');
});

test('state notifications at read completion always observe the latest snapshot', async () => {
  const snapshot = (revision: number) => ({ skills: [], sources: [], connections: [], settings: { marker: `revision-${revision}` }, stateRevision: revision });
  for (let depth = 0; depth <= 12; depth++) {
    const fixture = await mount();
    let deliver!: (value: unknown) => void;
    const pending = new Promise(resolve => { deliver = resolve; });
    let inFlight = 0, maximumInFlight = 0;
    const track = (read: Promise<unknown>) => () => {
      inFlight++; maximumInFlight = Math.max(maximumInFlight, inFlight);
      return read.finally(() => { inFlight--; });
    };
    fixture.queueRead(track(pending)); fixture.queueRead(track(Promise.resolve(snapshot(3))));
    const before = fixture.calls.filter(call => call.action === 'get_state').length;
    try {
      await act(async () => fixture.updateSnapshot(snapshot(2)));
      await act(async () => {
        deliver(snapshot(2));
        // Exercise each promise boundary around transport delivery and worker cleanup.
        for (let step = 0; step < depth; step++) await Promise.resolve();
        fixture.updateSnapshot(snapshot(3));
      });
      assert.equal(fixture.session().managerSnapshot.stateRevision, 3, `microtask depth ${depth}`);
      assert.equal(fixture.session().managerSnapshot.settings?.marker, 'revision-3');
      assert.equal(fixture.calls.filter(call => call.action === 'get_state').length - before, 2);
      assert.equal(maximumInFlight, 1);
      assert.equal(inFlight, 0);
    } finally {
      await act(async () => { deliver(snapshot(2)); unmount(); }); unmount = () => {};
    }
  }
});

test('a failed shared read clears its pending state and a later event can read the latest snapshot', async () => {
  const fixture = await mount();
  let fail!: (cause: Error) => void;
  const pending = new Promise((_resolve, reject) => { fail = reject; });
  fixture.queueRead(() => pending);
  const snapshot = (revision: number) => ({ skills: [], sources: [], connections: [], settings: { marker: `revision-${revision}` }, stateRevision: revision });
  const before = fixture.calls.filter(call => call.action === 'get_state').length;
  await act(async () => { fixture.updateSnapshot(snapshot(2)); fixture.updateSnapshot(snapshot(3)); });
  assert.equal(fixture.calls.filter(call => call.action === 'get_state').length - before, 1);
  await act(async () => fail(new Error('synthetic state read failure')));
  assert(host.textContent?.includes('synthetic state read failure'));
  assert.equal(fixture.session().managerSnapshot.stateRevision, 1);
  assert.equal(fixture.calls.filter(call => call.action === 'get_state').length - before, 1, 'a failed read does not replay the queued request automatically');
  await act(async () => fixture.updateSnapshot(snapshot(4)));
  assert.equal(fixture.calls.filter(call => call.action === 'get_state').length - before, 2);
  assert.equal(fixture.session().managerSnapshot.stateRevision, 4);
  assert.equal(fixture.session().managerSnapshot.settings?.marker, 'revision-4');
});

test('a window leaving during a shared read ignores its late reply and starts no queued follow-up', async () => {
  const fixture = await mount();
  let deliver!: (value: unknown) => void;
  const pending = new Promise(resolve => { deliver = resolve; });
  fixture.queueRead(() => pending);
  const snapshot = (revision: number) => ({ skills: [], sources: [], connections: [], settings: {}, stateRevision: revision });
  const before = fixture.calls.filter(call => call.action === 'get_state').length;
  await act(async () => { fixture.updateSnapshot(snapshot(2)); fixture.updateSnapshot(snapshot(3)); });
  await act(async () => unmount()); unmount = () => {};
  await act(async () => deliver(snapshot(2)));
  assert.equal(fixture.calls.filter(call => call.action === 'get_state').length - before, 1);
  assert.equal(fixture.session().managerSnapshot.stateRevision, 1);
  assert.equal(host.childElementCount, 0);
});

test('closing all windows saves navigation and asks for UI closure without a backend shutdown', async () => {
  const fixture = await mount(); await click(button('帮助')); await click(button('关闭全部界面'));
  assert.deepEqual(fixture.calls.find(call => call.action === 'workspace_close_intent'), { action: 'workspace_close_intent', all: true, mode: 'windows' });
  assert.deepEqual(fixture.calls.find(call => call.action === 'workspace_finish_close'), { action: 'workspace_finish_close', closeId: 'fixed-close' });
  assert(host.textContent?.includes('后台任务继续运行'));
  assert.equal(fixture.destroyed(), 0, 'the owner must wait for the backend to close the final window');
  assert(!fixture.calls.some(call => call.action === 'prepare_close' || call.action === 'cancel_task'));
});

test('explicit quit and tray quit use the same saved close handshake', async () => {
  const fixture = await mount();
  await act(async () => fixture.listeners.get('workspace-request-quit')?.({ payload: {} }));
  const intent = fixture.calls.find(call => call.action === 'workspace_close_intent');
  assert.deepEqual(intent, { action: 'workspace_close_intent', all: true, mode: 'quit' });
  assert(fixture.calls.findIndex(call => call.action === 'workspace_save') < fixture.calls.indexOf(intent!));
  assert(host.textContent?.includes('然后完全退出'));
});

test('native window close retains its current-window gesture and uses background UI closure', async () => {
  const fixture = await mount();
  await act(async () => fixture.nativeClose());
  assert.deepEqual(fixture.calls.find(call => call.action === 'workspace_close_intent'), { action: 'workspace_close_intent', all: false, mode: 'windows' });
  assert(fixture.calls.some(call => call.action === 'workspace_finish_close'));
});

test('storage restart binds its preview at the initial intent and cannot change it on finish', async () => {
  const fixture = await mount();
  await act(async () => fixture.session().requestStorageRestart('fixed-storage-preview'));
  assert.deepEqual(fixture.calls.find(call => call.action === 'workspace_close_intent'), { action: 'workspace_close_intent', all: true, mode: 'migration', storagePreviewId: 'fixed-storage-preview' });
  assert.deepEqual(fixture.calls.find(call => call.action === 'workspace_finish_close'), { action: 'workspace_finish_close', closeId: 'fixed-close' });
});

test('failed navigation save keeps the window open and never starts a quit intent', async () => {
  const fixture = await mount(true); await click(button('帮助')); await click(button('完全退出管理器'));
  assert(!fixture.calls.some(call => call.action === 'workspace_close_intent' || call.action === 'workspace_finish_close'));
  assert.equal(fixture.destroyed(), 0);
  assert(host.querySelector('[role="alert"]')?.textContent?.includes('synthetic save failure'));
  assert.deepEqual(fixture.calls.find(call => call.action === 'workspace_cancel_close'), { action: 'workspace_cancel_close', nativeOnly: true });
  assert(!host.querySelector('.workspace-is-closing'));
});

const repairSnapshot = (extra: Record<string, unknown> = {}) => ({
  skills: [], sources: [], settings: {}, stateRevision: 1, checkMode: 'auto', checkGeneration: 9,
  maintenance: { revision: 0, valid: true, pausedManually: false, pauseUntil: null, window: null, automaticAllowed: true, reason: '' },
  connections: [{ id: 'owned-entry', path: 'D:/synthetic/client', target: 'D:/synthetic/source', autoRepairable: true }],
  ...extra,
});

test('workspace automatic client repair carries automatic policy and the current check generation', async () => {
  const fixture = await mount(false, { snapshot: repairSnapshot() });
  assert.deepEqual(fixture.taskCalls, [{ action: 'repair_client_connections',
    args: { connectionIds: ['owned-entry'], automatic: true, checkGeneration: 9 }, foreground: false }]);
});

for (const [name, extra, basicMode] of [
  ['pause', { maintenance: { automaticAllowed: false, pausedManually: true } }, false],
  ['outside window', { maintenance: { automaticAllowed: false, reason: 'outside window' } }, false],
  ['manual check mode', { checkMode: 'manual' }, false],
  ['basic mode', {}, true],
  ['missing policy', { maintenance: undefined }, false],
] as const) {
  test(`workspace does not auto repair in ${name}`, async () => {
    const fixture = await mount(false, { snapshot: repairSnapshot(extra), basicMode });
    assert.deepEqual(fixture.taskCalls, []);
  });
}

test('resuming maintenance allows the previously suppressed client repair', async () => {
  const fixture = await mount(false, { snapshot: repairSnapshot({ maintenance: { automaticAllowed: false } }) });
  assert.deepEqual(fixture.taskCalls, []);
  await act(async () => fixture.updateSnapshot(repairSnapshot({ stateRevision: 2, checkGeneration: 10 })));
  assert.equal(fixture.taskCalls.length, 1);
  assert.equal(fixture.taskCalls[0].args.checkGeneration, 10);
});

function clock(start: number) {
  let now = start, monotonic = start, id = 0;
  const timers = new Map<number, { at: number; due: number; fire: () => void }>();
  const realNow = Date.now, realSet = window.setTimeout, realClear = window.clearTimeout;
  const performanceDescriptor = Object.getOwnPropertyDescriptor(window.performance, 'now');
  const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden');
  Date.now = () => now;
  Object.defineProperty(window.performance, 'now', { configurable: true, value: () => monotonic });
  window.setTimeout = ((handler: TimerHandler, delay = 0) => {
    assert.equal(typeof handler, 'function'); const next = ++id;
    timers.set(next, { at: now + delay, due: monotonic + delay, fire: handler as () => void }); return next;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((timer: number) => { timers.delete(timer); }) as typeof window.clearTimeout;
  const fireDue = async () => { const due = [...timers].filter(([, timer]) => timer.due <= monotonic); await act(async () => { for (const [key, timer] of due) { if (!timers.has(key)) continue; timers.delete(key); timer.fire(); } }); };
  restoreClock = () => { Date.now = realNow; window.setTimeout = realSet; window.clearTimeout = realClear; if (performanceDescriptor) Object.defineProperty(window.performance, 'now', performanceDescriptor); else delete (window.performance as unknown as { now?: () => number }).now; if (hiddenDescriptor) Object.defineProperty(document, 'hidden', hiddenDescriptor); else delete (document as unknown as { hidden?: boolean }).hidden; };
  return { timers, jump: (time: number) => { now = time; }, advance: async (time: number) => { monotonic += time - now; now = time; await fireDue(); },
    elapse: async (duration: number) => { monotonic += duration; now += duration; await fireDue(); },
    visibility: async (hidden: boolean) => act(async () => { Object.defineProperty(document, 'hidden', { configurable: true, value: hidden }); document.dispatchEvent(new dom.window.Event('visibilitychange')); }),
  };
}

test('timed pause expires with a single read and accepts changed policy at the same state revision', async () => {
  const start = new Date(2026, 9, 28, 9).getTime(), until = start + 60_000, time = clock(start);
  const policy = { ...repairSnapshot().maintenance, pauseUntil: new Date(until).toISOString() };
  const fixture = await mount(false, { snapshot: repairSnapshot({ maintenance: { ...policy, automaticAllowed: false } }) });
  assert.equal(fixture.taskCalls.length, 0); assert.equal(time.timers.size, 2);
  const before = fixture.calls.length;
  fixture.setSnapshot(repairSnapshot({ maintenance: { ...policy, automaticAllowed: true } }));
  await time.advance(until);
  assert.equal(fixture.taskCalls.length, 1);
  assert.deepEqual(fixture.calls.slice(before), [{ action: 'get_state' }]);
  assert.equal(time.timers.size, 1, 'the expired timestamp remains sensitive to an independent clock rollback');
});

test('daily midnight-crossing windows refresh only at their boundaries without state writes', async () => {
  const start = new Date(2026, 9, 28, 22, 59).getTime(), time = clock(start);
  const policy = { ...repairSnapshot().maintenance, window: { startMinute: 23 * 60, endMinute: 60 } };
  const fixture = await mount(false, { snapshot: repairSnapshot({ maintenance: { ...policy, automaticAllowed: false } }) });
  const before = fixture.calls.length;
  fixture.setSnapshot(repairSnapshot({ maintenance: { ...policy, automaticAllowed: true } }));
  await time.advance(new Date(2026, 9, 28, 23).getTime());
  assert.equal(fixture.taskCalls.length, 1);
  fixture.setSnapshot(repairSnapshot({ maintenance: { ...policy, automaticAllowed: false } }));
  await time.advance(new Date(2026, 9, 29, 1).getTime());
  assert.equal(fixture.taskCalls.length, 1);
  fixture.setSnapshot(repairSnapshot({ maintenance: { ...policy, automaticAllowed: true } }));
  await time.advance(new Date(2026, 9, 29, 23).getTime());
  assert.equal(fixture.taskCalls.length, 2);
  assert.deepEqual(fixture.calls.slice(before), Array.from({ length: 3 }, () => ({ action: 'get_state' })));
  assert.equal(time.timers.size, 2);
});

test('a live policy rejection does not throttle repair after the timed pause expires', async () => {
  const start = new Date(2026, 9, 28, 9).getTime(), until = start + 60_000, time = clock(start);
  const policy = { ...repairSnapshot().maintenance, pauseUntil: new Date(until).toISOString() };
  const fixture = await mount(false, { snapshot: repairSnapshot(), taskResult: attempt => attempt === 1
    ? { snapshot: repairSnapshot({ maintenance: { ...policy, automaticAllowed: false } }), error: '自动维护仍在定时暂停期间' }
    : {} });
  assert.equal(fixture.taskCalls.length, 1); assert.equal(time.timers.size, 2);
  fixture.setSnapshot(repairSnapshot({ maintenance: { ...policy, automaticAllowed: true } }));
  await time.advance(until);
  assert.equal(fixture.taskCalls.length, 2, 'one minute later must not be blocked by the normal thirty-minute attempt throttle');
  assert.equal(host.querySelector('[role="alert"]'), null);
});

test('a pause snapshot first received after its deadline is rechecked without waiting for another event', async () => {
  const start = new Date(2026, 9, 28, 9).getTime(), until = start + 60_000, time = clock(start);
  const policy = { ...repairSnapshot().maintenance, pauseUntil: new Date(until).toISOString() };
  const fixture = await mount(false, { snapshot: repairSnapshot({ maintenance: undefined }) });
  time.jump(until + 1);
  fixture.setSnapshot(repairSnapshot({ maintenance: policy }));
  const before = fixture.calls.length;
  await act(async () => fixture.session().acceptSnapshot(repairSnapshot({ maintenance: { ...policy, automaticAllowed: false } })));
  assert.deepEqual(fixture.calls.slice(before), [{ action: 'get_state' }]);
  assert.equal(fixture.taskCalls.length, 1);
  assert.equal(fixture.session().managerSnapshot.maintenance?.automaticAllowed, true);
  assert.equal(time.timers.size, 1);
});

test('a pre-deadline read arriving after expiry cannot replace a newer allowed snapshot', async () => {
  const start = new Date(2026, 9, 28, 9).getTime(), until = start + 60_000, time = clock(start);
  const policy = { ...repairSnapshot().maintenance, pauseUntil: new Date(until).toISOString() };
  const fixture = await mount(false, { snapshot: repairSnapshot({ maintenance: { ...policy, automaticAllowed: false } }) });
  let deliver!: (value: unknown) => void;
  const pending = new Promise(resolve => { deliver = resolve; });
  fixture.queueRead(() => pending);
  await act(async () => fixture.listeners.get('read-context-changed')?.({ payload: {} }));
  time.jump(until + 1);
  fixture.setSnapshot(repairSnapshot({ maintenance: policy }));
  await act(async () => fixture.session().acceptSnapshot(repairSnapshot({ maintenance: policy })));
  assert.equal(fixture.session().managerSnapshot.maintenance?.automaticAllowed, true);
  const before = fixture.calls.length;
  await act(async () => deliver(repairSnapshot({ maintenance: { ...policy, automaticAllowed: false } })));
  assert.deepEqual(fixture.calls.slice(before), [{ action: 'get_state' }]);
  assert.equal(fixture.session().managerSnapshot.maintenance?.automaticAllowed, true);
  assert.equal(fixture.taskCalls.length, 1);
  assert.equal(time.timers.size, 1);
});

test('persistently stale clock responses stop after one extra read instead of looping', async () => {
  const now = new Date(2026, 9, 28, 9).getTime(), time = clock(now);
  const stale = repairSnapshot({ maintenance: { ...repairSnapshot().maintenance, pauseUntil: new Date(now - 1).toISOString(), automaticAllowed: false } });
  const fixture = await mount(false, { snapshot: repairSnapshot({ maintenance: undefined }) });
  fixture.setSnapshot(stale);
  const before = fixture.calls.length;
  await act(async () => fixture.session().acceptSnapshot(stale));
  assert.deepEqual(fixture.calls.slice(before), [{ action: 'get_state' }, { action: 'get_state' }]);
  assert.equal(fixture.taskCalls.length, 0);
  assert.equal(time.timers.size, 0);
});

for (const event of ['focus', 'visibilitychange']) {
  test(`${event} rearms a window boundary after a clock jump even when the snapshot is identical`, async () => {
    const start = new Date(2026, 9, 28, 9).getTime(), time = clock(start);
    const policy = { ...repairSnapshot().maintenance, window: { startMinute: 12 * 60, endMinute: 13 * 60 }, automaticAllowed: false };
    const fixture = await mount(false, { snapshot: repairSnapshot({ maintenance: policy }) });
    const timer = [...time.timers.keys()][0];
    time.jump(new Date(2026, 9, 28, 11).getTime());
    const before = fixture.calls.length;
    await act(async () => (event === 'focus' ? window : document).dispatchEvent(new dom.window.Event(event)));
    assert.equal(time.timers.size, 2);
    assert(!time.timers.has(timer), 'the old relative delay must be replaced even if the backend snapshot is unchanged');
    assert([...time.timers.values()].some(timer => timer.at === new Date(2026, 9, 28, 12).getTime()));
    assert.deepEqual(fixture.calls.slice(before).map(call => call.action), ['get_state', 'workspace_get', 'workspace_focus']);
    fixture.setSnapshot(repairSnapshot({ maintenance: { ...policy, automaticAllowed: true } }));
    await time.advance(new Date(2026, 9, 28, 12).getTime());
    assert.equal(fixture.taskCalls.length, 1);
  });
}

test('independent clock jumps reconcile live maintenance without waiting for a focus or state event', async () => {
  const start = new Date(2026, 9, 28, 9).getTime(), until = start + 3_600_000, time = clock(start);
  const policy = { ...repairSnapshot().maintenance, pauseUntil: new Date(until).toISOString() };
  const fixture = await mount(false, { snapshot: repairSnapshot({ maintenance: { ...policy, automaticAllowed: false } }) });
  const beforeQuiet = fixture.calls.length;
  await time.elapse(60_000);
  assert.equal(fixture.calls.length, beforeQuiet, 'an ordinary minute does not poll the backend');
  fixture.setSnapshot(repairSnapshot({ maintenance: { ...policy, automaticAllowed: true } }));
  time.jump(until + 30 * 60_000);
  const beforeForward = fixture.calls.length;
  await time.elapse(60_000);
  assert.deepEqual(fixture.calls.slice(beforeForward), [{ action: 'get_state' }]);
  assert.equal(fixture.session().managerSnapshot.maintenance?.automaticAllowed, true);
  assert.equal(fixture.taskCalls.length, 1);
  fixture.setSnapshot(repairSnapshot({ maintenance: { ...policy, automaticAllowed: false } }));
  time.jump(start + 15 * 60_000);
  const beforeBackward = fixture.calls.length;
  await time.elapse(60_000);
  assert.deepEqual(fixture.calls.slice(beforeBackward), [{ action: 'get_state' }]);
  assert.equal(fixture.session().managerSnapshot.maintenance?.automaticAllowed, false);
  assert.equal(fixture.taskCalls.length, 1, 'a clock rollback cannot dispatch a new repair under the restored pause');
  assert([...time.timers.values()].some(timer => timer.at === until));
});

test('time-zone changes and hidden-window restoration rearm maintenance without background clock polling', async () => {
  const originalZone = process.env.TZ;
  try {
    process.env.TZ = 'UTC';
    const start = Date.UTC(2026, 9, 28, 10, 30), time = clock(start);
    const policy = { ...repairSnapshot().maintenance, window: { startMinute: 600, endMinute: 660 } };
    const fixture = await mount(false, { snapshot: repairSnapshot({ maintenance: policy }) });
    fixture.setSnapshot(repairSnapshot({ maintenance: { ...policy, automaticAllowed: false } }));
    process.env.TZ = 'Etc/GMT+1';
    const beforeZone = fixture.calls.length;
    await time.elapse(60_000);
    assert.deepEqual(fixture.calls.slice(beforeZone), [{ action: 'get_state' }]);
    assert.equal(fixture.session().managerSnapshot.maintenance?.automaticAllowed, false);
    assert([...time.timers.values()].some(timer => timer.at === Date.UTC(2026, 9, 28, 11)));
    await time.visibility(true); assert.equal(time.timers.size, 0);
    const beforeHidden = fixture.calls.length;
    process.env.TZ = 'UTC'; await time.elapse(120_000);
    assert.equal(fixture.calls.length, beforeHidden);
    fixture.setSnapshot(repairSnapshot({ maintenance: policy }));
    await time.visibility(false);
    assert.equal(fixture.session().managerSnapshot.maintenance?.automaticAllowed, true);
    assert.equal(time.timers.size, 2);
    await act(async () => unmount()); unmount = () => {};
    assert.equal(time.timers.size, 0);
    await time.visibility(true); await time.visibility(false);
    assert.equal(time.timers.size, 0);
  } finally { if (originalZone === undefined) delete process.env.TZ; else process.env.TZ = originalZone; }
});
