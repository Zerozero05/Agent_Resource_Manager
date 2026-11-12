import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileLibraryReading, nearestSurvivingId, type LibraryReading } from '../src/library-reading.ts';

test('initial reading uses the requested sorted and filtered IDs without retaining the caller array', () => {
  const candidates = ['c', 'a'];
  const reading = reconcileLibraryReading(null, ['a', 'b', 'c'], candidates, 'status');
  assert.deepEqual(reading, { key: 'status', ids: ['c', 'a'], pending: false });
  assert.notEqual(reading.ids, candidates);
});

test('background status and check-time sorting preserve the existing reading order', () => {
  const previous = { key: 'checked', ids: ['a', 'b', 'c'] };
  const reading = reconcileLibraryReading(previous, ['c', 'b', 'a'], ['c', 'a', 'b'], 'checked');
  assert.deepEqual(reading, { key: 'checked', ids: ['a', 'b', 'c'], pending: true });
  assert.deepEqual(previous.ids, ['a', 'b', 'c']);
});

test('a status-filter mismatch does not remove a resource that still exists in the full inventory', () => {
  const previous = { key: 'attention', ids: ['resolved', 'pending'] };
  assert.deepEqual(reconcileLibraryReading(previous, ['resolved', 'pending'], ['pending'], 'attention'), {
    key: 'attention', ids: ['resolved', 'pending'], pending: true,
  });
  assert.deepEqual(reconcileLibraryReading(previous, ['resolved', 'pending'], [], 'attention'), {
    key: 'attention', ids: ['resolved', 'pending'], pending: true,
  });
});

test('only actual inventory deletion removes old members, while new matches append without moving retained rows', () => {
  const previous = { key: 'attention', ids: ['a', 'deleted', 'b'] };
  assert.deepEqual(reconcileLibraryReading(previous, ['a', 'b', 'new'], ['new', 'b'], 'attention'), {
    key: 'attention', ids: ['a', 'b', 'new'], pending: true,
  });
  assert.deepEqual(reconcileLibraryReading(previous, ['a', 'b', 'new'], ['a', 'b', 'new'], 'attention'), {
    key: 'attention', ids: ['a', 'b', 'new'], pending: false,
  });
});

test('explicit filter, sort or refresh-key change rebuilds current membership and order', () => {
  const previous = { key: 'attention:1', ids: ['resolved', 'b', 'a'] };
  assert.deepEqual(reconcileLibraryReading(previous, ['resolved', 'a', 'b'], ['a', 'b'], 'attention:2'), {
    key: 'attention:2', ids: ['a', 'b'], pending: false,
  });
  assert.deepEqual(reconcileLibraryReading(previous, ['resolved', 'a', 'b'], [], 'new-search'), {
    key: 'new-search', ids: [], pending: false,
  });
});

test('matching order clears pending naturally, and zero results or an empty inventory stay well-defined', () => {
  const previous = { key: 'same', ids: ['b', 'a'] };
  assert.equal(reconcileLibraryReading(previous, ['a', 'b'], ['b', 'a'], 'same').pending, false);
  assert.deepEqual(reconcileLibraryReading(previous, [], [], 'same'), { key: 'same', ids: [], pending: false });
  assert.deepEqual(reconcileLibraryReading({ key: 'same', ids: [] }, ['a'], ['a'], 'same'), { key: 'same', ids: ['a'], pending: false });
});

test('selection retains a surviving identity even after its position changes', () => {
  assert.equal(nearestSurvivingId(['a', 'b', 'c'], ['c', 'a', 'b'], 'b'), 'b');
});

test('deletion chooses a following old neighbor before preceding survivors, never an unrelated first row', () => {
  assert.equal(nearestSurvivingId(['a', 'b', 'c', 'd'], ['new', 'a', 'd'], 'b'), 'd');
  assert.equal(nearestSurvivingId(['a', 'b', 'c', 'd'], ['new', 'a', 'b'], 'd'), 'b');
  assert.equal(nearestSurvivingId(['a', 'b'], ['new'], 'b'), 'new');
  assert.equal(nearestSurvivingId(['a', 'b'], [], 'b'), '');
  assert.equal(nearestSurvivingId(['a', 'b'], ['c', 'd'], 'unknown'), 'c');
});

test('1000-item reading keeps stable identities through reordering, deletion, status exits and additions', () => {
  const original = Array.from({ length: 1000 }, (_, index) => `skill-${index}`);
  const previous: LibraryReading = { key: 'checked', ids: Object.freeze([...original]) as unknown as string[] };
  const all = Object.freeze([...original.filter(id => id !== 'skill-500'), 'new']);
  const candidates = Object.freeze(['new', ...original.filter((id, index) => index % 2 === 0 && id !== 'skill-500').reverse()]);
  const reading = reconcileLibraryReading(previous, all, candidates, 'checked');
  assert.deepEqual(reading.ids, [...original.filter(id => id !== 'skill-500'), 'new']);
  assert.equal(reading.pending, true);
  assert.equal(nearestSurvivingId(previous.ids, reading.ids, 'skill-500'), 'skill-501');
  assert.equal(nearestSurvivingId(previous.ids, reading.ids, 'skill-499'), 'skill-499');
  assert.deepEqual(reconcileLibraryReading(reading, all, candidates, 'checked:new'), { key: 'checked:new', ids: [...candidates], pending: false });
  assert.deepEqual(previous.ids, original);
});
