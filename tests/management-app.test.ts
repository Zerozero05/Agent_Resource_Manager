import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createElement, act } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import type { LibraryItem } from '../src/library.ts';

// Load the real App and its components, replacing only native IPC. Fixture query strings
// isolate the window-scoped caches without adding a reset API to production code.
const sourceRoot = new URL('../src/', import.meta.url).href;
const packageURL = new URL('../package.json', import.meta.url).href;
const native = `data:text/javascript,${encodeURIComponent(`
  export const isTauri = () => true;
  export const invoke = (...args) => globalThis.managementAppTest.invoke(...args);
  export const listen = async (name, listener) => globalThis.managementAppTest.listen(name, listener);
  export const emit = async () => {};
  export const open = (...args) => globalThis.managementAppTest.native('open', args);
  export const save = (...args) => globalThis.managementAppTest.native('save', args);
  export const openUrl = (...args) => globalThis.managementAppTest.native('openUrl', args);
  export const openPath = (...args) => globalThis.managementAppTest.native('openPath', args);
`)}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@tauri-apps/')) return { url: native, shortCircuit: true };
    if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot)) {
      const target = new URL(specifier, context.parentURL);
      const exact = target.href;
      if (!existsSync(target)) {
        for (const suffix of ['.ts', '.tsx']) {
          const candidate = new URL(exact + suffix);
          if (existsSync(candidate)) { target.href = candidate.href; break; }
        }
      }
      target.search = new URL(context.parentURL).search;
      return { url: target.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot)) {
      const path = new URL(url); path.search = '';
      if (path.pathname.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
      if (/\.tsx?$/.test(path.pathname)) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(path, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
      }).outputText };
    }
    if (url.split('?')[0] === packageURL) return { format: 'module', source: `export default ${readFileSync(new URL(packageURL), 'utf8')}`, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver, ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList);
const { createRoot } = await import('react-dom/client');
const host = document.getElementById('root')!;
let cleanup = () => {}, fixtureId = 0;
afterEach(async () => { await act(async () => cleanup()); cleanup = () => {}; document.querySelectorAll('[data-sidebar-test-host]').forEach(node => node.remove()); });
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const metadata = () => ({ revision: 1, skillAnnotations: [{ skillId: 'alpha', revision: 1, alias: '个人别名', notes: '唯一检索备注' }], savedViews: [
  { id: 'review', revision: 1, name: '个人收藏视图', view: 'skills', filters: { query: '唯一检索备注', sourceFilter: 'local', statusFilter: 'all', categoryFilter: 'favorites', sort: 'checked', mode: 'cards', pageSize: 50 } },
] });
const snapshot = () => freeze({ stateRevision: 1, managementRevision: 1, skills: [
  { id: 'alpha', name: 'alpha-original', description: '原始介绍', localPath: 'D:/synthetic/alpha', favorite: true },
  { id: 'beta', name: 'beta-original', description: '其他说明', localPath: 'D:/synthetic/beta' },
] as LibraryItem[], sources: [], connections: [], settings: { libraryMode: 'list', librarySort: 'name', libraryPageSize: 20 } });

async function fixture(options: { panes?: number; operation?: boolean; detailSkillId?: string; active?: boolean; visible?: boolean; sidebarHost?: HTMLElement; actualTasks?: boolean; state?: ReturnType<typeof snapshot>; draft?: Record<string, unknown>; load?: () => Promise<ReturnType<typeof metadata>>; read?: (action: string, args: unknown) => unknown; nativeRead?: (action: string, args: unknown) => unknown } = {}) {
  const query = `?managementAppFixture=${++fixtureId}`;
  const { default: App } = await import(new URL('../src/App.tsx' + query, import.meta.url).href);
  const { WorkspaceSessionContext } = await import(new URL('../src/session.tsx' + query, import.meta.url).href);
  const { useTasks } = await import(new URL('../src/tasks.ts' + query, import.meta.url).href);
  const state = freeze(options.state || snapshot()), original = JSON.stringify(state);
  const calls: { action: string; args: unknown }[] = [], accepted: unknown[] = [];
  const opened: { modal: unknown; draft: Record<string, unknown> }[] = [];
  const homeNavigation: unknown[][] = [];
  const bridges = new Map<string, { capture: () => any; flush: () => Promise<boolean> }>();
  const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();
  let inspectActualTask: ((id: string) => Promise<unknown>) | undefined;
  const run = async (_label: string, action: string, args: unknown) => {
    calls.push({ action, args });
    if (action !== 'management_data' && options.read) return options.read(action, args);
    assert.equal(action, 'management_data', 'view interactions must not write, launch, or request unrelated tasks');
    return options.load ? options.load() : metadata();
  };
  Object.assign(globalThis, { managementAppTest: {
    invoke: async (_command: string, args: { request: { action: string } }) => { calls.push({ action: args.request.action, args: args.request }); if (options.nativeRead) return options.nativeRead(args.request.action, args.request); throw new Error(`unexpected native request: ${args.request.action}`); },
    native: async (action: string, args: unknown) => { calls.push({ action, args }); throw new Error(`unexpected native operation: ${action}`); },
    listen: (name: string, listener: (event: { payload: unknown }) => void) => { const handlers = listeners.get(name) || new Set(); handlers.add(listener); listeners.set(name, handlers); return () => { handlers.delete(listener); }; },
  } });
  let sessions = Array.from({ length: options.panes || 1 }, (_, index) => ({
    pane: { id: `home-${index}`, kind: options.operation ? 'operation' : options.detailSkillId ? 'detail' : 'home', skillId: options.detailSkillId, state: { view: 'skills' } }, active: options.active ?? index === 0, visible: options.visible ?? true, sidebarHost: options.sidebarHost, owned: true, closing: false,
    isTransferring: () => false, initialDraft: options.draft || {}, managerSnapshot: state,
    tasks: { tasks: [], run, inspect: async () => undefined, cancel: async () => undefined, clear: async () => undefined },
    acceptSnapshot: (value: unknown) => { accepted.push(value); },
    register: (id: string, bridge: any) => { bridges.set(id, bridge); return () => { bridges.delete(id); }; },
    updateNavigation: () => {}, openDetail: () => {}, openHistory: () => {}, openOperation: (modal: unknown, draft: Record<string, unknown>) => { opened.push({ modal, draft }); }, goHome: (...args: unknown[]) => { homeNavigation.push(args); }, closePane: () => {}, focusPane: () => {}, requestStorageRestart: async () => {},
  }));
  function ActualTaskSessions() {
    const tasks = useTasks(); inspectActualTask = tasks.inspect;
    // Keep unrelated view reads on the existing fixture path; task listing,
    // inspection and events use the real shared task service hook.
    return createElement('div', null, ...sessions.map(session => createElement(WorkspaceSessionContext.Provider, { key: session.pane.id, value: { ...session, tasks: { ...tasks, run } } }, createElement(App))));
  }
  const root = createRoot(host); cleanup = () => root.unmount();
  const render = async () => act(async () => root.render(options.actualTasks ? createElement(ActualTaskSessions) : createElement('div', null, ...sessions.map(session => createElement(WorkspaceSessionContext.Provider, { key: session.pane.id, value: session }, createElement(App))))));
  await render();
  return { calls, accepted, opened, homeNavigation, state, original, bridges, render, emitNative: async (name: string, payload: unknown) => { await act(async () => { for (const listener of listeners.get(name) || []) listener({ payload }); }); }, inspectTask: async (id: string) => { assert(inspectActualTask); await act(async () => { await inspectActualTask!(id); }); }, updateSnapshot: async (next: ReturnType<typeof snapshot>) => {
    sessions = sessions.map(session => ({ ...session, managerSnapshot: freeze(next) }));
    await render();
  }, updatePaneState: async (next: Record<string, unknown>) => {
    sessions = sessions.map(session => ({ ...session, pane: { ...session.pane, state: { ...session.pane.state, ...next } } }));
    await render();
  }, dispose: async () => { await act(async () => root.unmount()); cleanup = () => {}; }, pane: (index = 0) => host.querySelector<HTMLElement>(`[data-session-pane="home-${index}"]`)! };
}
const change = async (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
});
const choose = async (select: HTMLSelectElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
});
const click = async (button: Element) => act(async () => { button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); });
const button = (scope: Element, label: string) => [...scope.querySelectorAll('button')].find(item => item.textContent === label)!;
const results = (scope: Element) => [...scope.querySelectorAll('[data-skill-id]')].map(item => item.getAttribute('data-skill-id'));

test('Skill management record removal is discoverable in details and keeps client connections out of the request', async () => {
  const current = snapshot();
  const state = { ...current, connections: [{ id: 'connection', skillId: 'alpha', client: 'codex', path: 'D:/synthetic/client/alpha', linked: true }] } as unknown as ReturnType<typeof snapshot>;
  const f = await fixture({ state, draft: { libraryMode: 'details', selectedId: 'alpha', tab: 'source' }, read: action => {
    if (action === 'forget') return { ...state, stateRevision: 2, skills: [state.skills[1]], connections: [] };
    if (action === 'preview_relocate_local') return relocationPreview();
    return {};
  } });
  const detail = f.pane().querySelector('.skill-detail')!;
  assert.equal(button(detail, '移除管理记录').disabled, false, 'existing client connections do not require disconnection');
  await click(button(detail, '更多'));
  const menu = document.querySelector('[role="menu"]')!;
  await click(button(menu, '重新定位本地目录…'));
  assert.equal(document.querySelector('[role="dialog"]'), null, 'the relocation workflow leaves the main page available');
  assert.equal(f.opened.length, 1);
  assert.equal((f.opened[0].modal as { kind: string }).kind, 'relocate-local');
  assert.equal(f.opened[0].draft.skillRelocationDraft, undefined, 'opening another Skill does not reuse a previous relocation draft');
  await click(button(detail, '更多')); await click(button(document.querySelector('[role="menu"]')!, '移除管理记录…'));
  const dialog = document.querySelector('[role="dialog"]')!;
  assert.match(dialog.textContent!, /客户端实际连接和 GitHub 内容均保留/);
  assert.match(dialog.textContent!, /不会自动重新导入/);
  assert.equal(f.calls.filter(call => call.action === 'forget').length, 0);
  await click(button(dialog, '确认移除记录'));
  assert.deepEqual(f.calls.find(call => call.action === 'forget')?.args, { skillId: 'alpha' });
  assert(!f.calls.some(call => ['disconnect', 'preview_disconnect', 'apply_disconnect', 'apply_skill_remove', 'delete_skill', 'export', 'relocate_local'].includes(call.action)));
  assert.equal(JSON.stringify(f.state), f.original, 'the original snapshot is never edited in place');
});

test('Skill list offers management record removal only for one selected record without changing bulk selection', async () => {
  const f = await fixture();
  assert.equal(button(f.pane(), '移除管理记录'), undefined);
  const alpha = row(f.pane(), 'alpha').querySelector('input')!, beta = row(f.pane(), 'beta').querySelector('input')!;
  await click(alpha);
  assert(button(f.pane(), '移除管理记录'));
  await click(beta);
  assert.equal(button(f.pane(), '移除管理记录'), undefined, 'batch removal is not silently introduced');
  assert(button(f.pane(), '检查所选 (2)'));
  await click(beta);
  await click(button(f.pane(), '移除管理记录'));
  const dialog = document.querySelector('[role="dialog"]')!;
  assert.match(dialog.textContent!, /个人别名/);
  await click(button(dialog, '取消'));
  assert.equal((alpha as HTMLInputElement).checked, true);
  assert.equal(f.calls.filter(call => call.action === 'forget').length, 0);
});

test('local directory errors stay concise in the Skill list while full errors and unrelated error meanings remain available', async () => {
  const current = snapshot(), error = 'Cannot resolve path (D:/synthetic/alpha): 系统找不到指定的路径 (os error 3)';
  const f = await fixture({ state: { ...current, skills: [{ ...current.skills[0], error }, { ...current.skills[1], error: '仓库凭据已过期' }] } });
  const missing = row(f.pane(), 'alpha').querySelector('.status-detail')!;
  assert.equal(missing.textContent, '本地目录不可用');
  assert(missing.getAttribute('title')!.includes(error));
  assert.equal(row(f.pane(), 'beta').querySelector('.status-detail')!.textContent, '仓库凭据已过期');
});

const relocationPreview = () => ({ id: 'relocation-preview', kind: 'localRelocation', skillId: 'alpha', oldPath: 'D:/synthetic/missing', path: 'D:/synthetic/new', name: 'model-research', displayName: 'Model Research', version: '0.2.0', duplicateId: 'duplicate', canApply: true, warnings: ['客户端原有失效入口仍需检查连接。'], retained: ['分类', '收藏', '别名与备注', 'GitHub关联', '安装基准'] });
async function relocationFixture(handler: (command: string, args: Record<string, unknown>) => unknown, chooseDirectory = async () => 'D:/synthetic/new') {
  const { SkillRelocation } = await import(new URL('../src/SkillRelocation.tsx', import.meta.url).href);
  const calls: { command: string; args: Record<string, unknown> }[] = [], applied: unknown[] = [];
  const root = createRoot(host); cleanup = () => root.unmount();
  let readOnly = false;
  const render = async () => act(async () => root.render(createElement(SkillRelocation, {
    skillId: 'alpha', oldPath: 'D:/synthetic/missing', readOnly, chooseDirectory,
    action: async (_label: string, command: string, args: Record<string, unknown>) => { calls.push({ command, args }); return handler(command, args); },
    onApplied: (result: unknown) => applied.push(result), onClose: () => {}, onDraft: () => {},
  })));
  await render();
  return { calls, applied, render, setReadOnly: async (value: boolean) => { readOnly = value; await render(); }, dispose: async () => { await act(async () => root.unmount()); cleanup = () => {}; }, input: () => host.querySelector<HTMLInputElement>('[aria-label="现在的 Skill 目录"]')! };
}

test('local relocation uses an operation page and transfers its path and preview without replaying a write', async () => {
  const current = snapshot(), modal = { kind: 'relocate-local', skill: current.skills[0] };
  const f = await fixture({ operation: true, draft: { modal } });
  assert.equal(document.querySelector('[role="dialog"]'), null);
  const input = f.pane().querySelector<HTMLInputElement>('[aria-label="现在的 Skill 目录"]')!;
  assert.equal(input.value, '', 'a missing original path is not used as a directory-picker default');
  await change(input, 'D:/synthetic/new');
  const draft = f.bridges.get('home-0')!.capture();
  assert.deepEqual(draft.skillRelocationDraft, { path: 'D:/synthetic/new', preview: null });
  await f.dispose();
  const preview = relocationPreview();
  const next = await fixture({ operation: true, draft: { ...draft, skillRelocationDraft: { path: preview.path, preview } }, read: (action, args) => {
    assert.equal(action, 'relocate_local'); assert.deepEqual(args, { previewId: preview.id }); return { ...current, stateRevision: 2 };
  } });
  assert.equal(next.pane().querySelector<HTMLInputElement>('[aria-label="现在的 Skill 目录"]')!.value, preview.path);
  assert(next.pane().querySelector('[aria-label="本地目录重新定位预览"]'));
  assert.equal(next.calls.filter(call => call.action === 'relocate_local').length, 0);
  assert.deepEqual(next.bridges.get('home-0')!.capture().skillRelocationDraft, { path: preview.path, preview });
  await click(button(next.pane(), '确认重新定位'));
  assert(next.accepted.some(value => (value as { stateRevision?: number }).stateRevision === 2));
  assert.equal(next.calls.filter(call => call.action === 'relocate_local').length, 1);
});

test('local relocation previews the chosen directory and confirms only its preview ID with all retention information', async () => {
  const saved = { ...snapshot(), stateRevision: 2 };
  const pending = deferred<typeof saved>();
  const f = await relocationFixture(command => command === 'preview_relocate_local' ? relocationPreview() : pending.promise);
  assert.equal(button(host, '确认重新定位').disabled, true);
  await click(button(host, '选择目录'));
  assert.equal(f.input().value, 'D:/synthetic/new');
  assert.equal(f.calls.length, 0, 'choosing a directory does not mutate or inspect it');
  await click(button(host, '预览对应关系'));
  assert.deepEqual(f.calls, [{ command: 'preview_relocate_local', args: { skillId: 'alpha', path: 'D:/synthetic/new' } }]);
  const preview = host.querySelector('[aria-label="本地目录重新定位预览"]')!;
  for (const text of ['D:/synthetic/missing', 'D:/synthetic/new', 'Model Research', 'model-research', '0.2.0', '重复记录', '分类', '收藏', '别名与备注', 'GitHub关联', '安装基准', '失效入口']) assert(preview.textContent!.includes(text));
  await act(async () => { button(host, '确认重新定位').click(); button(host, '确认重新定位').click(); });
  assert.deepEqual(f.calls[1], { command: 'relocate_local', args: { previewId: 'relocation-preview' } });
  assert.equal(f.calls.filter(call => call.command === 'relocate_local').length, 1);
  await act(async () => pending.resolve(saved));
  assert.deepEqual(f.applied, [saved]);
});

test('local relocation discards a late preview when the path changes and ignores a result after close', async () => {
  const pending = deferred<ReturnType<typeof relocationPreview>>();
  const f = await relocationFixture(() => pending.promise);
  await change(f.input(), 'D:/synthetic/first');
  await click(button(host, '预览对应关系'));
  await change(f.input(), 'D:/synthetic/second');
  await act(async () => pending.resolve(relocationPreview()));
  assert.equal(host.querySelector('[aria-label="本地目录重新定位预览"]'), null);
  assert.equal(button(host, '确认重新定位').disabled, true);
  assert.equal(f.input().value, 'D:/synthetic/second');
  await f.dispose();
  const late = deferred<ReturnType<typeof relocationPreview>>();
  const closed = await relocationFixture(() => late.promise);
  await change(closed.input(), 'D:/synthetic/new'); await click(button(host, '预览对应关系'));
  await closed.dispose(); await act(async () => late.resolve(relocationPreview()));
  assert.deepEqual(closed.applied, []);
});

test('local relocation refuses a blocked preview and invalidates failed or no longer allowed confirmation', async () => {
  let canApply = false;
  const f = await relocationFixture(command => { if (command === 'preview_relocate_local') return { ...relocationPreview(), canApply }; throw new Error('目录已变化，请重新预览。'); });
  await change(f.input(), 'D:/synthetic/new'); await click(button(host, '预览对应关系'));
  assert.equal(button(host, '确认重新定位').disabled, true);
  canApply = true; await click(button(host, '预览对应关系')); await click(button(host, '确认重新定位'));
  assert.match(host.querySelector('[role="alert"]')!.textContent!, /目录已变化/);
  assert.equal(button(host, '确认重新定位').disabled, true);
  assert.equal(f.input().value, 'D:/synthetic/new');
  await click(button(host, '预览对应关系')); await f.setReadOnly(true);
  assert.equal(host.querySelector('[aria-label="本地目录重新定位预览"]'), null);
  assert.equal(button(host, '确认重新定位').disabled, true);
  assert.equal(f.calls.filter(call => call.command === 'relocate_local').length, 1);
});

test('late navigation persistence keeps the current search while explicit newer focus requests navigate', async () => {
  const f = await fixture({ read: action => {
    assert.equal(action, 'resource_list');
    return { resources: [] };
  } });
  await click(button(f.pane().querySelector('[aria-label="主要导航"]')!, '总览'));
  await click(button(f.pane().querySelector('[aria-label="主要导航"]')!, '全部资源'));
  await change(f.pane().querySelector<HTMLInputElement>('[aria-label="搜索全部资源"]')!, 'alpha');
  await f.updatePaneState({ view: 'dashboard' });
  assert.equal(f.pane().querySelector<HTMLInputElement>('[aria-label="搜索全部资源"]')?.value, 'alpha');
  await f.updatePaneState({ view: 'settings', focusRevision: 100 });
  assert(f.pane().querySelector('[data-settings-section="general"]'));
  await click(button(f.pane().querySelector('[aria-label="主要导航"]')!, '全部资源'));
  await f.updatePaneState({ view: 'dashboard', focusRevision: 99 });
  assert.equal(f.pane().querySelector<HTMLInputElement>('[aria-label="搜索全部资源"]')?.value, 'alpha');
  await f.updatePaneState({ view: 'settings', focusRevision: 101 });
  assert(f.pane().querySelector('[data-settings-section="general"]'));
});

test('actual task details prefer a live result, retain an inspected result across metadata events, and never revive expired results', async () => {
  const oldSummary = '最初已读的任务摘要', newSummary = '当前任务返回的新摘要';
  const initial = { id: 'observed-task', action: 'resource_invoke', label: '查看真实任务结果', status: 'running', stage: '正在运行', createdAt: '2026-11-01T00:00:00Z', startedAt: '2026-11-01T00:00:01Z', origin: { view: 'tools' }, cancellable: false, resultAvailable: true, resultExpired: false, result: { summary: oldSummary } };
  let fullTask = initial;
  const metadataOnly = (task: typeof initial) => { const { result: _result, ...wire } = task; return wire; };
  const f = await fixture({ actualTasks: true, operation: true, draft: { modal: { kind: 'task', task: initial } }, nativeRead: (action, args) => {
    if (action === 'list_tasks') return { tasks: [metadataOnly(fullTask)] };
    assert.equal(action, 'get_task'); assert.equal((args as { taskId: string }).taskId, initial.id);
    return { task: fullTask };
  } });
  assert(f.pane().textContent?.includes(oldSummary));
  fullTask = { ...initial, result: { summary: newSummary } };
  await f.inspectTask(initial.id);
  assert(f.pane().textContent?.includes(newSummary)); assert(!f.pane().textContent?.includes(oldSummary));

  fullTask = { ...fullTask, status: 'succeeded', stage: '操作完成' };
  await f.emitNative('task-updated', { task: metadataOnly(fullTask) });
  assert(f.pane().textContent?.includes(newSummary));
  const inspected = f.calls.filter(call => call.action === 'get_task').length;
  // Real task-updated events omit result. An already-terminal metadata event
  // does not trigger another inspection, so the App must retain its read result.
  await f.emitNative('task-updated', { task: metadataOnly(fullTask) });
  assert.equal(f.calls.filter(call => call.action === 'get_task').length, inspected);
  assert(f.pane().textContent?.includes(newSummary));
  await f.emitNative('task-updated', { task: { ...metadataOnly(fullTask), resultAvailable: false } });
  assert(!f.pane().textContent?.includes(newSummary)); assert(!f.pane().textContent?.includes(oldSummary));
  await f.inspectTask(initial.id); assert(f.pane().textContent?.includes(newSummary));
  await f.emitNative('task-updated', { task: { ...metadataOnly(fullTask), resultAvailable: false, resultExpired: true } });
  assert(!f.pane().textContent?.includes(newSummary)); assert(!f.pane().textContent?.includes(oldSummary));
  assert(f.pane().textContent?.includes('临时预览已过期'));
  assert(!f.calls.some(call => /start_task|apply_|download|install|cancel_task/.test(call.action)));
});

test('actual App keeps its original sidebar when the outer host is not ready', async () => {
  const f = await fixture(); assert.equal(f.pane().querySelectorAll('aside.sidebar').length, 1); assert(f.pane().querySelector('button.nav-item[aria-label="Skills"]')); assert(f.pane().querySelector('[aria-label="调整侧栏宽度"]'));
});

test('actual hidden Home portals one usable sidebar, navigation, categories and dialogs outside its hidden page', async () => {
  const sidebarHost = document.createElement('div'); sidebarHost.setAttribute('data-sidebar-test-host', ''); document.body.append(sidebarHost);
  const f = await fixture({ sidebarHost, active: false, visible: false, state: { ...snapshot(), settings: { ...snapshot().settings, categories: [{ id: 'research', name: '研究分类', color: 'blue' }] } } as ReturnType<typeof snapshot> });
  f.pane().hidden = true;
  const side = sidebarHost.querySelector('aside.sidebar')!; assert(side); assert.equal(side.closest('[hidden]'), null); assert.equal(f.pane().querySelector('aside.sidebar'), null); assert.equal(document.querySelectorAll('aside.sidebar').length, 1);
  await click(side.querySelector('[aria-label="Skills"]')!); assert.deepEqual(f.homeNavigation, [['skills']]);
  const category = [...side.querySelectorAll('.category-select')].find(node => node.textContent?.startsWith('研究分类'))!; await click(category);
  assert.deepEqual(f.homeNavigation, [['skills'], ['skills']]); assert.equal(f.bridges.get('home-0')!.capture().categoryFilter, 'research');
  await click(side.querySelector('[aria-label="创建分类"]')!);
  const dialog = sidebarHost.querySelector('[role="dialog"]')!; assert(dialog); assert.equal(dialog.closest('[hidden]'), null); assert.equal(f.pane().querySelector('[role="dialog"]'), null);
  assert.equal(document.querySelectorAll('aside.sidebar').length, 1); assert(!f.calls.some(call => /create_category|assign_category|resource_invoke/.test(call.action)), 'view and dialog opening must not perform writes');
});

test('real App searches annotation aliases and notes without changing the raw manager snapshot', async () => {
  const f = await fixture();
  const search = f.pane().querySelector<HTMLInputElement>('[aria-label="搜索 Skill"]')!;
  assert(search);
  for (const query of ['个人别名', '唯一检索备注']) {
    await change(search, query);
    assert.deepEqual(results(f.pane()), ['alpha']);
    assert(f.pane().querySelector('[data-skill-id="alpha"]')!.textContent!.includes('个人别名'));
  }
  await change(search, 'beta-original'); assert.deepEqual(results(f.pane()), ['beta']);
  assert.equal(JSON.stringify(f.state), f.original);
  assert(f.accepted.every(value => value === f.state), 'App publishes the raw snapshot rather than its display annotations');
  assert.deepEqual(f.calls.map(call => call.action), ['management_data']);
});

test('visible App panes coalesce their metadata read and share the result without repeat reads', async () => {
  const pending = deferred<ReturnType<typeof metadata>>();
  const f = await fixture({ panes: 2, load: () => pending.promise });
  assert.deepEqual(f.calls.map(call => call.action), ['management_data']);
  await act(async () => pending.resolve(metadata()));
  for (let pane = 0; pane < 2; pane++) {
    await change(f.pane(pane).querySelector<HTMLInputElement>('[aria-label="搜索 Skill"]')!, '唯一检索备注');
    assert.deepEqual(results(f.pane(pane)), ['alpha']);
  }
  await f.render();
  assert.deepEqual(f.calls.map(call => call.action), ['management_data']);
  assert.equal(JSON.stringify(f.state), f.original);
});

test('a metadata read failure stays idle across rerenders until the actual App retry button is used', async () => {
  let attempts = 0;
  const f = await fixture({ load: async () => { if (++attempts === 1) throw new Error('synthetic metadata failure'); return metadata(); } });
  const retry = button(f.pane(), '重新读取');
  assert(retry, 'App exposes an explicit metadata retry after a failed read');
  assert.equal(attempts, 1);
  await f.render();
  await change(f.pane().querySelector<HTMLInputElement>('[aria-label="搜索 Skill"]')!, 'beta');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  assert.equal(attempts, 1, 'failure does not trigger a render or timer retry loop');
  await click(retry);
  assert.equal(attempts, 2);
  assert.equal(f.pane().querySelector('.management-data-error'), null);
  await change(f.pane().querySelector<HTMLInputElement>('[aria-label="搜索 Skill"]')!, '个人别名');
  assert.deepEqual(results(f.pane()), ['alpha']);
  assert.deepEqual(f.calls.map(call => call.action), ['management_data', 'management_data']);
});

test('applying a SavedViews entry changes only the active App view and never saves settings or launches a task', async () => {
  const f = await fixture({ panes: 2 });
  const saved = f.pane().querySelector<HTMLSelectElement>('.saved-views [aria-label="保存的视图"]');
  assert(saved, 'the real App renders its SavedViews control');
  await choose(saved, 'review');
  const before = f.calls.length;
  await click(button(f.pane(), '应用视图'));
  assert.equal(f.pane().querySelector<HTMLInputElement>('[aria-label="搜索 Skill"]')!.value, '唯一检索备注');
  assert.equal(f.pane().querySelector<HTMLSelectElement>('[aria-label="Skill 排序"]')!.value, 'checked');
  assert.equal(f.pane().querySelector<HTMLSelectElement>('[aria-label="每页 Skill 数量"]')!.value, '50');
  assert(f.pane().querySelector('.library-card-grid'), 'the saved card mode is applied');
  assert.deepEqual(results(f.pane()), ['alpha']);
  const captured = f.bridges.get('home-0')!.capture();
  assert.equal(captured.filter, 'local'); assert.equal(captured.categoryFilter, 'favorites');
  assert.equal(f.pane(1).querySelector<HTMLInputElement>('[aria-label="搜索 Skill"]')!.value, '', 'another visible pane keeps its own filters');
  assert.equal(f.pane(1).querySelector<HTMLSelectElement>('[aria-label="Skill 排序"]')!.value, 'name');
  assert(f.pane(1).querySelector('.skill-table'), 'another pane retains its list view');
  await act(async () => { assert.equal(await f.bridges.get('home-0')!.flush(), true); });
  assert.equal(f.calls.length, before, 'applying and flushing a saved view produces no backend writes or execution');
  assert.equal(JSON.stringify(f.state), f.original);
});

const readingSnapshot = (skills: LibraryItem[], sort = 'name', revision = 1) => ({
  ...snapshot(), stateRevision: revision, skills, settings: { libraryMode: 'list', librarySort: sort, libraryPageSize: 20 },
});
const row = (scope: Element, id: string) => scope.querySelector<HTMLElement>(`[data-skill-id="${id}"]`)!;

test('status updates preserve attention-filter members, checked selection, focus and scroll until the reader reorganizes', async () => {
  const skills = [
    { id: 'alpha', name: 'alpha', status: 'error' },
    { id: 'beta', name: 'beta', status: 'remote_updated' },
    { id: 'gamma', name: 'gamma', status: 'synced' },
  ];
  const f = await fixture({ state: readingSnapshot(skills, 'status'), draft: { statusFilter: 'attention' } });
  assert.deepEqual(results(f.pane()), ['alpha', 'beta']);
  const selectedRow = row(f.pane(), 'alpha');
  const checkbox = selectedRow.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await click(checkbox);
  await act(async () => selectedRow.focus());
  const scroller = f.pane().querySelector<HTMLElement>('[data-pane-scroll]')!;
  scroller.scrollTop = 224;
  await f.updateSnapshot(readingSnapshot([
    { ...skills[0], status: 'synced' }, skills[1], { ...skills[2], status: 'error' },
  ], 'status', 2));
  assert.deepEqual(results(f.pane()), ['alpha', 'beta', 'gamma'], 'existing members stay in place and newly matching members append');
  assert(row(f.pane(), 'alpha') === selectedRow, 'the existing row keeps its DOM identity');
  assert.equal(row(f.pane(), 'alpha').querySelector('[data-status]')!.getAttribute('data-status'), 'synced', 'visible status still updates immediately');
  assert.equal(checkbox.checked, true);
  assert(document.activeElement === selectedRow, 'background status changes keep focus on the same row');
  assert.equal(f.bridges.get('home-0')!.capture().selectedId, 'alpha');
  assert.equal(scroller.scrollTop, 224);
  await click(button(f.pane(), '重新整理列表'));
  assert.deepEqual(results(f.pane()), ['gamma', 'beta'], 'explicit reorganization reapplies the attention filter and status order');
  await choose(f.pane().querySelector<HTMLSelectElement>('[aria-label="按状态筛选"]')!, 'all');
  assert.deepEqual(results(f.pane()), ['gamma', 'beta', 'alpha'], 'a reader filter change immediately applies the new membership');
  assert.deepEqual(f.calls.map(call => call.action), ['management_data']);
});

test('checked-time updates preserve reading order and append newly discovered skills until explicit reorganization', async () => {
  const skills = [
    { id: 'one', name: 'one', lastChecked: '2026-10-30T03:00:00Z' },
    { id: 'two', name: 'two', lastChecked: '2026-10-30T02:00:00Z' },
    { id: 'three', name: 'three', lastChecked: '2026-10-30T01:00:00Z' },
  ];
  const f = await fixture({ state: readingSnapshot(skills, 'checked') });
  assert.deepEqual(results(f.pane()), ['one', 'two', 'three']);
  const priorRows = skills.map(skill => row(f.pane(), skill.id));
  await f.updateSnapshot(readingSnapshot([
    skills[0], { ...skills[1], lastChecked: '2026-10-30T04:00:00Z' },
    { ...skills[2], lastChecked: '2026-10-30T05:00:00Z' },
    { id: 'four', name: 'four', lastChecked: '2026-10-30T06:00:00Z' },
  ], 'checked', 2));
  assert.deepEqual(results(f.pane()), ['one', 'two', 'three', 'four']);
  skills.forEach((skill, index) => assert(row(f.pane(), skill.id) === priorRows[index], 'unchanged row identity survives timestamp updates'));
  await click(button(f.pane(), '重新整理列表'));
  assert.deepEqual(results(f.pane()), ['four', 'three', 'two', 'one']);
  assert.deepEqual(f.calls.map(call => call.action), ['management_data']);
});

test('removing the selected skill moves selection and focus to the surviving neighbor at its previous position', async () => {
  const skills = ['a', 'b', 'c', 'd'].map(id => ({ id, name: id, status: 'synced' }));
  const f = await fixture({ state: readingSnapshot(skills) });
  await click(row(f.pane(), 'b').querySelector('input[type="checkbox"]')!);
  await click(row(f.pane(), 'd').querySelector('input[type="checkbox"]')!);
  await act(async () => row(f.pane(), 'b').focus());
  await f.updateSnapshot(readingSnapshot([skills[0], skills[2], skills[3]], 'name', 2));
  assert.deepEqual(results(f.pane()), ['a', 'c', 'd']);
  assert.equal(f.bridges.get('home-0')!.capture().selectedId, 'c', 'deleting the middle selection uses the next surviving item rather than the first item');
  assert(document.activeElement?.closest('[data-skill-id]')?.getAttribute('data-skill-id') === 'c', 'focus follows the same neighboring selection');
  assert.deepEqual(f.bridges.get('home-0')!.capture().checkedSkills, ['d'], 'deleted checks are removed while surviving checks remain');
  assert.equal(row(f.pane(), 'd').querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked, true);
  await act(async () => row(f.pane(), 'd').focus());
  await f.updateSnapshot(readingSnapshot([skills[0], skills[2]], 'name', 3));
  assert.equal(f.bridges.get('home-0')!.capture().selectedId, 'c', 'deleting the last selection uses the previous surviving item');
  assert(document.activeElement?.closest('[data-skill-id]')?.getAttribute('data-skill-id') === 'c');
  assert.deepEqual(f.calls.map(call => call.action), ['management_data']);
});

test('the real App compensates its scroll anchor when a background deletion removes a row above the reader', async () => {
  const skills = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, name: id, status: 'synced' }));
  const f = await fixture({ state: readingSnapshot(skills) });
  const scroller = f.pane().querySelector<HTMLElement>('[data-pane-scroll]')!;
  // JSDOM has no layout. Supply row geometry while letting the actual App boundary
  // capture and restore the anchor through React's snapshot/commit lifecycle.
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 80 }, offsetHeight: { configurable: true, value: 80 },
    scrollHeight: { configurable: true, get: () => results(f.pane()).length * 40 },
  });
  const original = dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this === scroller) return new dom.window.DOMRect(0, 100, 800, 80);
    if (this.matches('[data-skill-id]') && scroller.contains(this)) {
      const index = [...scroller.querySelectorAll('[data-skill-id]')].indexOf(this);
      return new dom.window.DOMRect(0, 100 + index * 40 - scroller.scrollTop, 800, 40);
    }
    return original.call(this);
  };
  try {
    scroller.scrollTop = 85;
    const before = row(f.pane(), 'c').getBoundingClientRect().top;
    assert.equal(before, 95);
    await f.updateSnapshot(readingSnapshot(skills.slice(1), 'name', 2));
    assert.deepEqual(results(f.pane()), ['b', 'c', 'd', 'e']);
    assert.equal(scroller.scrollTop, 45, 'removing the 40px row above the anchor compensates the scroll offset');
    assert.equal(row(f.pane(), 'c').getBoundingClientRect().top, before, 'the first visible surviving row keeps its viewport position');
    assert.deepEqual(f.calls.map(call => call.action), ['management_data']);
  } finally { dom.window.HTMLElement.prototype.getBoundingClientRect = original; }
});

const panelTool = { id: 'tool-one', name: 'Example Tool', kind: 'cli', rootPath: 'D:/synthetic/tool-one', alias: '', notes: '', enabled: true, revision: 4, ownership: 'external', managementScope: 'register', actions: [], capabilities: [], createdAt: '', updatedAt: '' };
const readPanel = (action: string) => {
  if (action === 'resource_list') return { resources: [panelTool] };
  if (action === 'resource_runtime') return { runs: [] };
  assert.fail(`restoring a tool view must not execute ${action}`);
};

test('actual App unified library loads original identities, opens tool details and retains its search across pages', async () => {
  const f = await fixture({ read: readPanel });
  await click(f.pane().querySelector('button.nav-item[aria-label="全部资源"]')!);
  assert.deepEqual(new Set(results(f.pane())), new Set(['skill:alpha', 'skill:beta', 'tool:tool-one']));
  assert(f.pane().querySelector('[data-skill-id="skill:alpha"]')!.textContent!.includes('个人别名'));
  await click(f.pane().querySelector('[data-skill-id="tool:tool-one"] .unified-name button')!);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 35)); });
  assert.equal(f.bridges.get('home-0')!.capture().view, 'tools');
  assert(f.pane().querySelector('[aria-label="Example Tool 详情"]'));
  await click(f.pane().querySelector('button.nav-item[aria-label="全部资源"]')!);
  await change(f.pane().querySelector<HTMLInputElement>('[aria-label="搜索全部资源"]')!, '唯一检索备注');
  assert.deepEqual(results(f.pane()), ['skill:alpha']);
  await click(f.pane().querySelector('button.nav-item[aria-label="Skills"]')!);
  await click(f.pane().querySelector('button.nav-item[aria-label="全部资源"]')!);
  assert.equal(f.pane().querySelector<HTMLInputElement>('[aria-label="搜索全部资源"]')!.value, '唯一检索备注');
  assert.deepEqual(results(f.pane()), ['skill:alpha']);
  const draft = f.bridges.get('home-0')!.capture();
  assert.equal(draft.resourceLibraryDraft.query, '唯一检索备注');
  assert.equal(JSON.stringify(f.state), f.original);
  assert(f.calls.every(call => ['management_data', 'resource_list', 'resource_runtime'].includes(call.action)));
});

test('actual App retains the tool panel and editor across views, refreshes only on visibility and transfers its draft', async () => {
  const f = await fixture({ read: readPanel });
  const scroller = f.pane().querySelector<HTMLElement>('[data-pane-scroll]')!;
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 500 }, offsetHeight: { configurable: true, value: 500 },
    scrollHeight: { configurable: true, value: 2000 },
  });
  scroller.scrollTo = (options: ScrollToOptions | number, _y?: number) => { scroller.scrollTop = typeof options === 'number' ? _y || 0 : options.top || 0; };
  await click(f.pane().querySelector('button.nav-item[aria-label="工具"]')!);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 35)); });
  const panel = f.pane().querySelector('.resource-panel')!;
  assert(panel, 'actual App renders the tool panel');
  const search = panel.querySelector<HTMLInputElement>('[aria-label="搜索工具"]')!;
  await change(search, 'Example');
  await choose(panel.querySelector<HTMLSelectElement>('[aria-label="工具类型"]')!, 'cli');
  await click(panel.querySelector('.resource-name-button')!);
  await click(panel.querySelector('.resource-row-actions button')!);
  const editorName = panel.querySelector<HTMLInputElement>('.resource-editor input')!;
  await change(editorName, 'Unsaved tool name');
  scroller.scrollTop = 407;
  const reads = f.calls.filter(call => call.action === 'resource_list').length;
  await click(f.pane().querySelector('button.nav-item[aria-label="skills" i],button.nav-item[aria-label="Skills"]')!);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 35)); });
  assert(panel.closest('[hidden]'), 'tool panel remains mounted while hidden');
  await f.updateSnapshot({ ...snapshot(), stateRevision: 2 });
  assert.equal(f.calls.filter(call => call.action === 'resource_list').length, reads, 'hidden tool panels do not refresh');
  await click(f.pane().querySelector('button.nav-item[aria-label="工具"]')!);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 35)); });
  assert(f.pane().querySelector('.resource-panel') === panel, 'returning retains component and DOM identity');
  assert.equal(search.value, 'Example');
  assert.equal(editorName.value, 'Unsaved tool name');
  assert.equal(scroller.scrollTop, 407, 'each primary view restores its own scroll position');
  assert.equal(f.calls.filter(call => call.action === 'resource_list').length, reads + 1, 'visibility follows up once after a hidden change');
  const draft = f.bridges.get('home-0')!.capture();
  assert.equal(draft.toolPanelDraft.query, 'Example');
  assert.equal(draft.toolPanelDraft.kind, 'cli');
  assert.equal(draft.toolPanelDraft.selectedId, 'tool-one');
  assert.equal(draft.toolPanelDraft.editor.fields.name, 'Unsaved tool name');
  assert.equal(draft.toolPanelDraft.editor.expectedRevision, 4);
  assert(f.calls.every(call => ['management_data', 'resource_list', 'resource_runtime'].includes(call.action)));
  await f.dispose();
  const restored = await fixture({ draft, read: readPanel });
  const restoredPanel = restored.pane().querySelector('.resource-panel')!;
  assert.equal(restoredPanel.querySelector<HTMLInputElement>('[aria-label="搜索工具"]')!.value, 'Example');
  assert.equal(restoredPanel.querySelector<HTMLInputElement>('.resource-editor input')!.value, 'Unsaved tool name');
  assert(restoredPanel.querySelector('.resource-detail'), 'the selected tool detail restores without invoking it');
  assert(restored.calls.every(call => ['management_data', 'resource_list', 'resource_runtime'].includes(call.action)));
});

test('actual Skill detail loads resource relationships only on demand with the selected Skill identity', async () => {
  const current = snapshot();
  const state = { ...current, skills: current.skills.map(skill => ({ ...skill, localPath: undefined })) };
  const alpha = { kind: 'skill', id: 'alpha', name: 'alpha-original', exists: true, ownership: 'unknown', shared: false };
  const tool = { kind: 'tool', id: 'tool-one', name: 'Example Tool', exists: true, ownership: 'external', shared: false };
  const f = await fixture({
    state,
    draft: { libraryMode: 'details', selectedId: 'alpha', tab: 'source' },
    read: (action, args) => {
      assert.equal(action, 'resource_relations', 'expanding relationships does not start a tool or modify management data');
      assert.deepEqual(args, { endpoint: { kind: 'skill', id: 'alpha' } });
      return { revision: 3, endpoint: alpha, dependencies: [{ id: 'link', dependent: alpha, dependency: tool, createdAt: '' }], dependents: [], candidates: [tool] };
    },
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 35)); });
  const detail = f.pane().querySelector('.skill-detail')!;
  assert(detail);
  const expand = button(detail, '依赖关系');
  assert(expand, 'Skill detail exposes the same relationship component as tools');
  assert.equal(f.calls.filter(call => call.action === 'resource_relations').length, 0);
  await click(expand);
  assert.match(detail.querySelector('[aria-label="资源依赖关系"]')!.textContent!, /Example Tool/);
  assert.equal(f.calls.filter(call => call.action === 'resource_relations').length, 1);
  assert.equal(JSON.stringify(f.state), f.original, 'the original Skill state is not modified to store relationships');
});

const originalSkillSource = { sourceId: 'old-source', repo: 'original/skills', branch: 'main', remotePath: 'skills/alpha', commit: 'installed-sha' };
const currentSkillSource = { sourceId: 'current-source', repo: 'current/skills', branch: 'main', remotePath: 'skills/alpha', commit: 'current-sha' };
const nextSkillSource = { sourceId: 'next-source', repo: 'next/skills', branch: 'stable', remotePath: 'tools/alpha', commit: 'next-sha' };
function sourceSnapshot() {
  return { ...snapshot(), skills: [{ ...snapshot().skills[0], ...currentSkillSource, installedCommit: 'installed-sha', installedProvenance: originalSkillSource }, { id: 'remote-alpha', name: 'remote-alpha', ...nextSkillSource }], sources: [{ id: currentSkillSource.sourceId, repo: currentSkillSource.repo }, { id: nextSkillSource.sourceId, repo: nextSkillSource.repo }] } as ReturnType<typeof snapshot>;
}
const associationPreview = () => ({ id: 'association-preview', kind: 'associate', skillId: 'alpha', summary: '核对并确认 Skill 来源关联', files: [], canApply: true, previousSource: currentSkillSource, targetSource: nextSkillSource, installedProvenance: originalSkillSource, warnings: ['本地文件、身份和原安装记录保持。'] });

test('an already associated Skill opens a new source preview and confirms only its preview ID', async () => {
  const initial = await fixture({ state: sourceSnapshot(), draft: { libraryMode: 'details', selectedId: 'alpha', tab: 'source' } });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
  const detail = initial.pane().querySelector('.skill-detail')!; assert(button(detail, '重新关联 GitHub'));
  assert(detail.querySelector('[aria-label="原安装来源"]')!.textContent!.includes('original/skills'));
  await click(button(detail, '重新关联 GitHub')); assert.equal(initial.opened.length, 1);
  assert.equal(initial.opened[0].draft.associateSource, 'current-source'); const draft = initial.opened[0].draft; await initial.dispose();
  const pending = deferred<ReturnType<typeof snapshot>>();
  const f = await fixture({ state: sourceSnapshot(), operation: true, draft, read: (action, args) => {
    if (action === 'preview_associate') { assert.deepEqual(args, { skillId: 'alpha', sourceId: 'next-source', remotePath: 'tools/alpha' }); return associationPreview(); }
    assert.equal(action, 'apply_associate'); assert.deepEqual(args, { previewId: 'association-preview' }); return pending.promise;
  } });
  await choose(f.pane().querySelector<HTMLSelectElement>('[aria-label="关联 GitHub 来源"]')!, 'next-source');
  await choose(f.pane().querySelector<HTMLSelectElement>('[aria-label="关联远端 Skill"]')!, 'remote-alpha'); await click(button(f.pane(), '预览关联'));
  assert(f.pane().textContent!.includes('预览 Skill 来源关联'));
  for (const [label, repo] of [['原关联', 'current/skills'], ['新关联', 'next/skills'], ['原安装来源', 'original/skills']]) assert(f.pane().querySelector(`[aria-label="${label}"]`)!.textContent!.includes(repo));
  assert.equal(f.pane().querySelector('.preview-layout'), null); assert.equal(f.calls.filter(call => call.action === 'apply_associate').length, 0);
  await act(async () => { button(f.pane(), '确认保存关联').click(); button(f.pane(), '确认保存关联').click(); });
  assert.equal(f.calls.filter(call => call.action === 'apply_associate').length, 1);
  await act(async () => pending.resolve({ ...sourceSnapshot(), stateRevision: 2 }));
  assert(!f.calls.some(call => call.action === 'associate' || /download|install/.test(call.action)));
});

test('Basic mode disables re-association and a restored association confirmation cannot submit', async () => {
  const state = { ...sourceSnapshot(), startup: { basicMode: true } };
  const f = await fixture({ state, draft: { libraryMode: 'details', selectedId: 'alpha', tab: 'source' } });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
  assert.equal(button(f.pane(), '重新关联 GitHub').disabled, true); assert.equal(button(f.pane(), '检查来源健康').disabled, true);
  await click(button(f.pane(), '重新关联 GitHub')); assert.equal(f.opened.length, 0); await f.dispose();
  const restored = await fixture({ state, operation: true, draft: { modal: { kind: 'preview', preview: associationPreview() } } });
  assert.equal(button(restored.pane(), '确认保存关联').disabled, true); await click(button(restored.pane(), '确认保存关联'));
  assert(!restored.calls.some(call => /associate/.test(call.action)));
});

test('failed association apply invalidates only its preview and preserves the chosen source draft', async () => {
  const f = await fixture({ state: sourceSnapshot(), operation: true, draft: { modal: { kind: 'preview', preview: associationPreview() }, associateSource: 'next-source', associateSkill: 'remote-alpha' }, read: action => { assert.equal(action, 'apply_associate'); throw new Error('来源已变化，请重新预览'); } });
  await click(button(f.pane(), '确认保存关联'));
  assert.equal(button(f.pane(), '确认保存关联').disabled, true); assert(f.pane().textContent!.includes('此预览已失效'));
  const draft = f.bridges.get('home-0')!.capture(); assert.equal(draft.associateSource, 'next-source'); assert.equal(draft.associateSkill, 'remote-alpha');
  assert.equal(JSON.stringify(f.state), f.original);
});

test('actual Skill source health uses the selected identity and discards results after re-association', async () => {
  const pending = deferred<unknown>(); let reads = 0;
  const f = await fixture({ state: sourceSnapshot(), draft: { libraryMode: 'details', selectedId: 'alpha', tab: 'source' }, read: (action, args) => {
    assert.equal(action, 'skill_source_health'); assert.deepEqual(args, { skillId: 'alpha' });
    return ++reads === 1 ? { skillId: 'alpha', source: currentSkillSource, health: { status: 'reachable', message: '仅核对来源', checkedAt: '2026-10-30T00:00:00Z' } } : pending.promise;
  } });
  await click(button(f.pane(), '检查来源健康')); assert(f.pane().querySelector('[aria-label="来源健康与安装记录"] [role="status"]')!.textContent!.includes('可访问'));
  await click(button(f.pane(), '检查来源健康'));
  await f.updateSnapshot({ ...sourceSnapshot(), stateRevision: 2, skills: sourceSnapshot().skills.map(skill => skill.id === 'alpha' ? { ...skill, ...nextSkillSource } : skill) });
  await act(async () => pending.resolve({ skillId: 'alpha', source: currentSkillSource, health: { status: 'reachable', message: '迟到的旧来源', checkedAt: '' } }));
  assert.equal(f.pane().querySelector('[aria-label="来源健康与安装记录"] [role="status"]'), null); assert.equal(reads, 2);
  assert(f.pane().querySelector('[aria-label="原安装来源"]')!.textContent!.includes('original/skills'));
});

test('standalone Skill documentation defers export selection until needed and keeps it across tabs and handoff', async () => {
  const draft = { id: 'export-alpha', skillId: 'alpha', revision: 2, selectedIds: ['file:guide.md'], version: 4 };
  const nativeRead = (action: string) => {
    if (action === 'get_document') return { markdown: '# 本地说明', documentPath: 'SKILL.md', source: '本地运行文件' };
    if (action === 'workspace_get_export_selection') return { draft, leaseId: 'lease-alpha' };
    if (action === 'workspace_read_export_selection') return { draft, version: draft.version, leaseValid: true };
    if (action === 'workspace_release_export_selection') return { released: true };
    if (action === 'get_files') return { files: [], runtimeConfirmed: true };
    if (action === 'get_export_plan') return { id: 'plan-alpha', skillId: 'alpha', resources: [], manifest: [], canExport: true, issues: [],
      summary: { required: 0, optionalPackageSelected: 1, optionalPackageTotal: 1, optionalExternalSelected: 0, optionalExternalTotal: 0, generated: 0, total: 1, remoteCount: 0, bytes: 0 } };
    throw new Error(`Unexpected request: ${action}`);
  };
  const f = await fixture({ detailSkillId: 'alpha', nativeRead });
  const leaseCalls = () => f.calls.filter(call => call.action.startsWith('workspace_') && call.action.endsWith('_export_selection'));
  assert.equal(f.calls.filter(call => call.action === 'get_document').length, 1);
  assert.deepEqual(leaseCalls(), []);
  assert(await f.bridges.get('home-0')!.flush());
  assert.deepEqual(leaseCalls(), [], 'a read-only detail pane has no export lease to flush');

  await click(button(f.pane(), '导出'));
  assert.equal(f.opened.length, 1);
  const exportModal = f.opened[0].modal as { kind: string; skill: { id: string } };
  assert.equal(exportModal.kind, 'export');
  assert.equal(exportModal.skill.id, 'alpha');
  assert.deepEqual(leaseCalls(), [], 'the separate export page owns its lazy entry');

  await click(button(f.pane(), '文件'));
  assert.equal(leaseCalls().filter(call => call.action === 'workspace_get_export_selection').length, 1);
  assert(f.calls.some(call => call.action === 'get_export_plan' && (call.args as { selectedIds: string[] }).selectedIds.includes('file:guide.md')));
  await click(button(f.pane(), '说明'));
  assert(!leaseCalls().some(call => call.action === 'workspace_release_export_selection'));
  const handoff = f.bridges.get('home-0')!.capture();
  assert.equal(handoff.exportLeaseSkillId, 'alpha');
  await click(button(f.pane(), '文件'));
  assert.equal(leaseCalls().filter(call => call.action === 'workspace_get_export_selection').length, 1);

  await f.dispose();
  const restored = await fixture({ detailSkillId: 'alpha', draft: handoff, nativeRead });
  assert.equal(restored.calls.filter(call => call.action === 'workspace_get_export_selection').length, 1, 'restoring an active draft in the description tab resumes its lease');
});

test('unchanged Skill documentation keeps focused links, images and code across workspace renders', async () => {
  let assetReads = 0;
  const state = { ...snapshot(), readGeneration: 1 };
  const f = await fixture({ state, detailSkillId: 'alpha', nativeRead: (action, request) => {
    if (action === 'get_doc_asset') return { dataUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=#' + ++assetReads };
    assert.equal(action, 'get_document');
    if ((request as { path?: string }).path === 'notes.md') {
      return { markdown: '相对文档内容', documentPath: 'notes.md', source: '本地运行文件' };
    }
    return { markdown: '[相对文档](notes.md)\n\n![本地图片](chart.png)\n\n```txt\nsample\n```', documentPath: 'SKILL.md', source: '本地运行文件' };
  } });
  const pane = f.pane();
  for (let attempt = 0; attempt < 30 && !pane.querySelector('article.markdown img'); attempt++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  const link = pane.querySelector<HTMLAnchorElement>('article.markdown a[href="notes.md"]');
  const image = pane.querySelector('article.markdown img');
  const copy = pane.querySelector('article.markdown button[aria-label="复制代码"]');
  assert(link && image && copy);
  link.focus();
  await f.updatePaneState({ focusRevision: 1, section: 'docs' });
  assert(pane.querySelector('article.markdown a[href="notes.md"]') === link);
  assert(document.activeElement === link);
  assert(pane.querySelector('article.markdown img') === image);
  assert(pane.querySelector('article.markdown button[aria-label="复制代码"]') === copy);
  assert.equal(f.calls.filter(call => call.action === 'get_doc_asset').length, 1);
  await click(pane.querySelector('button[aria-label="刷新说明"]')!);
  assert.equal(assetReads, 2);
  assert.match(pane.querySelector('article.markdown img')?.getAttribute('src') || '', /#2$/);
  assert(pane.querySelector('article.markdown a[href="notes.md"]') === link);
  await click(link);
  assert.match(pane.querySelector('article.markdown')?.textContent || '', /相对文档内容/);
});

test('historical document relative assets open from the returned document source rather than the rebound Skill repository', async () => {
  const f = await fixture({ state: sourceSnapshot(), draft: { libraryMode: 'details', selectedId: 'alpha', tab: 'docs', version: 'installed' }, nativeRead: action => {
    assert.equal(action, 'get_document'); return { markdown: '[历史图片](images/example.png)', documentPath: 'skills/alpha/README.md', source: 'original/skills', commit: 'installed-sha', checkedAt: '' };
  } });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 35)); });
  const link = [...f.pane().querySelectorAll('article.markdown a')].find(node => node.textContent?.includes('历史图片'))!; assert(link); await click(link);
  const open = f.calls.find(call => call.action === 'openUrl')!; assert(open); assert.deepEqual(open.args, ['https://github.com/original/skills/blob/installed-sha/skills/alpha/images/example.png']);
});

test('local document relative assets do not fall back to the associated repository', async () => {
  const f = await fixture({ state: sourceSnapshot(), draft: { libraryMode: 'details', selectedId: 'alpha', tab: 'docs', version: 'installed' }, nativeRead: action => {
    assert.equal(action, 'get_document'); return { markdown: '[本地图片](images/local.png)', documentPath: 'README.md', source: '本地运行文件', checkedAt: '' };
  } });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 35)); });
  const link = [...f.pane().querySelectorAll('article.markdown a')].find(node => node.textContent?.includes('本地图片'))!; assert(link); await click(link);
  assert(!f.calls.some(call => call.action === 'openUrl')); assert(f.pane().textContent!.includes('请在文件页或外部编辑器中打开该文件'));
});

test('actual App keeps scenes inside existing settings and restores an unsaved scene draft without replaying writes', async () => {
  const sceneData = { revision: 4, activeSceneId: null, scenes: [], candidates: [{ kind: 'skill', id: 'alpha', name: 'alpha-original', exists: true, enabled: true, sceneEligible: true, effectiveEnabled: true, sceneReason: '' }] };
  const f = await fixture({ draft: { view: 'settings' }, read: action => { assert.equal(action, 'resource_scenes'); return sceneData; } });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 35)); });
  assert.equal(f.pane().querySelector('[aria-label="场景设置"]'), null, 'unvisited settings groups should not mount their readers');
  await click(f.pane().querySelector('.settings-navigation-toggle')!);
  await click(button(f.pane().querySelector('[aria-label="设置分类"]')!, '场景'));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 35)); });
  const scenes = f.pane().querySelector('[aria-label="场景设置"]')!; assert(scenes); assert(scenes.closest('[aria-label="偏好设置"]'));
  assert.equal(scenes.closest<HTMLElement>('[data-settings-section="scenes"]')!.hidden, false);
  assert(!f.calls.some(call => call.action === 'resource_scenes')); await click(button(scenes, '管理场景')); await click(button(scenes, '新建场景'));
  await change(scenes.querySelector<HTMLInputElement>('[aria-label="场景名称"]')!, '未提交场景');
  await click(button(f.pane().querySelector('[aria-label="设置分类"]')!, '常规'));
  const groupReads = f.calls.filter(call => call.action === 'resource_scenes').length;
  await f.updateSnapshot({ ...snapshot(), stateRevision: 2 });
  assert.equal(f.calls.filter(call => call.action === 'resource_scenes').length, groupReads, 'hidden settings groups do not refresh');
  assert.equal(scenes.closest<HTMLElement>('[data-settings-section="scenes"]')!.hidden, true);
  assert.equal(scenes.querySelector<HTMLInputElement>('[aria-label="场景名称"]')!.value, '未提交场景');
  await click(button(f.pane().querySelector('[aria-label="设置分类"]')!, '场景'));
  assert.equal(f.calls.filter(call => call.action === 'resource_scenes').length, groupReads + 1);
  await click(f.pane().querySelector('button.nav-item[aria-label="Skills"]')!);
  const reads = f.calls.filter(call => call.action === 'resource_scenes').length;
  await f.updateSnapshot({ ...snapshot(), stateRevision: 3 }); assert.equal(f.calls.filter(call => call.action === 'resource_scenes').length, reads);
  await click(f.pane().querySelector('button.nav-item[aria-label="设置"]')!);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 35)); });
  assert.equal(f.pane().querySelector<HTMLInputElement>('[aria-label="场景名称"]')!.value, '未提交场景');
  assert.equal(f.bridges.get('home-0')!.capture().sceneDraft.editor.name, '未提交场景');
  assert.equal(f.calls.filter(call => call.action === 'resource_scenes').length, reads + 1); assert(!f.calls.some(call => /^resource_scene_/.test(call.action)));
});

test('visited storage settings defer hidden state events and preserve the edited destination on catch-up', async () => {
  const storage = { managedRoot: 'D:/synthetic/manager', config: { managedRoot: 'D:/synthetic/manager', overrides: {} }, systemManaged: [], atomicTemporary: 'D:/synthetic/temp', paths: Object.fromEntries(['state', 'webview', 'recovery', 'receipts', 'temp', 'newSkill', 'export'].map(kind => [kind, { effective: `D:/synthetic/${kind}`, source: 'fixture', locked: false, restartRequired: kind === 'state' }])) };
  const f = await fixture({ draft: { view: 'settings', settingsSection: 'storage' }, nativeRead: action => { assert.equal(action, 'storage_get'); return { storage }; } });
  const input = f.pane().querySelector<HTMLInputElement>('.storage-settings input')!;
  assert(input);
  await change(input, 'D:/synthetic/unsaved-destination');
  await click(f.pane().querySelector('.settings-navigation-toggle')!);
  await click(button(f.pane().querySelector('[aria-label="设置分类"]')!, '常规'));
  const reads = f.calls.filter(call => call.action === 'storage_get').length;
  await f.emitNative('state-changed', { stateRevision: 2 });
  await f.emitNative('state-changed', { stateRevision: 3 });
  assert.equal(f.calls.filter(call => call.action === 'storage_get').length, reads);
  await click(button(f.pane().querySelector('[aria-label="设置分类"]')!, '保存位置'));
  assert.equal(f.calls.filter(call => call.action === 'storage_get').length, reads + 1);
  assert.equal(input.value, 'D:/synthetic/unsaved-destination');
  assert(f.calls.every(call => ['management_data', 'storage_get'].includes(call.action)));
});

test('actual Skill detail explains scene exclusion without claiming to disable native client use', async () => {
  const state = { ...snapshot(), skills: snapshot().skills.map(skill => ({ ...skill, sceneEligible: false, effectiveEnabled: false, sceneReason: '当前场景未包含此 Skill。' })) };
  const f = await fixture({ state, draft: { libraryMode: 'details', selectedId: 'alpha', tab: 'source' } });
  const detail = f.pane().querySelector('.skill-detail')!; assert(detail.textContent!.includes('当前场景未包含此 Skill')); assert(detail.textContent!.includes('不阻断原生客户端使用 Skill'));
  assert(!f.calls.some(call => /scene|invoke|disconnect/.test(call.action)));
});
