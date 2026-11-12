import test from 'node:test';
import assert from 'node:assert/strict';
import { compareMigrationState, compareRecoveryMigrationState } from '../scripts/migration-fixture.mjs';

function fixture() {
  const createdAt = new Date(Date.now() - 1000).toISOString();
  const tasks = ['queued', 'running'].map((status, index) => ({
    id: `unfinished-${status}`, action: index ? 'apply_update' : 'apply_push', label: status,
    status, stage: 'prior', createdAt, ...(index ? { startedAt: createdAt } : {}),
    origin: { kind: 'synthetic-recovery', skillId: 'one' }, progress: { completed: index, total: 2 },
    cancellable: true, cancelRequested: false, resultAvailable: false, resultExpired: false,
    resources: ['skill:one'],
  }));
  const names = ['resource_catalog', 'resource_catalog_meta', 'skill_annotations', 'management_data_meta', 'invocation_templates', 'invocation_templates_meta', 'resource_scenes', 'resource_scenes_meta', 'resource_relations', 'resource_relations_meta'];
  const baseline = {
    appState: { settings: { uiAccent: 'teal', maintenance: { pausedManually: true } }, unknownFutureField: 'preserve' },
    files: [{ path: 'generated', sha256: 'original' }],
    tables: Object.fromEntries(names.map(name => [name, [{ id: name, payload: { important: 'original' } }]])),
  };
  baseline.tables.workspace_state = [{ id: 1, payload: { revision: 7, windows: [{ label: 'main', activePaneId: 'home', panes: [
    { id: 'home', kind: 'home', title: '工作台', state: { view: 'skills' } },
    { id: 'history', kind: 'history', title: '操作记录', state: { scrollTop: 73 } },
  ] }] } }];
  baseline.tables.task_history = tasks.map(payload => ({ id: payload.id, payload }));
  const actual = structuredClone(baseline);
  for (const row of actual.tables.task_history) Object.assign(row.payload, {
    status: 'interrupted', stage: '上次运行已中断，请检查当前状态后重新操作',
    error: '程序在任务完成前关闭；不会自动重放操作', finishedAt: new Date().toISOString(),
    cancellable: false, resultAvailable: false, resultExpired: true,
  });
  return { baseline, actual, seed: { createdAt, tasks }, names };
}
const history = state => state.tables.workspace_state[0].payload.windows[0].panes[1];

test('recovery accepts the real interrupted transition and absent historical revision as zero', () => {
  const { baseline, actual, seed } = fixture();
  assert.equal(compareRecoveryMigrationState(baseline, actual, seed).passed, true);
  actual.appState.stateRevision = 3;
  assert.equal(compareRecoveryMigrationState(baseline, actual, seed).passed, true);
  baseline.appState.stateRevision = 3; delete actual.appState.stateRevision;
  assert.equal(compareRecoveryMigrationState(baseline, actual, seed).passed, false);
});

test('previously absent pane state keys may appear without changing seeded navigation', () => {
  const { baseline, actual, seed } = fixture();
  history(actual).state.expandedSections = ['closed:记录说明', 'closed:上次任务中断 · 同一来源或资源 2 项记录'];
  history(actual).state.outlineExpanded = false;
  Object.assign(history(actual).state, { clientId: 'codex', documentVersion: 'latest', section: 'docs', view: 'skills' });
  assert.equal(compareRecoveryMigrationState(baseline, actual, seed).passed, true);
  history(actual).state.scrollTop = 0;
  assert.equal(compareRecoveryMigrationState(baseline, actual, seed).passed, false);
  history(actual).state.scrollTop = 73;
  history(baseline).state.outlineExpanded = true;
  assert.equal(compareRecoveryMigrationState(baseline, actual, seed).passed, false);
});

test('seeded unknown state keys, nested values and arrays remain exact without restricting new state keys', () => {
  for (const value of ['original', ['original'], { original: { retained: true } }]) {
    const { baseline, actual, seed } = fixture();
    history(baseline).state.unknownSeededKey = structuredClone(value);
    history(actual).state.unknownSeededKey = structuredClone(value);
    history(actual).state.derivedNewKey = { added: true };
    assert.equal(compareRecoveryMigrationState(baseline, actual, seed).passed, true);
    delete history(actual).state.unknownSeededKey;
    assert.equal(compareRecoveryMigrationState(baseline, actual, seed).passed, false);
    history(actual).state.unknownSeededKey = { changed: true };
    assert.equal(compareRecoveryMigrationState(baseline, actual, seed).passed, false);
  }
});

test('pane metadata additions and changes remain strict outside pane.state', () => {
  for (const mutate of [
    state => { history(state).unknown = true; },
    state => { history(state).title = 'Changed title'; },
    state => { delete history(state).state.scrollTop; },
  ]) {
    const { baseline, actual, seed } = fixture(); mutate(actual);
    assert.equal(compareRecoveryMigrationState(baseline, actual, seed).passed, false);
  }
  const { baseline, actual, seed } = fixture();
  history(baseline).state.expandedSections = ['original'];
  history(actual).state.expandedSections = ['changed'];
  assert.equal(compareRecoveryMigrationState(baseline, actual, seed).passed, false);
});

test('every representative table, unknown app field, nondefault setting and original file is preserved', () => {
  const { names } = fixture();
  for (const name of names) {
    const { baseline, actual, seed } = fixture(); actual.tables[name] = [];
    assert.ok(compareRecoveryMigrationState(baseline, actual, seed).differences.some(item => item.field === name));
  }
  for (const mutate of [
    state => { delete state.appState.unknownFutureField; },
    state => { delete state.appState.settings.maintenance; },
    state => { state.appState.settings.uiAccent = 'violet'; },
    state => { state.files[0].sha256 = 'changed'; },
  ]) {
    const { baseline, actual, seed } = fixture(); mutate(actual);
    assert.equal(compareRecoveryMigrationState(baseline, actual, seed).passed, false);
  }
});

test('task origin, progress, resource keys and no-replay status cannot be discarded', () => {
  for (const key of ['origin', 'progress', 'resources']) {
    const { baseline, actual, seed } = fixture(); delete actual.tables.task_history[0].payload[key];
    assert.equal(compareRecoveryMigrationState(baseline, actual, seed).passed, false);
  }
  const { baseline, actual, seed } = fixture();
  actual.tables.task_history.push({ id: 'replayed', payload: { action: 'apply_update', status: 'succeeded' } });
  assert.equal(compareRecoveryMigrationState(baseline, actual, seed).passed, false);
});

test('the explicit legacy UI save task survives reopen with its metadata intact', () => {
  const { baseline, actual, seed } = fixture();
  const row = { id: 'legacy-save', payload: { id: 'legacy-save', action: 'set_settings', status: 'succeeded', origin: { view: 'settings' }, cancellable: true, resultAvailable: true, resultExpired: false } };
  const downgraded = structuredClone(actual); downgraded.tables.task_history.push(row);
  assert.equal(compareRecoveryMigrationState(baseline, downgraded, seed, actual, { row, restored: false }).passed, true);
  const reopened = structuredClone(downgraded);
  Object.assign(reopened.tables.task_history.at(-1).payload, { cancellable: false, resultAvailable: false, resultExpired: true });
  assert.equal(compareRecoveryMigrationState(baseline, reopened, seed, actual, { row, restored: true }).passed, true);
  reopened.tables.task_history.pop();
  assert.equal(compareRecoveryMigrationState(baseline, reopened, seed, actual, { row, restored: true }).passed, false);
});

test('the original eight migration groups retain their exact comparison', () => {
  const before = Object.fromEntries(['skills', 'sources', 'connections', 'localRoots', 'ignoredLocalPaths', 'checkMode', 'settings', 'originalFiles'].map(name => [name, { retained: true }]));
  assert.equal(compareMigrationState(before, structuredClone(before)).passed, true);
  const after = structuredClone(before); after.settings = {};
  assert.equal(compareMigrationState(before, after).passed, false);
});
