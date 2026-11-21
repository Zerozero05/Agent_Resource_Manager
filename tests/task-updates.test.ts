import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act, createElement, StrictMode, useEffect } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const listeners = new Map<string, Set<(event: any) => void>>();
let registration: ((name: string, listener: (event: any) => void) => Promise<() => void>) | undefined;
let response: any;
let initialTasks: any[] = [];
let started: any;
let calls: any[] = [];
Object.assign(globalThis, { taskHarness: {
  listen: async (name: string, listener: (event: any) => void) => {
    if (registration) return registration(name, listener);
    const handlers = listeners.get(name) || new Set(); handlers.add(listener); listeners.set(name, handlers);
    return () => { handlers.delete(listener); if (!handlers.size) listeners.delete(name); };
  },
  isTauri: () => true,
  invoke: async (_command: string, { request }: any) => {
    calls.push(request);
    if (request.action === 'list_tasks') return { tasks: initialTasks };
    if (request.action === 'start_task') return { task: typeof started === 'function' ? await started(request) : started };
    if (request.action === 'get_task') return { task: typeof response === 'function' ? await response(request) : response };
    throw new Error(`Unexpected request: ${request.action}`);
  },
} });
let code = ts.transpileModule(await readFile(new URL('../src/tasks.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
code = code.replace(/import[^;]+from ['"]@tauri-apps\/api\/(?:event|core)['"];?/g, '').replace(/from ['"]react['"]/g, `from ${JSON.stringify(import.meta.resolve('react'))}`);
const { useTasks } = await import(`data:text/javascript;base64,${Buffer.from('const { listen, isTauri, invoke } = globalThis.taskHarness;\n' + code).toString('base64')}`);
let root: ReturnType<typeof createRoot>;
let current: any;
let commits = 0;
function Probe() { current = useTasks(); useEffect(() => { commits++; }, [current.tasks]); return createElement('span', null, current.tasks.map((task: any) => task.stage).join(',')); }
async function setup(strict = false) {
  root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(strict ? createElement(StrictMode, null, createElement(Probe)) : createElement(Probe)));
  commits = 0;
}
afterEach(async () => { await act(async () => root?.unmount()); listeners.clear(); registration = undefined; initialTasks = []; calls = []; started = undefined; response = undefined; });
const task = (patch = {}) => ({ id: 'one', action: 'get_document', label: '读取说明', status: 'running', stage: '读取中', createdAt: '2026-11-03T00:00:00Z', origin: { paneId: 'skill-one' }, cancellable: true, ...patch });
const emitNative = async (name: string, payload: any) => act(async () => { for (const listener of listeners.get(name) || []) listener({ payload }); });
const emit = (value: any) => emitNative('task-updated', { task: structuredClone(value) });
const readCount = () => calls.filter(call => call.action === 'get_task').length;
const summary = ({ resources: _resources, result: _result, ...value }: any) => value;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test('repeated task notifications do not commit unchanged workspace state', async () => {
  await setup();
  await emit(task());
  const previous = current.tasks;
  const before = commits;
  for (let index = 0; index < 100; index++) await emit(task());
  assert.equal(commits, before, 'identical event/poll metadata must not repaint workspace consumers');
  assert.equal(current.tasks, previous);
  await emit(task({ stage: '读取 2 / 3', progress: { completed: 2, total: 3 } }));
  assert.equal(current.tasks[0].progress.completed, 2);
  assert.equal(commits, before + 1);
});

test('metadata notifications retain loaded results but expiry removes them', async () => {
  await setup();
  response = task({ status: 'succeeded', stage: '完成', resultAvailable: true, result: { document: 'complete body' } });
  await act(async () => current.inspect('one'));
  const result = current.tasks[0].result;
  const before = commits;
  await emit(task({ status: 'succeeded', stage: '完成', resultAvailable: true }));
  assert.equal(current.tasks[0].result, result);
  assert.equal(commits, before);
  await emit(task({ status: 'succeeded', stage: '完成', resultAvailable: false, resultExpired: true }));
  assert.equal(current.tasks[0].result, undefined);
  assert.equal(current.tasks[0].resultExpired, true);
});

test('late running events cannot replace completion and hidden tasks disappear', async () => {
  await setup();
  await emit(task({ status: 'succeeded', stage: '完成' }));
  const before = commits;
  await emit(task());
  assert.equal(current.tasks[0].status, 'succeeded');
  assert.equal(commits, before);
  await emit(task({ status: 'succeeded', stage: '完成', hidden: true }));
  assert.deepEqual(current.tasks, []);
});

const schedulingResources = ['state', 'catalogue', ...Array.from({ length: 1000 }, (_, index) => [
  `skill:perf-skill-${String(index).padStart(4, '0')}`,
  `path:D:/03_github_projects/Agent_Resource_Manager/validation/resources/performance/skills/perf-skill-${String(index).padStart(4, '0')}`,
]).flat()];
const checkTask = (patch = {}) => task({ action: 'check_now', label: '检查变化', status: 'succeeded', stage: '完成', resultAvailable: true, resources: schedulingResources, ...patch });
const largeSnapshot = (generation: number) => ({ stateRevision: generation, skills: Array.from({ length: 1000 }, (_, index) => ({ id: `skill-${index}`, description: `${generation}:${index}:${'完整本地说明'.repeat(160)}` })), sources: [], connections: [] });

test('completed checks keep readable metadata without retaining full snapshots or scheduling keys', async context => {
  await setup();
  for (let index = 0; index < 105; index++) await emit(checkTask({ id: `check-${index}`, createdAt: `2026-11-03T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}Z`, result: largeSnapshot(index) }));
  assert.equal(current.tasks.length, 100, 'normal task history remains bounded and visible');
  assert.equal(schedulingResources.length, 2002);
  assert(current.tasks.every((item: any) => item.result === undefined && item.resources === undefined && item.resultAvailable === true && item.action === 'check_now'));
  const retainedBytes = Buffer.byteLength(JSON.stringify(current.tasks));
  const schedulingBytes = Buffer.byteLength(JSON.stringify(current.tasks.map((item: any) => ({ ...item, resources: schedulingResources }))));
  assert(retainedBytes < 100000, 'task metadata must not retain full application snapshots or scheduling keys');
  assert(schedulingBytes > retainedBytes * 100, 'the regression fixture must exercise the real thousand-Skill scheduling scale');
  context.diagnostic(JSON.stringify({ retainedChecks: current.tasks.length, schedulingKeysPerInput: schedulingResources.length, metadataWithSchedulingBytes: schedulingBytes, retainedListBytes: retainedBytes }));
  assert(current.tasks.some((item: any) => item.id === 'check-104'), 'the latest readable task identity stays available');
});

test('run returns the full check result while the subscribed task list keeps only its metadata', async () => {
  const snapshot = largeSnapshot(7);
  started = checkTask({ id: 'check-run', status: 'queued', resultAvailable: false, result: undefined });
  response = checkTask({ id: 'check-run', result: snapshot });
  await setup();
  let result: any;
  await act(async () => { result = await current.run('检查变化', 'check_now', {}, { view: 'changes' }); });
  assert.equal(result, snapshot, 'the snapshot consumer receives the original complete result');
  assert.equal(result.skills.length, 1000);
  assert.equal(response.resources, schedulingResources, 'run leaves the original response scheduling keys intact');
  assert.equal(current.tasks[0].id, 'check-run');
  assert.equal(current.tasks[0].result, undefined);
  assert.equal(current.tasks[0].resources, undefined);
  assert.equal(current.tasks[0].resultAvailable, true);
  assert.equal(calls.filter(call => call.action === 'start_task').length, 1);
  assert.equal(calls.filter(call => call.action === 'get_task').length, 1);
});


test('global check waits on compact status and returns the terminal stamp without rereading it', async () => {
  const stamp = { stateRevision: 17, readGeneration: 4 };
  started = summary(checkTask({ status: 'queued', resultAvailable: false }));
  response = summary(checkTask({ completionStamp: stamp }));
  await setup();
  let received: unknown;
  await act(async () => { received = await current.runCheck('检查变化', { view: 'changes' }); });
  assert.deepEqual(received, stamp);
  assert.deepEqual(calls.slice(1), [
    { action: 'start_task', request: { action: 'check_now' }, label: '检查变化', origin: { view: 'changes' }, foreground: true, statusOnly: true },
    { action: 'get_task', taskId: 'one', statusOnly: true },
  ]);
  assert.equal(current.tasks[0].status, 'succeeded');
  assert.equal(current.tasks[0].completionStamp, undefined);
  assert.equal(current.tasks[0].resources, undefined);
  assert.equal(current.tasks[0].result, undefined);
});

test('partial check completion from a stamp-less event reads compact status once for its stamp', async () => {
  const stamp = { stateRevision: 18, readGeneration: null };
  started = summary(checkTask({ status: 'queued', resultAvailable: false }));
  response = summary(checkTask({ status: 'running', resultAvailable: false }));
  await setup();
  let running!: Promise<unknown>;
  await act(async () => { running = current.runCheck('检查变化', {}); });
  assert.equal(readCount(), 1);
  response = summary(checkTask({ status: 'partial', completionStamp: stamp }));
  await emit(summary(checkTask({ status: 'partial' })));
  assert.deepEqual(await running, stamp);
  assert.equal(readCount(), 2);
  assert(calls.filter(call => call.action === 'get_task').every(call => call.statusOnly === true));
  assert.equal(current.tasks[0].status, 'partial');
});

test('global check without a terminal stamp completes for the caller to refresh once', async () => {
  started = summary(checkTask({ status: 'queued', resultAvailable: false }));
  response = summary(checkTask({ status: 'partial' }));
  await setup();
  await act(async () => { assert.equal(await current.runCheck('检查变化', {}), null); });
  assert.equal(readCount(), 1);
});

test('compact global check keeps cancellation and failure visible without returning completion', async () => {
  await setup();
  for (const [status, message] of [['cancelled', '任务已取消'], ['failed', '检查目录不可读']] as const) {
    started = summary(checkTask({ id: status, status: 'queued', resultAvailable: false }));
    response = summary(checkTask({ id: status, status, error: message, resultAvailable: false }));
    await act(async () => { await assert.rejects(current.runCheck('检查变化', {}), { message }); });
    assert.equal(current.tasks.find((item: any) => item.id === status).status, status);
  }
  assert.equal(readCount(), 2);
  assert(calls.filter(call => call.action === 'get_task').every(call => call.statusOnly === true));
});

test('explicit check inspection returns the full original result without pinning it in history', async () => {
  const snapshot = largeSnapshot(8);
  response = checkTask({ result: snapshot });
  await setup();
  let inspected: any;
  await act(async () => { inspected = await current.inspect('one'); });
  assert.equal(inspected, response, 'resumed tasks and explicit result dialogs receive the unmodified task');
  assert.equal(inspected.result, snapshot);
  assert.equal(inspected.resources, schedulingResources);
  assert.equal(current.tasks[0].result, undefined);
  assert.equal(current.tasks[0].resources, undefined);
  assert.equal(current.tasks[0].resultAvailable, true);
  const identity = current.tasks;
  const before = commits;
  for (let index = 0; index < 20; index++) await emit(checkTask({ result: largeSnapshot(8) }));
  assert.equal(commits, before, 'fresh large result objects in identical notifications must not repaint consumers');
  assert.equal(current.tasks, identity);
  response = checkTask({ resultAvailable: false, resultExpired: true });
  await act(async () => { inspected = await current.inspect('one'); });
  assert.equal(inspected.resultExpired, true);
  assert.equal(current.tasks[0].resultAvailable, false);
  assert.equal(current.tasks[0].resultExpired, true);
  assert.equal(current.tasks[0].result, undefined);
});

test('check failures and failed inspections preserve errors without inventing a retained snapshot', async () => {
  started = checkTask({ status: 'queued', resultAvailable: false, result: undefined });
  response = checkTask({ status: 'failed', error: '检查目录不可读', resultAvailable: false, result: undefined });
  await setup();
  await act(async () => { await assert.rejects(current.run('检查变化', 'check_now', {}, {}), /检查目录不可读/); });
  assert.equal(current.tasks[0].error, '检查目录不可读');
  assert.equal(current.tasks[0].resultAvailable, false);
  const previous = current.tasks;
  response = () => { throw new Error('任务读取失败'); };
  await act(async () => { await assert.rejects(current.inspect('one'), /任务读取失败/); });
  assert.equal(current.tasks, previous, 'a failed explicit read cannot erase history metadata');
});

test('list hydration and history-clear replacement also avoid pinning check snapshots', async () => {
  const document = { markdown: '完整说明正文' };
  initialTasks = [checkTask({ result: largeSnapshot(9) }), task({ id: 'document', status: 'succeeded', resultAvailable: true, result: document })];
  await setup();
  assert.equal(current.tasks.find((item: any) => item.id === 'one').result, undefined);
  assert.equal(current.tasks.find((item: any) => item.id === 'one').resources, undefined);
  assert.equal(current.tasks.find((item: any) => item.id === 'document').result, document, 'non-check results stay intact on hydration');
  await emitNative('task-history-cleared', { clearedTaskIds: ['one'], tasks: [checkTask({ id: 'check-retained', result: largeSnapshot(10) }), task({ id: 'document', status: 'succeeded', resultAvailable: true, result: document })] });
  assert(!current.tasks.some((item: any) => item.id === 'one'));
  assert.equal(current.tasks.find((item: any) => item.id === 'check-retained').result, undefined);
  assert.equal(current.tasks.find((item: any) => item.id === 'check-retained').resources, undefined);
  assert.equal(current.tasks.find((item: any) => item.id === 'document').result, document);
});

test('only check results are omitted; previews, exports and document results stay available', async () => {
  await setup();
  for (const action of ['get_document', 'preview_update', 'export', 'connect_batch']) {
    const result = { action, markdown: '完整正文', canApply: true, path: 'D:/synthetic/output.zip', connectionResults: [{ id: 'generated', success: true }] };
    response = task({ id: action, action, status: 'succeeded', resultAvailable: true, result, resources: schedulingResources,
      origin: { resourceId: 'generated-tool' }, progress: { completed: 3, total: 4 },
      resultFiles: [{ id: 'generated-result', label: '输出', path: 'D:/synthetic/output.zip' }], legacyMetadata: { retained: true } });
    await act(async () => { const inspected = await current.inspect(action); assert.equal(inspected, response); assert.equal(inspected.result, result); assert.equal(inspected.resources, schedulingResources); });
    const { resources: _resources, ...expected } = response;
    assert.deepEqual(current.tasks.find((item: any) => item.id === action), expected, 'all other metadata and non-check results remain intact');
    await emit(task({ id: action, action, status: 'succeeded', resultAvailable: true }));
    assert.equal(current.tasks.find((item: any) => item.id === action).result, result, 'metadata updates retain non-check previews');
  }
});

test('progress events advance a run without rereading its 2002 scheduling keys', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const snapshot = largeSnapshot(12);
  started = checkTask({ status: 'queued', stage: '排队', resultAvailable: false, result: undefined, legacyMetadata: { complete: true } });
  response = checkTask({ status: 'running', stage: '读取', resultAvailable: false, result: undefined });
  await setup();
  let running!: Promise<any>, acknowledged: any;
  await act(async () => { running = current.run('检查变化', 'check_now', {}, {}, true, (value: any) => { acknowledged = value; }); });
  assert.equal(acknowledged, started, 'onStarted receives the original complete start response');
  assert.equal(acknowledged.resources, schedulingResources);
  assert.deepEqual(acknowledged.legacyMetadata, { complete: true });
  assert.equal(readCount(), 1);
  for (let completed = 1; completed <= 30; completed++) {
    await act(async () => context.mock.timers.tick(650));
    await emit(summary(checkTask({ status: 'running', stage: `读取 ${completed}`, progress: { completed, total: 30 }, resultAvailable: false })));
  }
  assert.equal(readCount(), 1, 'progress events must not trigger another bulk get_task');
  response = checkTask({ result: snapshot });
  await emit(summary(response));
  assert.equal(await running, snapshot);
  assert.equal(readCount(), 2, 'only initial catch-up and the complete terminal result are read');
  await act(async () => context.mock.timers.tick(5000));
  assert.equal(readCount(), 2, 'completion removes the fallback timer');
  assert.equal(response.resources, schedulingResources);
  assert.equal(current.tasks[0].status, 'succeeded');
  context.diagnostic(JSON.stringify({ progressEvents: 30, schedulingKeysPerResponse: schedulingResources.length, fullTaskReads: readCount() }));
});

test('missing notifications retain the 700ms fallback and clean it after completion', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const result = { markdown: '完整结果' };
  started = task({ status: 'queued' });
  response = () => task(readCount() < 3 ? {} : { status: 'succeeded', resultAvailable: true, result });
  await setup();
  let running!: Promise<any>;
  await act(async () => { running = current.run('读取', 'get_document', {}, {}); });
  assert.equal(readCount(), 1);
  await act(async () => context.mock.timers.tick(699)); assert.equal(readCount(), 1);
  await act(async () => context.mock.timers.tick(1)); assert.equal(readCount(), 2);
  await act(async () => context.mock.timers.tick(700)); assert.equal(await running, result);
  assert.equal(readCount(), 3);
  await act(async () => context.mock.timers.tick(5000)); assert.equal(readCount(), 3);
  assert.equal(calls.filter(call => call.action === 'start_task').length, 1);
});

test('terminal notification before the start acknowledgement survives unrelated and late running events', async () => {
  const acknowledgement = deferred<any>(), result = { markdown: '先完成' };
  const original = task({ status: 'queued', resources: schedulingResources });
  started = () => acknowledgement.promise;
  response = task({ status: 'succeeded', resultAvailable: true, result, resources: schedulingResources });
  await setup();
  let running!: Promise<any>, acknowledged: any;
  await act(async () => { running = current.run('读取', 'get_document', {}, {}, true, (value: any) => { acknowledged = value; }); });
  await emit(summary(response)); await emit(task()); await emit(task({ id: 'unrelated' }));
  await act(async () => acknowledgement.resolve(original));
  assert.equal(await running, result);
  assert.equal(acknowledged, original);
  assert.equal(readCount(), 1, 'an early terminal event needs only its complete result read');
  assert.equal(current.tasks.find((item: any) => item.id === 'one').status, 'succeeded');
});

test('terminal events during an in-flight read cannot regress to its older running response', async () => {
  const first = deferred<any>(), result = { markdown: '终态完整结果' };
  started = task({ status: 'queued', resources: schedulingResources });
  response = () => readCount() === 1 ? first.promise : task({ status: 'succeeded', resultAvailable: true, result, resources: schedulingResources });
  await setup();
  let running!: Promise<any>;
  await act(async () => { running = current.run('读取', 'get_document', {}, {}); });
  await emit(task({ status: 'succeeded', stage: '完成', resultAvailable: true }));
  await emit(task({ stage: '晚到的旧运行事件' }));
  await act(async () => first.resolve(task({ stage: '旧读取响应', resources: schedulingResources })));
  assert.equal(await running, result);
  assert.equal(readCount(), 2);
  assert.equal(current.tasks[0].status, 'succeeded');
  assert.notEqual(current.tasks[0].stage, '旧读取响应');
});

test('deduplicated concurrent runs with the same ID both wake on terminal events', { timeout: 5000 }, async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const result = { markdown: '共享后台任务的完整结果' };
  started = task({ status: 'queued', resources: schedulingResources }); response = task({ resources: schedulingResources });
  await setup();
  let first!: Promise<any>, second!: Promise<any>;
  await act(async () => { first = current.run('读取一', 'get_document', {}, {}); second = current.run('读取二', 'get_document', {}, {}); });
  assert.equal(readCount(), 2);
  for (let completed = 1; completed <= 5; completed++) await emit(task({ progress: { completed, total: 5 } }));
  assert.equal(readCount(), 2);
  response = task({ status: 'succeeded', resultAvailable: true, result, resources: schedulingResources });
  await emit(summary(response));
  assert.deepEqual(await Promise.all([first, second]), [result, result]);
  assert.equal(readCount(), 4, 'each caller reads its complete terminal result without losing a wakeup');
  await act(async () => context.mock.timers.tick(5000)); assert.equal(readCount(), 4);
});

for (const [status, error, expected] of [['failed', '读取失败原因', /读取失败原因/], ['interrupted', undefined, /中断阶段/], ['cancelled', '取消原因', /任务已取消/]] as const) {
  test(`${status} events preserve rejection semantics without replaying or redundant result reads`, async () => {
    started = task({ status: 'queued' }); response = task();
    await setup();
    let rejected!: Promise<void>;
    await act(async () => { rejected = assert.rejects(current.run('读取', 'get_document', {}, {}), expected); });
    await emit(task({ status, error, stage: '中断阶段', resultAvailable: false }));
    await rejected;
    assert.equal(calls.filter(call => call.action === 'start_task').length, 1);
    assert.equal(readCount(), 1);
    assert.equal(current.tasks[0].status, status);
  });
}

test('partial and expired terminal results keep their existing return semantics', async () => {
  started = task({ status: 'queued' }); response = task({ status: 'partial', resultAvailable: true, result: { incomplete: true } });
  await setup();
  await act(async () => { assert.deepEqual(await current.run('读取', 'get_document', {}, {}), { incomplete: true }); });
  started = task({ id: 'expired', status: 'queued' });
  response = task({ id: 'expired', status: 'succeeded', resultAvailable: false, resultExpired: true });
  await act(async () => { assert.equal(await current.run('读取', 'get_document', {}, {}), undefined); });
  assert.equal(current.tasks.find((item: any) => item.id === 'expired').resultExpired, true);
});

test('cleared and hidden history cannot strand an active caller or reinsert its result', async () => {
  const result = { markdown: '调用方仍能获得结果' };
  started = task({ status: 'queued' }); response = task();
  await setup();
  let running!: Promise<any>;
  await act(async () => { running = current.run('读取', 'get_document', {}, {}); });
  await emitNative('task-history-cleared', { clearedTaskIds: ['one'], tasks: [] });
  response = task({ status: 'succeeded', hidden: true, resultAvailable: true, result });
  await emit(summary(response));
  assert.equal(await running, result);
  assert.deepEqual(current.tasks, []);
  assert.equal(readCount(), 2);
});

test('a failed fallback read releases its timer and never replays start', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  started = task({ status: 'queued' }); response = task();
  await setup();
  let rejected!: Promise<void>;
  await act(async () => { rejected = assert.rejects(current.run('读取', 'get_document', {}, {}), /连接读取失败/); });
  response = () => { throw new Error('连接读取失败'); };
  await act(async () => context.mock.timers.tick(700)); await rejected;
  const count = readCount();
  await emit(task({ stage: '结束后晚到' }));
  await act(async () => context.mock.timers.tick(5000));
  assert.equal(readCount(), count);
  assert.equal(calls.filter(call => call.action === 'start_task').length, 1);
});

test('StrictMode releases late subscriptions from the disposed effect after remount', async () => {
  const pending: { name: string; listener: (event: any) => void; done: ReturnType<typeof deferred<() => void>>; released: number }[] = [];
  registration = (name, listener) => { const done = deferred<() => void>(); pending.push({ name, listener, done, released: 0 }); return done.promise; };
  await setup(true);
  assert.equal(pending.length, 4, 'StrictMode performs two setups for each native subscription');
  await act(async () => { for (const item of pending) item.done.resolve(() => { item.released++; }); });
  assert.deepEqual(pending.map(item => item.released), [1, 1, 0, 0], 'old late unlisten functions must be released immediately');
  const before = current.tasks;
  await act(async () => pending[0].listener({ payload: { task: task() } }));
  assert.equal(current.tasks, before, 'disposed callbacks cannot update the replacement effect');
  await act(async () => root.unmount());
  assert.deepEqual(pending.map(item => item.released), [1, 1, 1, 1]);
});
