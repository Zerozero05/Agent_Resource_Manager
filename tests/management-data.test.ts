import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagementDataCache, managementDataCache, type ManagementData } from '../src/management-data.ts';

const data = (revision: number): ManagementData => ({ revision, skillAnnotations: [{ skillId: 'synthetic', revision, alias: `Alias ${revision}`, notes: '' }], savedViews: [] });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('import and invalidation are inert, and subscription snapshots stay stable between changes', () => {
  assert.deepEqual(managementDataCache.getSnapshot(), { data: null, loaded: false, stale: true, loading: false, error: null });
  const cache = createManagementDataCache(); let calls = 0;
  const unsubscribe = cache.subscribe(() => calls++);
  cache.invalidate(2); assert.equal(calls, 1); assert.equal(cache.getSnapshot().loading, false);
  const snapshot = cache.getSnapshot(); cache.invalidate(2); cache.invalidate(1);
  assert.equal(cache.getSnapshot(), snapshot); assert.equal(calls, 1);
  unsubscribe(); cache.accept(data(2)); assert.equal(calls, 1);
});

test('concurrent pane reads coalesce and subsequent fresh reads reuse data', async () => {
  const cache = createManagementDataCache(), pending = deferred<ManagementData>(); let calls = 0;
  const load = () => { calls++; return pending.promise; };
  const one = cache.read(load), two = cache.read(load); assert.equal(one, two);
  assert.equal(cache.getSnapshot().loading, true); await Promise.resolve(); assert.equal(calls, 1);
  pending.resolve(data(1)); assert.deepEqual(await one, data(1)); await two;
  const result = await cache.read(load); assert.deepEqual(result, data(1)); assert.equal(calls, 1);
  assert.deepEqual(cache.getSnapshot(), { data: result, loaded: true, stale: false, loading: false, error: null });
});

test('accepting the same successful result twice keeps the snapshot and subscribers unchanged', () => {
  const cache = createManagementDataCache(), result = data(2); let calls = 0;
  cache.subscribe(() => calls++); cache.accept(result); const snapshot = cache.getSnapshot();
  cache.accept(result); assert.equal(cache.getSnapshot(), snapshot); assert.equal(calls, 1);
});

test('a late old read cannot overwrite a successful newer write or return obsolete data', async () => {
  const cache = createManagementDataCache(), pending = deferred<ManagementData>();
  const read = cache.read(() => pending.promise); cache.accept(data(5)); pending.resolve(data(1));
  assert.deepEqual(await read, data(5)); assert.equal(cache.getSnapshot().data?.revision, 5); assert.equal(cache.getSnapshot().stale, false);
  cache.accept(data(3)); assert.equal(cache.getSnapshot().data?.revision, 5);
});

test('invalidation watermark survives an in-flight read until sufficiently new data arrives', async () => {
  const cache = createManagementDataCache(), pending = deferred<ManagementData>();
  cache.accept(data(2)); cache.invalidate(3);
  const read = cache.read(() => pending.promise); cache.invalidate(7); pending.resolve(data(4)); await read;
  assert.equal(cache.getSnapshot().data?.revision, 4); assert.equal(cache.getSnapshot().stale, true);
  cache.accept(data(6)); assert.equal(cache.getSnapshot().stale, true);
  await cache.read(async () => data(7)); assert.equal(cache.getSnapshot().stale, false);
  const snapshot = cache.getSnapshot(); cache.invalidate(6); assert.equal(cache.getSnapshot(), snapshot);
});

test('read failure keeps prior content and exposes an error until an explicit successful retry', async () => {
  const cache = createManagementDataCache(); cache.accept(data(3)); cache.invalidate(4);
  await assert.rejects(cache.read(async () => { throw new Error('Synthetic offline'); }), /offline/);
  assert.deepEqual(cache.getSnapshot(), { data: data(3), loaded: true, stale: true, loading: false, error: 'Synthetic offline' });
  await cache.read(async () => data(4)); assert.equal(cache.getSnapshot().error, null); assert.equal(cache.getSnapshot().stale, false);
});

test('initial read failure is not an empty successful load', async () => {
  const cache = createManagementDataCache(); await assert.rejects(cache.read(async () => { throw 'Synthetic failure'; }));
  assert.equal(cache.getSnapshot().loaded, false); assert.equal(cache.getSnapshot().data, null); assert.equal(cache.getSnapshot().error, 'Synthetic failure');
});

test('failure of an older read does not erase the status of a newer successful write', async () => {
  const cache = createManagementDataCache(), pending = deferred<ManagementData>(); const read = cache.read(() => pending.promise);
  cache.accept(data(8)); pending.reject(new Error('Old read failed')); await assert.rejects(read);
  assert.equal(cache.getSnapshot().error, null); assert.equal(cache.getSnapshot().stale, false); assert.equal(cache.getSnapshot().data?.revision, 8);
});
