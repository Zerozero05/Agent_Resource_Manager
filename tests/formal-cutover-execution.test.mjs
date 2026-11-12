import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { applyCutover, parseCutoverOptions, prepareCutover, validateCutoverMode } from '../scripts/formal-cutover.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const validation = join(root, 'validation', 'manager-data');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = async path => { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

async function fixture() {
  const directory = await mkdtemp(join(validation, 'cutover-rehearsal-'));
  const source = join(directory, 'old'), target = join(directory, 'new'), candidate = join(directory, 'candidate');
  await mkdir(join(source, 'webview', '空目录'), { recursive: true });
  await mkdir(join(source, 'private-recovery'), { recursive: true });
  await mkdir(candidate);
  await writeFile(join(source, 'webview', '中文配置.json'), '{"theme":"night","count":7}\n');
  await writeFile(join(source, 'private-recovery', 'original.bin'), Buffer.from([1, 2, 3, 255]));
  await writeFile(join(source, 'retained.md'), 'unique retained material');
  const database = join(source, 'manager.sqlite3');
  // Immediate process exit leaves a committed WAL for the offline cutover.
  execFileSync(process.execPath, ['--input-type=module', '-e', "import{DatabaseSync}from'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec(\"PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE app_state(id INTEGER PRIMARY KEY,payload TEXT);INSERT INTO app_state VALUES(1,'{\\\"name\\\":\\\"合成资料\\\"}');CREATE TABLE new_tools(id TEXT PRIMARY KEY,version TEXT);INSERT INTO new_tools VALUES('tool-1','1.0');\");process.exit(0)", database], { windowsHide: true });
  const program = join(candidate, 'agent-resource-manager.exe'), notices = join(candidate, 'THIRD_PARTY_NOTICES.txt');
  await writeFile(program, 'generated executable-shaped test bytes, never run');
  await writeFile(notices, 'generated licence fixture');
  const mappings = [];
  async function mapTree(path, destination) {
    const stat = await lstat(path);
    mappings.push({ path, destination, kind: stat.isDirectory() ? 'directory' : 'file', action: 'move-after-owner-release' });
    if (stat.isDirectory()) for (const child of await readdir(path)) await mapTree(join(path, child), join(destination, child));
  }
  await mapTree(join(source, 'webview'), join(target, 'cache', 'webview'));
  await mapTree(join(source, 'private-recovery'), join(target, 'data', 'private-recovery'));
  for (const name of ['manager.sqlite3', 'manager.sqlite3-wal', 'manager.sqlite3-shm']) {
    if (await exists(join(source, name))) mappings.push({ path: join(source, name), destination: join(target, 'data', name), kind: 'file', action: 'move-after-database-close' });
  }
  const report = { format: 'agent-resource-manager-formal-cutover-plan-v1', applyImplemented: false, blockers: [], sourceRoot: source, managerRoot: target,
    candidate: { currentSourcesMatch: true }, mappings,
    candidateFiles: await Promise.all([program, notices].map(async path => ({ source: path, destination: join(target, 'app', path === program ? 'agent-resource-manager.exe' : 'THIRD_PARTY_NOTICES.txt'), sha256: hash(await readFile(path)) }))),
    proposedNewFiles: [{ path: join(target, 'app', 'storage-paths.json'), content: { formatVersion: 1, config: { managedRoot: target, overrides: { state: join(target, 'data') } } } }, { path: join(target, 'app', 'data-directory.txt'), content: '.\n' }] };
  const reportPath = join(directory, 'inventory.json'), manifestPath = join(directory, 'execution.json'), journalPath = join(directory, 'execution-result.json');
  await writeFile(reportPath, JSON.stringify(report));
  return { directory, source, target, candidate, database, report, reportPath, manifestPath, journalPath };
}

async function prepared() {
  const value = await fixture();
  value.bound = await prepareCutover(value.reportPath, value.manifestPath);
  return value;
}

test('bound inventory normalizes Chinese parent/child moves, keeps all digests and deploys no runtime files', async () => {
  const value = await fixture();
  const before = hash(await readFile(value.database));
  const bound = await prepareCutover(value.reportPath, value.manifestPath);
  const manifest = JSON.parse(await readFile(value.manifestPath));
  assert.equal(bound.moveRoots, manifest.moves.length);
  assert.equal(manifest.moves.filter(item => item.source.includes('webview')).length, 1);
  const webview = manifest.moves.find(item => item.source.endsWith('webview'));
  assert.ok(webview.tree.directories.includes('空目录'));
  assert.equal(webview.tree.files[0].path, '中文配置.json');
  assert.match(webview.tree.files[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(hash(await readFile(value.database)), before);
  assert.equal(await exists(value.target), false);
  assert.equal(await exists(join(value.source, 'retained.md')), true);
});

test('real WAL checkpoint, exclusive native moves and candidate deployment preserve the sole canonical data and support exact retry', async () => {
  const value = await prepared();
  const manifest = JSON.parse(await readFile(value.manifestPath));
  assert.ok(manifest.moves.some(item => item.source.endsWith('-wal')));
  const result = await applyCutover(value.manifestPath, value.bound.sha256, value.journalPath);
  assert.equal(result.status, 'completed');
  assert.equal(await exists(value.database), false);
  assert.equal(await exists(`${value.database}-wal`), false);
  assert.equal(await exists(`${value.database}-shm`), false);
  const db = new DatabaseSync(join(value.target, 'data', 'manager.sqlite3'), { readOnly: true });
  try {
    assert.equal(JSON.parse(db.prepare('SELECT payload FROM app_state').get().payload).name, '合成资料');
    assert.equal(db.prepare('SELECT version FROM new_tools').get().version, '1.0');
  } finally { db.close(); }
  assert.equal(await readFile(join(value.target, 'cache', 'webview', '中文配置.json'), 'utf8'), '{"theme":"night","count":7}\n');
  assert.ok((await lstat(join(value.target, 'cache', 'webview', '空目录'))).isDirectory());
  assert.equal(await readFile(join(value.source, 'retained.md'), 'utf8'), 'unique retained material');
  assert.equal(hash(await readFile(join(value.candidate, 'agent-resource-manager.exe'))), hash(await readFile(join(value.target, 'app', 'agent-resource-manager.exe'))));
  assert.equal((await applyCutover(value.manifestPath, value.bound.sha256, value.journalPath)).status, 'completed');
});

test('an interruption between native move and journal acknowledgement resumes from exact destination bytes', async () => {
  const value = await prepared();
  let interrupted;
  await assert.rejects(applyCutover(value.manifestPath, value.bound.sha256, value.journalPath, { afterMove(move) { interrupted = move; throw new Error('synthetic interruption'); } }), /synthetic interruption/);
  assert.equal(await exists(interrupted.source), false);
  assert.equal(await exists(interrupted.destination), true);
  const journal = JSON.parse(await readFile(value.journalPath));
  assert.equal(journal.completed.includes(interrupted.source), false);
  await writeFile(`${value.journalPath}.pending`, JSON.stringify(journal));
  assert.equal((await applyCutover(value.manifestPath, value.bound.sha256, value.journalPath)).status, 'completed');
  assert.equal(await exists(`${value.journalPath}.pending`), false);
});

test('a concurrent executor cannot checkpoint or move while the first one holds the execution lease', async () => {
  const value = await prepared();
  let entered, release;
  const ready = new Promise(done => { entered = done; });
  const resume = new Promise(done => { release = done; });
  const first = applyCutover(value.manifestPath, value.bound.sha256, value.journalPath, { async afterMove() { entered(); await resume; } });
  await ready;
  try { await assert.rejects(applyCutover(value.manifestPath, value.bound.sha256, value.journalPath), /lease unavailable/); }
  finally { release(); }
  assert.equal((await first).status, 'completed');
});

test('changed source, existing destination and changed manifest are rejected before database checkpoint', async () => {
  for (const change of ['source', 'destination', 'manifest']) {
    const value = await prepared(), before = hash(await readFile(value.database));
    if (change === 'source') await writeFile(join(value.source, 'webview', '中文配置.json'), 'changed');
    if (change === 'destination') { await mkdir(join(value.target, 'cache', 'webview'), { recursive: true }); await writeFile(join(value.target, 'cache', 'webview', 'unique.txt'), 'preserve'); }
    if (change === 'manifest') await writeFile(value.manifestPath, '{}');
    await assert.rejects(applyCutover(value.manifestPath, value.bound.sha256, value.journalPath), /source changed|destination already exists|manifest digest/);
    assert.equal(hash(await readFile(value.database)), before);
  }
});

test('a real database writer prevents checkpoint, then the same manifest can resume after the owner closes', async () => {
  const value = await prepared();
  const writer = new DatabaseSync(value.database);
  writer.exec('BEGIN IMMEDIATE');
  try { await assert.rejects(applyCutover(value.manifestPath, value.bound.sha256, value.journalPath), /locked/); }
  finally { writer.exec('ROLLBACK'); writer.close(); }
  assert.equal((await applyCutover(value.manifestPath, value.bound.sha256, value.journalPath)).status, 'completed');
});

test('an ordinary file held for writing prevents its native move and resumes after the owner releases it', async () => {
  const value = await prepared();
  const writer = await open(join(value.source, 'webview', '中文配置.json'), 'r+');
  try { await assert.rejects(applyCutover(value.manifestPath, value.bound.sha256, value.journalPath), /Native move failed/); }
  finally { await writer.close(); }
  assert.equal(await exists(join(value.source, 'webview', '中文配置.json')), true);
  assert.equal(await exists(join(value.target, 'cache', 'webview')), false);
  assert.equal((await applyCutover(value.manifestPath, value.bound.sha256, value.journalPath)).status, 'completed');
});

test('committed database changes are refused before checkpoint and retain the changed row', async () => {
  const value = await prepared();
  const writer = new DatabaseSync(value.database);
  try { writer.exec("UPDATE new_tools SET version='2.0'"); }
  finally { writer.close(); }
  await assert.rejects(applyCutover(value.manifestPath, value.bound.sha256, value.journalPath), /database logical content changed/);
  assert.equal(await exists(join(value.target, 'data', 'manager.sqlite3')), false);
  const reader = new DatabaseSync(value.database, { readOnly: true });
  try { assert.equal(reader.prepare('SELECT version FROM new_tools').get().version, '2.0'); }
  finally { reader.close(); }
});

test('a destination edited after interruption is retained and cannot be silently accepted on resume', async () => {
  const value = await prepared();
  let moved;
  await assert.rejects(applyCutover(value.manifestPath, value.bound.sha256, value.journalPath, { afterMove(move) { moved = move; throw new Error('synthetic interruption'); } }), /synthetic interruption/);
  const changed = join(moved.destination, '中文配置.json');
  await writeFile(changed, 'user changed the moved file');
  await assert.rejects(applyCutover(value.manifestPath, value.bound.sha256, value.journalPath), /destination differs/);
  assert.equal(await readFile(changed, 'utf8'), 'user changed the moved file');
  assert.equal(await exists(moved.source), false);
});

test('overlapping destinations, disagreeing nested maps and cross-drive moves cannot be bound', async () => {
  for (const change of ['overlap', 'nested', 'drive']) {
    const value = await fixture();
    if (change === 'overlap') value.report.mappings.find(item => item.path.endsWith('private-recovery')).destination = join(value.target, 'cache', 'webview', 'recovery');
    if (change === 'nested') value.report.mappings.find(item => item.path.endsWith('中文配置.json')).destination = join(value.target, 'elsewhere.json');
    if (change === 'drive') value.report.mappings[0].destination = 'E:\\unexpected';
    await writeFile(value.reportPath, JSON.stringify(value.report));
    await assert.rejects(prepareCutover(value.reportPath, value.manifestPath), /overlap|conflicting|approved roots|same drive/);
    assert.equal(await exists(value.manifestPath), false);
  }
});

test('junction ancestry is refused without traversing or moving its external target', async () => {
  const value = await fixture(), external = join(value.directory, 'external');
  await mkdir(external); await writeFile(join(external, 'unique.txt'), 'preserve');
  await symlink(external, join(value.source, 'webview', 'linked'), 'junction');
  await assert.rejects(prepareCutover(value.reportPath, value.manifestPath), /Reparse/);
  assert.equal(await readFile(join(external, 'unique.txt'), 'utf8'), 'preserve');
  assert.equal(await exists(value.target), false);
});

test('formal application stays blocked even if a manifest falsely marks itself synthetic', async () => {
  const value = await prepared(), manifest = JSON.parse(await readFile(value.manifestPath));
  manifest.sourceRoot = join(dirname(root), 'skill_manager'); manifest.managerRoot = root; manifest.formal = false;
  const bytes = Buffer.from(JSON.stringify(manifest)); await writeFile(value.manifestPath, bytes);
  await assert.rejects(applyCutover(value.manifestPath, hash(bytes), value.journalPath), /Formal application awaits/);
  assert.equal(await exists(value.journalPath), false);
});

function readyFormalManifest() {
  const sourceReportSha256 = 'a'.repeat(64);
  return {
    sourceRoot: join(dirname(root), 'skill_manager'), managerRoot: root, formal: true,
    formalApplyBlocked: false, sourceReportSha256, pendingFinalization: ['installation-registration', 'repository-rename-and-links'],
    formalReadiness: { format: 'agent-resource-manager-formal-readiness-v1', status: 'ready', sourceReportSha256, legacyLauncher: 'resolved', legacyDataPointer: 'resolved' },
  };
}

test('formal apply mode requires the pinned roots, explicit formal identity and reviewed ready contract', () => {
  assert.equal(validateCutoverMode(readyFormalManifest(), 'apply'), true);
  const invalid = [
    value => { value.formal = false; },
    value => { value.sourceRoot += '-other'; },
    value => { value.managerRoot += '-other'; },
    value => { value.formalApplyBlocked = true; },
    value => { delete value.formalApplyBlocked; },
    value => { delete value.formalReadiness; },
    value => { value.formalReadiness.status = 'pending'; },
    value => { value.formalReadiness.legacyLauncher = 'pending'; },
    value => { value.formalReadiness.legacyDataPointer = 'pending'; },
    value => { value.formalReadiness.sourceReportSha256 = 'b'.repeat(64); },
    value => { value.pendingFinalization.push('legacy-launcher-and-data-pointer'); },
  ];
  for (const change of invalid) {
    const manifest = readyFormalManifest();
    change(manifest);
    assert.throws(() => validateCutoverMode(manifest, 'apply'));
  }
  assert.throws(() => validateCutoverMode(readyFormalManifest(), 'rehearse'), /Formal application awaits/);
  assert.throws(() => validateCutoverMode(readyFormalManifest(), undefined), /explicit apply/);
});

test('formal apply cannot execute an isolated manifest by toggling its formal flag', async () => {
  const value = await prepared();
  for (const formal of [false, true]) {
    const digest = await rewriteManifest(value, manifest => {
      manifest.formal = formal;
      manifest.formalReadiness = readyFormalManifest().formalReadiness;
    });
    await assert.rejects(applyCutover(value.manifestPath, digest, value.journalPath, {}, 'apply'), /fixed formal/);
    assert.equal(await exists(value.journalPath), false);
    assert.equal(await exists(value.target), false);
  }
});

test('formal apply keeps an old blocked manifest and out-of-scope ready file from reaching user data', async () => {
  const directory = await mkdtemp(join(validation, 'cutover-formal-policy-'));
  const path = join(directory, 'formal.json'), journal = join(directory, 'result.json');
  const manifest = { format: 'agent-resource-manager-bound-cutover-v1', ...readyFormalManifest(), formalApplyBlocked: true };
  await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(applyCutover(path, hash(await readFile(path)), journal, {}, 'apply'), /remains blocked/);
  manifest.formalApplyBlocked = false;
  manifest.sourceReport = join(directory, 'review.json');
  await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(applyCutover(path, hash(await readFile(path)), journal, {}, 'apply'), /approved report tree/);
  assert.equal(await exists(journal), false);
});

test('execution CLI separates explicit apply from prepare and isolated rehearsal without implicit modes', () => {
  for (const mode of ['apply', 'rehearse']) {
    const values = parseCutoverOptions(['--mode', mode, '--manifest', 'bound.json', '--sha256', 'a'.repeat(64), '--journal', 'result.json']);
    assert.equal(values['--mode'], mode);
  }
  assert.equal(parseCutoverOptions(['--mode', 'prepare', '--report', 'review.json', '--output', 'bound.json'])['--mode'], 'prepare');
  for (const args of [
    [], ['--mode', 'apply'], ['--mode', 'apply', '--report', 'review.json', '--output', 'bound.json'],
    ['--mode', 'apply', '--manifest', 'bound.json', '--sha256', 'bad', '--journal', 'result.json'],
    ['--mode', 'rehearse', '--manifest', 'bound.json', '--sha256', 'a'.repeat(64), '--journal', 'result.json', '--report', 'extra.json'],
    ['--mode', 'apply', '--manifest', '--journal', '--sha256', 'a'.repeat(64)],
  ]) assert.throws(() => parseCutoverOptions(args));
});

test('formal execution reuses writer and content guards and preparation remains pending', async () => {
  const source = await readFile(new URL('../scripts/formal-cutover.mjs', import.meta.url), 'utf8');
  const prepared = source.slice(source.indexOf('export async function prepareCutover('), source.indexOf('async function saveJournal('));
  assert.match(prepared, /formalReadiness: \{[^\n]*status: 'pending'[^\n]*legacyLauncher: 'pending'[^\n]*legacyDataPointer: 'pending'/);
  const execution = source.slice(source.indexOf('export async function applyCutover('), source.indexOf('async function applyBoundCutover('));
  assert.match(source, /if \(await digest\(manifest.sourceReport\) !== manifest.sourceReportSha256\) throw/);
  const apply = source.slice(source.indexOf('async function applyBoundCutover('), source.indexOf('export function parseCutoverOptions('));
  assert.ok(apply.indexOf('await noWriters(manifest)') < apply.indexOf('await writeFile(journalFile'));
  assert.match(apply, /await preflight\(manifest, journal, writes\);\s*await publishFiles/);
  assert.match(apply, /databaseIdentity\(databaseMove.destination\) !== manifest.database.logicalSha256/);
  assert.match(source, /const candidateRoot = manifest.formal \? projectRoot : validationRoot/);
  assert.ok(execution.includes('validateCutoverMode(manifest, mode)'));
});

test('formal initial database physical CAS adds protection without rejecting its recorded checkpoint retry', async () => {
  const source = await readFile(new URL('../scripts/formal-cutover.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function preflight('), source.indexOf('async function publishFiles('));
  const path = join(validation, 'cutover-pure-source', 'manager.sqlite3'), destination = join(validation, 'cutover-pure-target', 'data', 'manager.sqlite3');
  const tree = { kind: 'file', files: [{ path: '', bytes: 4, sha256: 'a'.repeat(64) }], directories: [] };
  let currentTree = structuredClone(tree), currentLogical = 'logical-baseline';
  const manifest = { formal: true, database: { source: path, logicalSha256: currentLogical }, deploy: [], moves: [{ source: path, destination, tree }] };
  const preflight = new Function('ordinaryAncestors', 'absent', 'sameTree', 'bindTree', 'databaseFamily', 'databaseIdentity', `return (${body});`)(
    async () => {}, async item => item === path ? {} : null,
    (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected), async () => currentTree,
    (_manifest, item) => item === path, () => currentLogical,
  );
  assert.equal((await preflight(manifest, { databasePhase: 'pending' }, [])).length, 1);
  currentTree.files[0].sha256 = 'b'.repeat(64);
  await assert.rejects(preflight(manifest, { databasePhase: 'pending' }, []), /database physical content changed/);
  assert.equal((await preflight(manifest, { databasePhase: 'checkpointing' }, [])).length, 1);
  currentLogical = 'external-logical-change';
  await assert.rejects(preflight(manifest, { databasePhase: 'checkpointing' }, []), /database logical content changed/);
});

async function rewriteManifest(value, change) {
  const manifest = JSON.parse(await readFile(value.manifestPath));
  change(manifest);
  const bytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(value.manifestPath, bytes);
  return hash(bytes);
}

async function databaseBytes(value) {
  return Promise.all([value.database, `${value.database}-wal`].map(async path => await exists(path) ? hash(await readFile(path)) : null));
}

test('a database binding outside the declared roots is rejected before any journal or SQLite write', async () => {
  const value = await prepared(), external = await fixture();
  const before = await databaseBytes(external);
  const digest = await rewriteManifest(value, manifest => { manifest.database.source = external.database; });
  await assert.rejects(applyCutover(value.manifestPath, digest, value.journalPath), /canonical sourceRoot/);
  assert.deepEqual(await databaseBytes(external), before);
  assert.equal(await exists(value.journalPath), false);
  assert.equal(await exists(value.target), false);
});

test('missing or repeated database moves and redirected WAL destinations are rejected before writes', async () => {
  for (const change of ['missing', 'repeated', 'wal-target']) {
    const value = await prepared(), before = await databaseBytes(value);
    const digest = await rewriteManifest(value, manifest => {
      const database = manifest.moves.find(move => move.source === value.database);
      if (change === 'missing') manifest.moves = manifest.moves.filter(move => move !== database);
      if (change === 'repeated') manifest.moves.push({ ...database });
      if (change === 'wal-target') manifest.moves.find(move => move.source.endsWith('-wal')).destination = join(value.target, 'elsewhere-wal');
    });
    await assert.rejects(applyCutover(value.manifestPath, digest, value.journalPath), /canonical|non-overlapping/);
    assert.deepEqual(await databaseBytes(value), before);
    assert.equal(await exists(value.journalPath), false);
  }
});

test('all deployment sources, publication destinations and staging conflicts are checked before checkpoint', async () => {
  for (const change of ['source-changed', 'source-missing', 'deploy-target', 'generated-target', 'staging-target']) {
    const value = await prepared(), before = await databaseBytes(value), manifest = JSON.parse(await readFile(value.manifestPath));
    let retained;
    if (change === 'source-changed') await writeFile(manifest.deploy[0].source, 'changed candidate');
    if (change === 'source-missing') await rename(manifest.deploy[0].source, `${manifest.deploy[0].source}.held`);
    if (change === 'deploy-target') retained = manifest.deploy[0].destination;
    if (change === 'generated-target') retained = manifest.generated[0].path;
    if (change === 'staging-target') retained = `${manifest.deploy[0].destination}.cutover-${manifest.deploy[0].tree.files[0].sha256.slice(0, 16)}.pending`;
    if (retained) { await mkdir(dirname(retained), { recursive: true }); await writeFile(retained, 'external file stays'); }
    await assert.rejects(applyCutover(value.manifestPath, value.bound.sha256, value.journalPath), /source changed|ENOENT|already exists|not owned/);
    assert.deepEqual(await databaseBytes(value), before);
    assert.equal(await exists(value.journalPath), false);
    if (retained) assert.equal(await readFile(retained, 'utf8'), 'external file stays');
  }
});

for (const kind of ['deploy', 'generated']) {
  for (const gap of ['partial-staging', 'staged-before-rename', 'renamed-before-acknowledgement']) {
    test(`${kind} resumes through ${gap} without exposing a partial final file or moving data early`, async () => {
      const value = await prepared(), before = await databaseBytes(value);
      let publication;
      const hooks = {};
      if (gap === 'partial-staging') hooks.afterStagingCreated = async entry => {
        if (entry.kind !== kind) return;
        publication = entry;
        await writeFile(entry.staging, entry.bytes.subarray(0, Math.max(1, Math.floor(entry.bytes.length / 2))));
        throw new Error('publication interruption');
      };
      if (gap === 'staged-before-rename') hooks.afterStagingWrite = entry => { if (entry.kind === kind) { publication = entry; throw new Error('publication interruption'); } };
      if (gap === 'renamed-before-acknowledgement') hooks.afterPublication = entry => { if (entry.kind === kind) { publication = entry; throw new Error('publication interruption'); } };
      await assert.rejects(applyCutover(value.manifestPath, value.bound.sha256, value.journalPath, hooks), /publication interruption/);
      assert.deepEqual(await databaseBytes(value), before);
      assert.equal(await exists(publication.path), gap === 'renamed-before-acknowledgement');
      assert.equal((await applyCutover(value.manifestPath, value.bound.sha256, value.journalPath)).status, 'completed');
      assert.equal(hash(await readFile(publication.path)), publication.sha256);
      assert.equal(await exists(publication.staging), false);
    });
  }
}

test('resume refuses a journal that tries to replace an ordinary file binding through databaseMoves', async () => {
  const value = await prepared();
  let moved;
  await assert.rejects(applyCutover(value.manifestPath, value.bound.sha256, value.journalPath, { afterMove(move) { moved = move; throw new Error('synthetic interruption'); } }), /synthetic interruption/);
  const manifest = JSON.parse(await readFile(value.manifestPath)), journal = JSON.parse(await readFile(value.journalPath));
  const ordinary = manifest.moves.find(move => move.source === moved.source);
  journal.databaseMoves.push({ ...ordinary });
  await writeFile(value.journalPath, JSON.stringify(journal));
  const database = await databaseBytes(value);
  await assert.rejects(applyCutover(value.manifestPath, value.bound.sha256, value.journalPath), /canonical WAL family/);
  assert.deepEqual(await databaseBytes(value), database);
  assert.equal(await exists(moved.source), false);
});

test('resume at checkpointing refuses a missing source database without creating an empty replacement', async () => {
  const value = await prepared();
  await assert.rejects(applyCutover(value.manifestPath, value.bound.sha256, value.journalPath, { afterPublication() { throw new Error('publication interruption'); } }), /publication interruption/);
  const journal = JSON.parse(await readFile(value.journalPath));
  journal.databasePhase = 'checkpointing'; await writeFile(value.journalPath, JSON.stringify(journal));
  const held = join(value.directory, 'held-database'); await mkdir(held);
  for (const suffix of ['', '-wal', '-shm']) if (await exists(`${value.database}${suffix}`)) await rename(`${value.database}${suffix}`, join(held, `manager.sqlite3${suffix}`));
  const before = hash(await readFile(join(held, 'manager.sqlite3')));
  await assert.rejects(applyCutover(value.manifestPath, value.bound.sha256, value.journalPath), /unable to open|missing/);
  assert.equal(await exists(value.database), false);
  assert.equal(hash(await readFile(join(held, 'manager.sqlite3'))), before);
});

test('a new later publication target appearing after preflight is refused before moving canonical data', async () => {
  const value = await prepared(), before = await databaseBytes(value), manifest = JSON.parse(await readFile(value.manifestPath));
  const later = manifest.deploy[1].destination;
  let injected = false;
  await assert.rejects(applyCutover(value.manifestPath, value.bound.sha256, value.journalPath, { async afterPublication() {
    if (!injected) { injected = true; await mkdir(dirname(later), { recursive: true }); await writeFile(later, 'external later destination'); }
  } }), /destination appeared or changed/);
  assert.equal(await readFile(later, 'utf8'), 'external later destination');
  assert.deepEqual(await databaseBytes(value), before);
  assert.equal(await exists(join(value.target, 'data', 'manager.sqlite3')), false);
});

test('an earlier published file changed during later publication cannot lead to checkpoint or completion', async () => {
  const value = await prepared(), before = await databaseBytes(value), manifest = JSON.parse(await readFile(value.manifestPath));
  const first = manifest.deploy[0].destination;
  await assert.rejects(applyCutover(value.manifestPath, value.bound.sha256, value.journalPath, { async afterPublication(entry) {
    if (entry.path === manifest.deploy[1].destination) await writeFile(first, 'changed earlier published file');
  } }), /destination already exists or differs/);
  assert.equal(await readFile(first, 'utf8'), 'changed earlier published file');
  assert.deepEqual(await databaseBytes(value), before);
  assert.equal(await exists(join(value.target, 'data', 'manager.sqlite3')), false);
});

test('a published file changed during ordinary moves is detected before completion', async () => {
  const value = await prepared(), manifest = JSON.parse(await readFile(value.manifestPath));
  const first = manifest.deploy[0].destination;
  await assert.rejects(applyCutover(value.manifestPath, value.bound.sha256, value.journalPath, { async afterMove() { await writeFile(first, 'changed after data move began'); } }), /destination already exists or differs/);
  assert.equal(await readFile(first, 'utf8'), 'changed after data move began');
  assert.equal(JSON.parse(await readFile(value.journalPath)).status, 'applying');
});
