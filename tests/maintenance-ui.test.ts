import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement, act } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { observeMaintenanceClock } from '../src/maintenance-clock.ts';

let code = ts.transpileModule(await readFile(new URL('../src/MaintenanceSettings.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText.replace(/import\s+['"][^'"]+\.css['"];?/g, '');
code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, value) => `from ${JSON.stringify(value.startsWith('.') ? new URL(`../src/${value.slice(2)}.ts`, import.meta.url).href : import.meta.resolve(value))}`);
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const { MaintenanceSettings } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const host = document.getElementById('root')!;
const initial = { revision: 7, valid: true, pausedManually: true, pauseUntil: null, window: null, automaticAllowed: false, reason: '已暂停自动维护' };
const button = (text: string) => Array.from(host.querySelectorAll('button')).find(node => node.textContent === text)!;
const times = () => Array.from(host.querySelectorAll<HTMLInputElement>('input[type="time"]'));
let cleanup = () => {}, restoreClock = () => {};
afterEach(async () => { await act(async () => cleanup()); cleanup = () => {}; restoreClock(); restoreClock = () => {}; });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(save?: (request: any) => Promise<unknown>) {
  const calls: Record<string, unknown>[] = [], root = createRoot(host); cleanup = () => root.unmount();
  const onSave = async (request: Record<string, unknown>) => { calls.push(request); return save ? save(request) : { maintenance: initial }; };
  return { calls, render: async (state: any = initial, disabled = false, visible = true) => act(async () => root.render(createElement(MaintenanceSettings, { state, disabled, visible, onSave }))) };
}
function clock(start: number) {
  let now = start, monotonic = start, id = 0;
  const timers = new Map<number, { at: number; due: number; fire: () => void }>();
  const realNow = Date.now, realSet = window.setTimeout, realClear = window.clearTimeout;
  const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden');
  const performanceDescriptor = Object.getOwnPropertyDescriptor(window.performance, 'now');
  Date.now = () => now;
  Object.defineProperty(window.performance, 'now', { configurable: true, value: () => monotonic });
  window.setTimeout = ((handler: TimerHandler, delay = 0) => { assert.equal(typeof handler, 'function'); const next = ++id; timers.set(next, { at: now + delay, due: monotonic + delay, fire: handler as () => void }); return next; }) as typeof window.setTimeout;
  window.clearTimeout = ((timer: number) => { timers.delete(timer); }) as typeof window.clearTimeout;
  const fireDue = async () => { const due = [...timers].filter(([, timer]) => timer.due <= monotonic); await act(async () => { for (const [key, timer] of due) { if (!timers.has(key)) continue; timers.delete(key); timer.fire(); } }); };
  restoreClock = () => { Date.now = realNow; window.setTimeout = realSet; window.clearTimeout = realClear; if (performanceDescriptor) Object.defineProperty(window.performance, 'now', performanceDescriptor); else delete (window.performance as unknown as { now?: () => number }).now; if (hiddenDescriptor) Object.defineProperty(document, 'hidden', hiddenDescriptor); else delete (document as unknown as { hidden?: boolean }).hidden; };
  return {
    timers,
    jump: (time: number) => { now = time; },
    advance: async (time: number) => { monotonic += time - now; now = time; await fireDue(); },
    elapse: async (duration: number) => { monotonic += duration; now += duration; await fireDue(); },
    visibility: async (hidden: boolean) => act(async () => { Object.defineProperty(document, 'hidden', { configurable: true, value: hidden }); document.dispatchEvent(new dom.window.Event('visibilitychange')); }),
  };
}
async function click(node: HTMLElement) { await act(async () => node.click()); }
async function change(node: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = node.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(node, value); node.dispatchEvent(new dom.window.Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); });
}
async function editWindow(start: string, end: string) {
  const toggle = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  if (!toggle.checked) await click(toggle);
  await change(times()[0], start); await change(times()[1], end);
}

test('pause presets and resume send only the selected maintenance change and current revision', async () => {
  const value = fixture(); await value.render(); assert.equal(value.calls.length, 0);
  for (const preset of ['hour', 'tomorrow', 'manual']) {
    await change(host.querySelector('select')!, preset); await click(button('暂停自动维护'));
  }
  await click(button('恢复维护'));
  assert.deepEqual(value.calls, ['hour', 'tomorrow', 'manual', 'resume'].map(pause => ({ expectedRevision: 7, pause })));
  assert(host.textContent?.includes('不影响手动检查'));
});

test('daily windows accept midnight crossing and preserve a saved draft until its snapshot arrives', async () => {
  const saved = { ...initial, revision: 8, window: { startMinute: 1380, endMinute: 75 } };
  const value = fixture(async () => ({ maintenance: saved })); await value.render();
  await editWindow('23:00', '01:15'); await click(button('保存时间窗口'));
  assert.deepEqual(value.calls, [{ expectedRevision: 7, window: { startMinute: 1380, endMinute: 75 } }]);
  assert.deepEqual(times().map(input => input.value), ['23:00', '01:15']);
  await value.render({ ...initial });
  assert.deepEqual(times().map(input => input.value), ['23:00', '01:15'], 'an older snapshot must not roll back the saved draft');
  await value.render(saved); assert(button('保存时间窗口').disabled);
});

test('pause and window controls share an immediate in-flight lock', async () => {
  const pending = deferred<unknown>(), value = fixture(() => pending.promise); await value.render();
  await editWindow('22:00', '06:00');
  const pause = button('暂停自动维护'), save = button('保存时间窗口');
  await act(async () => { pause.click(); save.click(); pause.click(); });
  assert.deepEqual(value.calls, [{ expectedRevision: 7, pause: 'hour' }]);
  assert(pause.disabled); assert(save.disabled); assert(host.querySelector('select')!.disabled);
  await act(async () => pending.resolve({ maintenance: initial })); assert.equal(pause.disabled, false);
  assert.deepEqual(times().map(input => input.value), ['22:00', '06:00']);
});

test('a newer external revision retains unsaved inputs and requires explicit reread before replacing them', async () => {
  const value = fixture(); await value.render(); await editWindow('22:00', '06:00');
  await value.render({ ...initial, revision: 8, window: { startMinute: 600, endMinute: 720 } });
  assert.deepEqual(times().map(input => input.value), ['22:00', '06:00']);
  assert(button('保存时间窗口').disabled); await click(button('保存时间窗口')); assert.equal(value.calls.length, 0);
  assert(host.textContent?.includes('当前草稿保留'));
  await click(button('读取当前设置'));
  assert.deepEqual(times().map(input => input.value), ['10:00', '12:00']); assert(button('保存时间窗口').disabled);
  assert.equal(host.querySelector('[role="alert"]'), null);
});

test('an early later-window event cannot be overwritten by the submitted save receipt', async () => {
  const pending = deferred<unknown>(), value = fixture(() => pending.promise); await value.render(); await editWindow('23:00', '05:00');
  await click(button('保存时间窗口'));
  const newer = { ...initial, revision: 9, window: { startMinute: 660, endMinute: 780 } };
  await value.render(newer);
  await act(async () => pending.resolve({ maintenance: { ...initial, revision: 8, window: { startMinute: 1380, endMinute: 300 } } }));
  assert.deepEqual(times().map(input => input.value), ['11:00', '13:00']);
  assert(host.textContent?.includes('另一窗口随后更新了设置'));
  assert.equal(value.calls.length, 1); assert(button('保存时间窗口').disabled);
});

test('invalid maintenance data offers only explicit reset to manual pause without silently starting anything', async () => {
  const value = fixture(); await value.render({ ...initial, valid: false, reason: '维护记录不可读取' });
  assert.equal(value.calls.length, 0); assert.equal(host.querySelector('select'), null); assert.equal(host.querySelector('input'), null);
  await click(button('重设为暂停维护'));
  assert.deepEqual(value.calls, [{ expectedRevision: 7, pause: 'manual', window: null }]);
  await value.render({ ...initial, revision: 8 });
  assert(host.textContent?.includes('已暂停自动维护')); assert.equal(button('恢复维护').disabled, false);
});

test('save failure leaves the chosen window available for review and retry', async () => {
  const value = fixture(async () => { throw new Error('保存失败：记录已变化'); }); await value.render();
  await editWindow('21:15', '04:30'); await click(button('保存时间窗口'));
  assert(host.querySelector('[role="alert"]')?.textContent?.includes('记录已变化'));
  assert.deepEqual(times().map(input => input.value), ['21:15', '04:30']); assert.equal(button('保存时间窗口').disabled, false);
  await click(button('保存时间窗口'));
  assert.equal(value.calls.length, 2); assert.deepEqual(value.calls[1], value.calls[0]);
});

test('equal or missing time bounds do not dispatch and disabling a window is explicit', async () => {
  const value = fixture(); await value.render();
  await editWindow('10:00', '10:00'); await click(button('保存时间窗口')); assert.equal(value.calls.length, 0);
  assert(host.textContent?.includes('有效且不同'));
  await change(times()[1], ''); await click(button('保存时间窗口')); assert.equal(value.calls.length, 0);
  await click(host.querySelector('input[type="checkbox"]')!); await click(button('保存时间窗口'));
  assert.deepEqual(value.calls, [{ expectedRevision: 7, window: null }]);
});

test('basic mode and not-yet-loaded maintenance state never write settings', async () => {
  const value = fixture();
  for (const state of [initial, { ...initial, valid: false }]) {
    await value.render(state, true);
    for (const control of host.querySelectorAll<HTMLButtonElement>('button')) { assert(control.disabled); await click(control); }
  }
  await value.render(null);
  assert(host.textContent?.includes('正在读取维护设置'));
  for (const control of host.querySelectorAll<HTMLButtonElement>('button')) { assert(control.disabled); await click(control); }
  assert.equal(value.calls.length, 0);
});

test('a timed pause expires on one boundary timer without a new snapshot or any write', async () => {
  const start = new Date(2026, 9, 28, 9, 0).getTime(), time = clock(start);
  const state = { ...initial, pausedManually: false, pauseUntil: new Date(start + 3_600_000).toISOString(), reason: '自动维护仍在定时暂停期间' };
  const value = fixture(); await value.render(state);
  assert(host.querySelector('.maintenance-status')!.textContent?.includes('定时暂停期间')); assert.equal(time.timers.size, 2);
  assert([...time.timers.values()].some(timer => timer.at === start + 3_600_000), 'the exact pause boundary remains scheduled beside the clock observer');
  await time.advance(start + 3_600_000);
  assert(host.querySelector('.maintenance-status')!.textContent?.includes('自动维护可按各项策略运行'));
  assert(button('恢复维护').disabled, 'an expired pause must not remain presented as needing manual resumption');
  assert.equal(time.timers.size, 1, 'only the shared detector remains so a later clock rollback can restore the timed pause'); assert.equal(value.calls.length, 0); assert.equal(state.revision, 7);
});

test('cross-midnight windows enter at their start and leave at their exclusive end without state polling', async () => {
  const start = new Date(2026, 9, 28, 21, 59, 59, 999).getTime(), time = clock(start);
  const state = { ...initial, pausedManually: false, window: { startMinute: 1320, endMinute: 120 }, reason: '当前不在自动维护时间窗口内' };
  const value = fixture(); await value.render(state);
  assert(host.querySelector('.maintenance-status')!.textContent?.includes('当前不在')); assert.equal(time.timers.size, 2);
  await time.advance(start + 1);
  assert(host.querySelector('.maintenance-status')!.textContent?.includes('当前在维护时间窗口内'));
  const end = new Date(2026, 9, 29, 2, 0).getTime();
  assert([...time.timers.values()].some(timer => timer.at === end));
  await time.advance(new Date(2026, 9, 29, 0, 0).getTime()); assert.equal(time.timers.size, 2);
  await time.advance(end);
  assert(host.querySelector('.maintenance-status')!.textContent?.includes('当前不在'));
  assert([...time.timers.values()].some(timer => timer.at === new Date(2026, 9, 29, 22, 0).getTime()));
  assert.equal(value.calls.length, 0);
});

test('pause expiry still respects the daily window instead of unconditionally reporting resumed maintenance', async () => {
  const start = new Date(2026, 9, 28, 9, 0).getTime(), until = new Date(2026, 9, 28, 9, 30).getTime(), time = clock(start);
  const value = fixture(); await value.render({ ...initial, pausedManually: false, pauseUntil: new Date(until).toISOString(), window: { startMinute: 600, endMinute: 660 } });
  await time.advance(until);
  assert(host.querySelector('.maintenance-status')!.textContent?.includes('当前不在'));
  await time.advance(new Date(2026, 9, 28, 10, 0).getTime());
  assert(host.querySelector('.maintenance-status')!.textContent?.includes('当前在维护时间窗口内')); assert.equal(value.calls.length, 0);
});

test('hidden panes and hidden documents cancel their timer; returning or focusing recomputes actual time', async () => {
  const start = new Date(2026, 9, 28, 9, 0).getTime(), time = clock(start), value = fixture();
  const state = { ...initial, pausedManually: false, window: { startMinute: 600, endMinute: 660 } };
  await value.render(state, false, false); assert.equal(time.timers.size, 0);
  time.jump(new Date(2026, 9, 28, 10, 0).getTime()); await value.render(state);
  assert(host.querySelector('.maintenance-status')!.textContent?.includes('当前在维护时间窗口内')); assert.equal(time.timers.size, 2);
  await time.visibility(true); assert.equal(time.timers.size, 0);
  time.jump(new Date(2026, 9, 28, 11, 0).getTime()); await time.visibility(false);
  assert(host.querySelector('.maintenance-status')!.textContent?.includes('当前不在')); assert.equal(time.timers.size, 2);
  time.jump(new Date(2026, 9, 29, 10, 0).getTime()); await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
  assert(host.querySelector('.maintenance-status')!.textContent?.includes('当前在维护时间窗口内')); assert.equal(time.timers.size, 2);
  await value.render(state, false, false); assert.equal(time.timers.size, 0); assert.equal(value.calls.length, 0);
});

test('manual pauses, disabled views, invalid policies and unmount cancel boundary timers without claiming automatic recovery', async () => {
  const start = new Date(2026, 9, 28, 9, 0).getTime(), time = clock(start), value = fixture();
  const active = { ...initial, pausedManually: false, window: { startMinute: 600, endMinute: 660 } };
  await value.render(active); assert.equal(time.timers.size, 2);
  await value.render({ ...active, pausedManually: true }); assert.equal(time.timers.size, 0); assert(host.querySelector('.maintenance-status')!.textContent?.includes('等待手动恢复'));
  await value.render(active, true); assert.equal(time.timers.size, 0); assert(host.querySelector('.maintenance-status')!.textContent?.includes('当前模式不执行'));
  for (const invalid of [{ ...active, valid: false }, { ...active, pauseUntil: 'invalid' }, { ...active, window: { startMinute: 80, endMinute: 80 } }]) {
    await value.render(invalid); assert.equal(time.timers.size, 0); assert(host.querySelector('.maintenance-status')!.textContent?.includes('保持暂停'));
  }
  await value.render(active); assert.equal(time.timers.size, 2);
  await act(async () => cleanup()); cleanup = () => {}; assert.equal(time.timers.size, 0);
  await act(async () => window.dispatchEvent(new dom.window.Event('focus'))); assert.equal(time.timers.size, 0); assert.equal(value.calls.length, 0);
});

test('independent forward and backward wall-clock jumps reconcile the pause without settings writes', async () => {
  const start = new Date(2026, 9, 28, 9).getTime(), until = start + 3_600_000, time = clock(start), value = fixture();
  await value.render({ ...initial, pausedManually: false, pauseUntil: new Date(until).toISOString() });
  time.jump(until + 30 * 60_000);
  assert(host.querySelector('.maintenance-status')!.textContent?.includes('定时暂停期间'), 'changing wall time alone must not secretly fire monotonic timers');
  await time.elapse(60_000);
  assert(host.querySelector('.maintenance-status')!.textContent?.includes('自动维护可按各项策略运行'));
  assert(button('恢复维护').disabled);
  time.jump(start + 15 * 60_000);
  await time.elapse(60_000);
  assert(host.querySelector('.maintenance-status')!.textContent?.includes('定时暂停期间'));
  assert.equal(button('恢复维护').disabled, false);
  assert([...time.timers.values()].some(timer => timer.at === until));
  assert.equal(value.calls.length, 0);
});

test('a time-zone change is detected while the settings remain visible and focused', async () => {
  const originalZone = process.env.TZ;
  try {
    process.env.TZ = 'UTC';
    const start = Date.UTC(2026, 9, 28, 10, 30), time = clock(start), value = fixture();
    await value.render({ ...initial, pausedManually: false, window: { startMinute: 600, endMinute: 660 } });
    assert(host.querySelector('.maintenance-status')!.textContent?.includes('当前在维护时间窗口内'));
    process.env.TZ = 'Etc/GMT+1';
    await time.elapse(60_000);
    assert(host.querySelector('.maintenance-status')!.textContent?.includes('当前不在'));
    assert([...time.timers.values()].some(timer => timer.at === Date.UTC(2026, 9, 28, 11)), 'the boundary is reinterpreted in the new local zone');
    assert.equal(value.calls.length, 0);
  } finally { if (originalZone === undefined) delete process.env.TZ; else process.env.TZ = originalZone; }
});

test('one shared clock detector stays quiet without a clock change and releases all timers and listeners', async () => {
  const start = new Date(2026, 9, 28, 9).getTime(), time = clock(start);
  let first = 0, second = 0;
  const stopFirst = observeMaintenanceClock(document, window, () => { first++; });
  const stopSecond = observeMaintenanceClock(document, window, () => { second++; });
  cleanup = () => { stopFirst(); stopSecond(); };
  assert.equal(time.timers.size, 1, 'two consumers must share one low-frequency detector');
  await time.elapse(60_000); await time.elapse(60_000);
  assert.equal(first, 0); assert.equal(second, 0);
  time.jump(start - 3_600_000); await time.elapse(60_000);
  assert.equal(first, 1); assert.equal(second, 1);
  stopFirst(); assert.equal(time.timers.size, 1);
  await time.visibility(true); assert.equal(time.timers.size, 0);
  time.jump(start + 3_600_000); await time.elapse(120_000);
  assert.equal(second, 1, 'hidden documents do not probe the clock');
  await time.visibility(false); assert.equal(time.timers.size, 1);
  stopSecond(); assert.equal(time.timers.size, 0);
  await time.visibility(true); await time.visibility(false); await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
  assert.equal(time.timers.size, 0, 'unsubscribing the last consumer removes event subscriptions too');
});
