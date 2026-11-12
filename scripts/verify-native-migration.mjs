import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { NativeUiaSession, assertNoUserManager } from './native-uia-client.mjs';
import { createMigrationInputs, seedNativeLegacyDatabase, readMigrationState, compareMigrationState, seedRecoveryDowngradeDatabase, readRecoveryMigrationState, compareRecoveryMigrationState, recoveryLimitations } from './migration-fixture.mjs';

const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, args) => arg.startsWith('--') ? [...pairs, [arg.slice(2), args[i + 1]]] : pairs, []));
const asList = value => value == null ? [] : Array.isArray(value) ? value : [value];
const phase = options.phase || 'prepare';
const recoveryVariant = options.variant === 'recovery-downgrade';
if (options.variant !== undefined && !recoveryVariant) throw new Error('Only the explicit recovery-downgrade variant is supported.');
if (!['prepare', 'initialize', 'seed', 'legacy', 'candidate', ...(recoveryVariant ? ['recovery-seed', 'recovery', 'downgrade', 'reopen'] : [])].includes(phase)) throw new Error('Use prepare, initialize, seed, legacy, then candidate. The opt-in variant additionally uses recovery-seed, recovery, downgrade, reopen.');
if (phase === 'prepare') {
  const fixture = await createMigrationInputs(options.name || `native-migration-${Date.now()}`);
  if (recoveryVariant) { fixture.variant = 'recovery-downgrade'; await writeFile(join(fixture.root, 'dataset.json'), JSON.stringify(fixture, null, 2)); }
  console.log(JSON.stringify({ status: 'inputs-prepared-no-native-migration-run', fixture: fixture.root, next: 'initialize' }));
  process.exit(0);
}
if (typeof options.fixture !== 'string') throw new Error('Pass the exact generated --fixture root.');
const root = resolve(options.fixture), descriptorPath = join(root, 'dataset.json');
let fixture = JSON.parse(await readFile(descriptorPath, 'utf8'));
assert.equal(fixture.variant === 'recovery-downgrade', recoveryVariant, 'The explicit variant must match the prepared fixture.');
if (phase === 'seed') {
  if (recoveryVariant) await assertNoUserManager();
  fixture = await seedNativeLegacyDatabase(root, join(root, 'initialize-driver.json'));
  console.log(JSON.stringify({ status: 'synthetic-state-seeded-old-native-round-trip-required', fixture: fixture.root, next: 'legacy' })); process.exit(0);
}
if (phase === 'recovery-seed') {
  await assertNoUserManager(); const seed = await seedRecoveryDowngradeDatabase(root);
  console.log(JSON.stringify({ status: 'synthetic-recovery-seeded-app-closed', fixture: root, tasks: seed.tasks.map(task => task.id), next: 'recovery' })); process.exit(0);
}
const currentPhase = ['candidate', 'recovery', 'reopen'].includes(phase);
const executable = resolve(currentPhase ? options.candidate || '' : options.legacy || '');
if (!/\.(exe)$/i.test(executable)) throw new Error('Pass the actual old/candidate native application executable.');
const sha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
let buildInfo = null;
if (currentPhase) {
  buildInfo = JSON.parse(await readFile(resolve(options['candidate-build-info'] || ''), 'utf8'));
  if (buildInfo.buildMode !== 'release' || (buildInfo.executableSha256 || buildInfo.sha256)?.toLowerCase() !== sha256 || !(buildInfo.sourceIdentity || buildInfo.sourceCommit)) throw new Error('Candidate native migration requires exact release/source provenance.');
  if (recoveryVariant) assert.notEqual(buildInfo.diagnosticOnly, true, 'The variant requires the normal candidate.');
  // A successful old-native round trip must exist before the upgrade launch.
  const oldRun = JSON.parse(await readFile(join(root, 'legacy-driver.json'), 'utf8'));
  if (!oldRun.closedNormally || !/^0\.2\.11(?:\D|$)/.test(oldRun.productVersion || '')) throw new Error('The old v0.2.11 synthetic round trip did not close normally.');
}
const recoveryPhase = ['recovery', 'downgrade', 'reopen'].includes(phase);
let seed, baseline, recovered, legacySave;
if (recoveryPhase) {
  seed = JSON.parse(await readFile(join(root, 'recovery-seed.json'), 'utf8'));
  baseline = JSON.parse(await readFile(join(root, 'recovery-baseline.json'), 'utf8'));
  assert.equal(seed.syntheticOnly, true);
  if (currentPhase) assert.equal(sha256, seed.candidateExecutableSha256, 'All current-version phases must use the exact original candidate.');
  if (phase !== 'recovery') {
    const first = JSON.parse(await readFile(join(root, 'recovery-comparison.json'), 'utf8'));
    assert.equal(first.candidateNativeNormalExit, true); assert.equal(first.passed, true);
    recovered = first.state;
  }
  if (phase === 'reopen') {
    const downgraded = JSON.parse(await readFile(join(root, 'downgrade-comparison.json'), 'utf8'));
    assert.equal(downgraded.candidateNativeNormalExit, true);
    assert.ok(downgraded.legacySave?.row);
    legacySave = { row: downgraded.legacySave.row, restored: true };
  }
}

async function readRecoveryBackend(app) {
  const queries = [['resource_list', {}], ['resource_scenes', {}], ['resource_relations', { kind: 'skill', id: seed.annotation.skillId }], ['resource_templates', { id: seed.tool.id, actionId: seed.template.actionId }]];
  const messages = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic-migration-readonly', version: '1' } } }, { jsonrpc: '2.0', method: 'notifications/initialized' }, ...queries.map(([name, arguments_], index) => ({ jsonrpc: '2.0', id: index + 2, method: 'tools/call', params: { name, arguments: arguments_ } }))];
  const child = spawn(executable, ['--mcp', '--data-dir', fixture.dataDir], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TEMP: join(root, 'native-temp'), TMP: join(root, 'native-temp') } });
  let stdout = '', stderr = ''; child.stdout.setEncoding('utf8').on('data', value => { stdout += value; }); child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
  await new Promise((done, reject) => {
    const timer = setTimeout(() => { child.stdin.end(); reject(new Error(`The read-only MCP bridge ${child.pid} did not exit normally within twenty seconds. No forced stop was attempted.`)); }, 20000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); if (code === 0 && !signal) done(); else reject(new Error(`Read-only MCP bridge exited ${code}/${signal}.`)); });
    child.stdin.end(messages.map(value => JSON.stringify(value)).join('\n') + '\n');
  });
  assert.equal(stderr, ''); const replies = stdout.trim().split(/\r?\n/).map(value => JSON.parse(value)); assert.equal(replies.length, 5);
  const outcomes = {};
  for (const [index, [name]] of queries.entries()) {
    const reply = replies.find(value => value.id === index + 2); assert.ok(reply && !reply.error && reply.result.isError === false);
    const started = JSON.parse(reply.result.content[0].text); assert.ok(started.task?.id);
    const deadline = Date.now() + 20000; let record;
    do { record = (await app.call('task', { taskId: started.task.id })).task; if (!['queued', 'running'].includes(record.status)) break; await new Promise(done => setTimeout(done, 50)); } while (Date.now() < deadline);
    assert.equal(record.status, 'succeeded', `${name}: ${record.error || record.status}`); outcomes[name] = record.result;
  }
  assert.ok(outcomes.resource_list.resources.some(value => value.id === seed.tool.id && value.notes === seed.tool.notes));
  assert.equal(outcomes.resource_scenes.activeSceneId, seed.scene.id); assert.ok(outcomes.resource_scenes.scenes.some(value => value.id === seed.scene.id));
  assert.ok(outcomes.resource_relations.dependencies.some(value => value.id === seed.relation.id));
  assert.ok(outcomes.resource_templates.templates.some(value => value.id === seed.template.id && value.parameterNames.includes('query')));
  const tasks = (await app.call('tasks')).tasks;
  for (const original of seed.tasks) { const value = (await app.call('task', { taskId: original.id })).task; assert.equal(value.status, 'interrupted'); assert.deepEqual(value.origin, original.origin); assert.equal(value.resultExpired, true); }
  return { queries: queries.map(([name]) => name), outcomes, taskIds: tasks.map(task => task.id), mcpBridgeNormalExit: true };
}
const reportPath = join(root, `${phase}-driver.json`);
let app;
try {
  app = await NativeUiaSession.launch({ executable, sha256, dataDir: fixture.dataDir, reportPath, ...(recoveryVariant ? { accessibilityInput: true } : {}) });
  const observed = recoveryPhase && currentPhase ? await readRecoveryBackend(app) : null;
  let legacyUiSave = null;
  if (phase === 'downgrade') {
    await app.call('invokeName', { name: '设置' });
    const startedAt = new Date().toISOString();
    await app.call('invokeName', { name: '保存设置' }, 20000);
    const deadline = Date.now() + 20000;
    let saved = [];
    do { saved = asList(await app.call('state', { name: '设置已保存。' })); if (saved.some(value => !value.offscreen)) break; await new Promise(done => setTimeout(done, 100)); } while (Date.now() < deadline);
    assert.ok(saved.some(value => !value.offscreen), 'The old native UI did not confirm that settings were saved.');
    await app.call('invokeName', { name: 'Skills' });
    const navigationDeadline = Date.now() + 20000;
    let searchFields = [];
    do { searchFields = asList(await app.call('state', { name: '搜索 Skill' }, Math.max(1, navigationDeadline - Date.now()))); if (searchFields.some(value => value.type === 'ControlType.Edit' && !value.offscreen)) break; await new Promise(done => setTimeout(done, 100)); } while (Date.now() < navigationDeadline);
    assert.ok(searchFields.some(value => value.type === 'ControlType.Edit' && !value.offscreen), 'The old native library did not finish returning before the normal exit.');
    legacyUiSave = { startedAt, successText: '设置已保存。', completedAt: new Date().toISOString() };
  }
  await app.quit(); app = null;
  const run = JSON.parse(await readFile(reportPath, 'utf8'));
  if (!currentPhase && !/^0\.2\.11(?:\D|$)/.test(run.productVersion || '')) throw new Error('Only native v0.2.11 can establish the legacy database evidence.');
  if (phase === 'legacy') {
    const snapshot = await readMigrationState(root);
    await writeFile(join(root, 'old-native-state.json'), JSON.stringify({ syntheticOnly: true, oldDriverReport: reportPath, executableSha256: sha256, state: snapshot }, null, 2));
  } else if (phase === 'candidate') {
    const oldState = JSON.parse(await readFile(join(root, 'old-native-state.json'), 'utf8')), state = await readMigrationState(root);
    const result = compareMigrationState(oldState.state, state);
    await writeFile(join(root, 'native-migration-comparison.json'), JSON.stringify({ ...result, syntheticOnly: true, oldExecutableSha256: oldState.executableSha256, candidateExecutableSha256: sha256, candidateSourceIdentity: buildInfo.sourceIdentity || buildInfo.sourceCommit, oldNativeNormalExit: true, candidateNativeNormalExit: run.closedNormally, state, completedAt: new Date().toISOString() }, null, 2));
    if (!result.passed) { process.exitCode = 1; console.log(JSON.stringify({ status: 'native-migration-differences', report: join(root, 'native-migration-comparison.json'), fields: result.differences.map(value => value.field) })); }
  } else if (recoveryPhase) {
    const state = await readRecoveryMigrationState(root);
    if (legacyUiSave) {
      const saved = state.tables.task_history.filter(row => row.payload.action === 'set_settings' && !recovered.tables.task_history.some(before => before.id === row.id));
      assert.equal(saved.length, 1, 'The old UI save must have exactly one new durable settings task.');
      assert.equal(saved[0].payload.status, 'succeeded');
      assert.ok(Date.parse(saved[0].payload.createdAt) >= Date.parse(legacyUiSave.startedAt) - 1000);
      assert.ok(Date.parse(saved[0].payload.finishedAt) <= Date.parse(legacyUiSave.completedAt) + 1000);
      legacySave = { row: saved[0], restored: false };
    }
    const result = compareRecoveryMigrationState(baseline, state, seed, recovered, legacySave);
    const evidencePaths = [descriptorPath, join(root, 'recovery-seed.json'), join(root, 'recovery-baseline.json'), new URL(import.meta.url), new URL('./migration-fixture.mjs', import.meta.url), new URL('./native-uia-client.mjs', import.meta.url)];
    const evidence = await Promise.all(evidencePaths.map(async path => ({ path: String(path), sha256: createHash('sha256').update(await readFile(path)).digest('hex') })));
    const report = { ...result, phase, syntheticOnly: true, candidateExecutableSha256: sha256, candidateSourceIdentity: buildInfo?.sourceIdentity || null, candidateNativeNormalExit: run.closedNormally, seededCandidateSha256: seed.candidateExecutableSha256, state, observedBackend: observed, legacyUiSave, legacySave, evidence, completedAt: new Date().toISOString(), limitations: recoveryLimitations };
    await writeFile(join(root, `${phase}-comparison.json`), JSON.stringify(report, null, 2), { flag: 'wx' });
    if (!result.passed) { process.exitCode = 1; console.log(JSON.stringify({ status: 'recovery-downgrade-differences', phase, fields: result.differences.map(value => value.field), report: join(root, `${phase}-comparison.json`) })); }
  }
  if (!process.exitCode) console.log(JSON.stringify({ status: phase === 'candidate' ? 'isolated-native-migration-fields-passed' : 'native-phase-complete', phase, report: reportPath, fixture: root }));
} finally { if (app) await app.quit(); }
