import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyManagerProcess, isWithin, mapSourceEntry, parseOptions, powershell, validateManifestEntries, verifyD0TestOnlyDifferences } from '../scripts/prepare-formal-cutover.mjs';

const oldRoot = 'D:\\03_github_projects\\skill_manager';
const newRoot = 'D:\\03_github_projects\\Agent_Resource_Manager';
const testRoot = join(newRoot, 'validation', 'manager-data');
const candidate = join(newRoot, 'dev', 'source', 'outputs', 'candidate', 'agent-resource-manager.exe');

test('actual PowerShell JSON preserves Chinese filenames for launcher classification', async () => {
  const name = '启动 Skill Manager.cmd';
  const result = await powershell(`[pscustomobject]@{name='${name}';path='${join(oldRoot, name)}'}|ConvertTo-Json -Compress`);
  assert.equal(result.name, name);
  assert.equal(result.path, join(oldRoot, name));
  const mapped = mapSourceEntry({ path: result.path, kind: 'file', bytes: 46, reparse: false }, oldRoot, newRoot);
  assert.equal(mapped.action, 'review-launcher-forwarding');
});

test('planning parser refuses apply, ambiguous arguments and incomplete candidate identity', () => {
  assert.throws(() => parseOptions(['--apply', 'true']));
  assert.throws(() => parseOptions(['--mode', 'apply', '--output', 'new.json']));
  assert.throws(() => parseOptions(['--mode', 'plan', '--output', 'new.json']));
  assert.throws(() => parseOptions(['--mode', 'inventory', '--output', 'new.json', '--candidate', candidate]));
  assert.throws(() => parseOptions(['--mode', 'inventory', '--output', 'a.json', '--output', 'b.json']));
  assert.equal(parseOptions(['--mode', 'inventory', '--output', 'new.json']).mode, 'inventory');
});

test('Windows containment respects directory boundaries and namespace prefixes', () => {
  assert.equal(isWithin(join(oldRoot, 'manager.sqlite3'), oldRoot), true);
  assert.equal(isWithin(`${oldRoot}-other\\manager.sqlite3`, oldRoot), false);
  assert.equal(isWithin(`\\\\?\\${oldRoot}\\manager.sqlite3`, oldRoot), true);
});

test('runtime and unique history remain retained while database family receives explicit moves', () => {
  const entry = name => ({ path: join(oldRoot, name), kind: 'file', bytes: 4, reparse: false });
  assert.equal(mapSourceEntry(entry('SKILL-MANAGER.EXE'), oldRoot, newRoot).action, 'retain-in-place');
  assert.equal(mapSourceEntry(entry('unique-notes.md'), oldRoot, newRoot).action, 'retain-review-required');
  const database = mapSourceEntry(entry('manager.sqlite3-wal'), oldRoot, newRoot);
  assert.equal(database.action, 'move-after-database-close');
  assert.equal(database.destination, join(newRoot, 'data', 'manager.sqlite3-wal'));
  const recovery = mapSourceEntry(entry('private-recovery\\original\\file.dat'), oldRoot, newRoot);
  assert.equal(recovery.destination, join(newRoot, 'data', 'private-recovery', 'original', 'file.dat'));
  assert.throws(() => mapSourceEntry({ path: `${oldRoot}-other\\x`, reparse: false }, oldRoot, newRoot));
});

test('reparse sources are retained without a move or target traversal', () => {
  const entry = { path: join(oldRoot, 'webview', 'link'), kind: 'directory', reparse: true };
  const mapped = mapSourceEntry(entry, oldRoot, newRoot);
  assert.equal(mapped.action, 'retain-review-required');
  assert.equal(mapped.destination, entry.path);
});

test('known isolated performance processes do not become formal writer blockers', () => {
  const process = { pid: 52, name: 'agent-resource-manager.exe', executable: candidate,
    commandLine: `"${candidate}" --data-dir "${join(testRoot, 'uia-performance-active', 'data')}"` };
  const result = classifyManagerProcess(process, oldRoot, newRoot, testRoot);
  assert.equal(result.classification, 'isolated-validation-process');
  assert.equal(result.blocksCutover, false);
});

test('formal executable, explicit formal database, ambiguous roots and missing process evidence block cutover', () => {
  const classify = process => classifyManagerProcess({ pid: 53, name: 'agent-resource-manager.exe', ...process }, oldRoot, newRoot, testRoot);
  assert.equal(classify({ executable: join(oldRoot, 'skill-manager.exe') }).blocksCutover, true);
  assert.equal(classify({ executable: join(newRoot, 'app', 'agent-resource-manager.exe') }).blocksCutover, true);
  assert.equal(classify({ executable: candidate, commandLine: `"${candidate}" --data-dir "${oldRoot}"` }).classification, 'formal-data-writer');
  assert.equal(classify({ executable: candidate, commandLine: `"${candidate}" --data-dir "${testRoot}-other"` }).blocksCutover, true);
  assert.equal(classify({ executable: candidate, commandLine: `"${candidate}" --data-dir "${testRoot}" --data-dir "${oldRoot}"` }).blocksCutover, true);
  assert.equal(classify({ executable: null, commandLine: null }).blocksCutover, true);
});

test('candidate manifests reject traversal, case duplicates, malformed hashes and absolute paths', () => {
  const entry = path => ({ path, sha256: 'a'.repeat(64) });
  validateManifestEntries([entry('src/main.ts')]);
  assert.throws(() => validateManifestEntries([entry('../outside.txt')]));
  assert.throws(() => validateManifestEntries([entry('src/./main.ts')]));
  assert.throws(() => validateManifestEntries([entry('src/Main.ts'), entry('SRC/main.ts')]));
  assert.throws(() => validateManifestEntries([entry('D:\\outside.txt')]));
  assert.throws(() => validateManifestEntries([{ path: 'src/main.ts', sha256: 'short' }]));
});

async function d0EquivalenceInputs() {
  const source = join(newRoot, 'dev', 'source');
  const entries = JSON.parse(await readFile(join(source, 'outputs/v1-validation/detached-task-summary-allocation-20261109/candidate-runtime-source-manifest.json'), 'utf8'));
  const acceptance = JSON.parse(await readFile(join(source, 'outputs/v1-validation/real-runtime-acceptance-20261110.json'), 'utf8'));
  return {
    source, entries, differences: acceptance.originalRuntimeManifest.rawDifferences,
    identity: { executableSha256: 'd0b6551f5fd11125ec6f548b7239643f9076a6ccec0ccf54f6afca15e8ce87e0', manifestSha256: '0a9936d0c021391740efe8bcc676981e516d9a8f7806ffb88ec151430a94ebaa' },
  };
}

test('d0 equivalence verifies exactly the four recorded differences and retains their raw hashes', async () => {
  const { identity, entries, differences } = await d0EquivalenceInputs();
  const verified = await verifyD0TestOnlyDifferences(identity, entries, differences);
  assert.equal(verified.differences.length, 4);
  assert.deepEqual(verified.differences.map(({ productionEquivalent, ...item }) => item), differences);
  assert.ok(verified.differences.every(item => item.productionEquivalent && item.currentSha256 !== item.d0Sha256));
  assert.deepEqual(verified.proofs.map(item => item.sha256), [
    'a15d3aa3d71106613dceeb027b1c97bd4faac784438b67e8ccb262fefac42e1c',
    'f7d4bcfa4e590e1201e5c11adc2338d44cfa9148362c776338dcbba754163c97',
  ]);
});

test('d0 equivalence refuses another executable, manifest, unrecorded path or changed raw source', async () => {
  const { identity, entries, differences, source } = await d0EquivalenceInputs();
  for (const [changedIdentity, changedEntries] of [
    [{ ...identity, executableSha256: 'b'.repeat(64) }, entries],
    [{ ...identity, manifestSha256: 'b'.repeat(64) }, entries],
    [identity, entries.slice(1)],
  ]) await assert.rejects(verifyD0TestOnlyDifferences(changedIdentity, changedEntries, differences), /recorded d0/);
  await assert.rejects(verifyD0TestOnlyDifferences(identity, entries, [...differences, differences[0]]), /unique subset/);
  await assert.rejects(verifyD0TestOnlyDifferences(identity, entries, [{ ...differences[0], path: 'src-tauri/src/tasks.rs' }]), /Unrecorded/);
  await assert.rejects(verifyD0TestOnlyDifferences(identity, entries, [{ ...differences[0], currentSha256: 'b'.repeat(64) }]), /Unrecorded/);
  await assert.rejects(verifyD0TestOnlyDifferences(identity, entries, differences, async path => Buffer.concat([await readFile(join(source, path)), Buffer.from('\nchanged source')])), /Unrecorded/);
});

test('d0 equivalence refuses a test module when its production parent or cfg guard changes', async () => {
  const { identity, entries, differences, source } = await d0EquivalenceInputs();
  for (const [testFile, parentFile] of [
    ['src-tauri/src/resource_automation/engine_tests.rs', 'src-tauri/src/resource_automation/engine.rs'],
    ['src-tauri/src/resource_update/tests.rs', 'src-tauri/src/resource_update.rs'],
  ]) {
    const selected = differences.filter(item => item.path === testFile);
    await assert.rejects(verifyD0TestOnlyDifferences(identity, entries, selected, async path => {
      const bytes = await readFile(join(source, path));
      return path === parentFile ? Buffer.from(bytes.toString('utf8').replace('#[cfg(test)]', '#[cfg(not(test))]')) : bytes;
    }), /parent changed beyond/);
  }
});

test('candidate planning reports raw differences and separately derived production equivalence', async () => {
  const source = await readFile(new URL('../scripts/prepare-formal-cutover.mjs', import.meta.url), 'utf8');
  assert.match(source, /const mismatches = rawDifferences.filter\(item => !equivalent.differences.some/);
  assert.match(source, /rawSourcesMatch: rawDifferences.length === 0, rawSourceDifferences: rawDifferences/);
  assert.match(source, /productionEquivalent: rawDifferences.length > 0 && mismatches.length === 0/);
  assert.match(source, /testOnlySourceDifferences: equivalent.differences, equivalenceProofs: equivalent.proofs, equivalenceError/);
});
