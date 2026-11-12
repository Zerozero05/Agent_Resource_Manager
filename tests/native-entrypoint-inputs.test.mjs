import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { entryOptions, inspectEntrypoints, legacyEffectiveData, legacyForwarder, planEntryChildEnvironment, validateEntrypointDataset } from '../scripts/verify-native-entrypoints.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = resolve(projectRoot, '..', '..', 'validation', 'manager-data', 'entrypoint-synthetic-input-test');
const program = join(base, 'legacy', 'app', 'skill-manager.exe'), data = join(base, 'legacy-data');

function dataset(root = base) {
  const old = join(root, 'legacy', 'app', 'skill-manager.exe'), next = join(root, 'new', 'app', 'agent-resource-manager.exe');
  const phase = (name, legacy) => ({ name, executable: legacy ? old : next, dataDirectory: join(root, legacy ? 'legacy-data' : 'new-data'), reportPath: join(root, `${name}-driver.json`), sha256: (legacy ? 'a' : 'b').repeat(64), commandLineArguments: [], removeDataDirectoryEnvironment: true, requireBackendStatus: !legacy });
  return { format: 'agent-resource-manager-native-entrypoints-v1', syntheticOnly: true, root, temporary: join(root, 'native-temp'), sentinel: join(root, 'unused-environment-data'),
    legacy: { executable: old, sha256: 'a'.repeat(64) }, candidate: { executable: next, sha256: 'b'.repeat(64) },
    phases: [phase('legacy-sidecar', true), phase('new-bootstrap', false), { ...phase('legacy-launcher-forwarding', false), launcher: join(root, 'legacy', '启动 Skill Manager.cmd') }] };
}

test('legacy UTF-8 absolute sidecar resolves the intended data root and validates one-line input', () => {
  assert.equal(legacyEffectiveData({ program, sidecar: `\uFEFF${data}\r\n`, expectedData: data }).effective, data);
  assert.equal(legacyEffectiveData({ program, sidecar: '../../legacy-data\n', expectedData: data }).effective, data);
  for (const sidecar of ['', ' \n', `${data}\nwrong`, `${data}\0`, 'x'.repeat(4097)]) assert.throws(() => legacyEffectiveData({ program, sidecar, expectedData: data }));
});

test('existing bootstrap overrides are checked and conflicting or pending migrations block entrypoint preparation', () => {
  const bootstrap = { formatVersion: 1, config: { managedRoot: base, overrides: { state: data } } };
  assert.equal(legacyEffectiveData({ program, sidecar: data, bootstrap, expectedData: data }).bootstrapPresent, true);
  assert.throws(() => legacyEffectiveData({ program, sidecar: data, bootstrap: { ...bootstrap, config: { managedRoot: join(base, 'wrong') } }, expectedData: data }), /conflicts/);
  assert.throws(() => legacyEffectiveData({ program, sidecar: data, bootstrap: { ...bootstrap, pending: { previous: {} } }, expectedData: data }), /pending migration/);
  assert.throws(() => legacyEffectiveData({ program, sidecar: data, bootstrap: { ...bootstrap, formatVersion: 2 }, expectedData: data }), /invalid/);
});

test('planned child environment clears all casing variants of the data-directory variable without mutating its parent', () => {
  const environment = { Path: 'existing', SKILL_MANAGER_DATA_DIR: 'wrong-a', skill_manager_data_dir: 'wrong-b', OTHER: 'keep' };
  const result = planEntryChildEnvironment(environment, join(base, 'native-temp'), join(base, 'unused-environment-data'));
  assert.equal(result.planOnly, true);
  assert.equal(result.child.SKILL_MANAGER_DATA_DIR, undefined);
  assert.equal(result.child.skill_manager_data_dir, undefined);
  assert.equal(result.child.OTHER, 'keep');
  assert.equal(result.child.TEMP, join(base, 'native-temp'));
  assert.equal(result.parent.SKILL_MANAGER_DATA_DIR, join(base, 'unused-environment-data'));
  assert.equal(environment.SKILL_MANAGER_DATA_DIR, 'wrong-a');
});

test('the forwarding launcher contains only the chosen literal new executable', () => {
  const executable = join(base, 'new', 'app', 'agent-resource-manager.exe');
  assert.equal(legacyForwarder(executable), `@echo off\r\nstart "" "${executable}"\r\n`);
  for (const path of ['relative.exe', `${executable}\nother`, `${executable}%EXTRA%`, `${executable}"`]) assert.throws(() => legacyForwarder(path));
});

test('three exact phases preserve identities and prohibit CLI data overrides and escaped test paths', () => {
  assert.equal(validateEntrypointDataset(dataset()).phases.length, 3);
  for (const change of ['argument', 'environment', 'hash', 'data', 'temporary', 'launcher']) {
    const value = dataset();
    if (change === 'argument') value.phases[0].commandLineArguments = ['--data-dir', data];
    if (change === 'environment') value.phases[0].removeDataDirectoryEnvironment = false;
    if (change === 'hash') value.phases[0].sha256 = 'b'.repeat(64);
    if (change === 'data') value.phases[1].dataDirectory = 'D:\\03_github_projects\\skill_manager';
    if (change === 'temporary') value.temporary = 'C:\\Temp';
    if (change === 'launcher') value.phases[2].launcher = 'D:\\03_github_projects\\skill_manager\\启动 Skill Manager.cmd';
    assert.throws(() => validateEntrypointDataset(value));
  }
});

test('CLI exposes only explicit preparation and file inspection and refuses a GUI run', () => {
  assert.equal(entryOptions(['--mode', 'inspect', '--fixture', base]).mode, 'inspect');
  assert.throws(() => entryOptions(['--mode', 'prepare']), /requires/);
  assert.throws(() => entryOptions(['--mode', 'run', '--fixture', base]), /No GUI run/);
  assert.throws(() => execFileSync(process.execPath, ['scripts/verify-native-entrypoints.mjs', '--mode', 'inspect', '--fixture', join(base, 'missing')], { cwd: projectRoot, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), error => error.status === 1 && /ENOENT/.test(error.stderr) && error.stdout === '');
});

async function inspectionFixture() {
  const root = await mkdtemp(join(dirname(base), 'entrypoint-boundary-'));
  const value = dataset(root), sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  const oldBytes = 'generated old test bytes', nextBytes = 'generated new test bytes';
  for (const path of [dirname(value.legacy.executable), dirname(value.candidate.executable), value.temporary, value.sentinel, value.phases[0].dataDirectory, value.phases[1].dataDirectory]) await mkdir(path, { recursive: true });
  value.legacy.sha256 = sha256(oldBytes); value.candidate.sha256 = sha256(nextBytes);
  for (const phase of value.phases) phase.sha256 = phase.name === 'legacy-sidecar' ? value.legacy.sha256 : value.candidate.sha256;
  await writeFile(value.legacy.executable, oldBytes); await writeFile(value.candidate.executable, nextBytes);
  await writeFile(join(dirname(value.legacy.executable), 'data-directory.txt'), `${value.phases[0].dataDirectory}\n`);
  await writeFile(join(dirname(value.candidate.executable), 'data-directory.txt'), '.\n');
  const bootstrap = { formatVersion: 1, config: { managedRoot: join(root, 'new'), overrides: { state: join(root, 'new-data'), webview: join(root, 'new', 'cache', 'webview'), recovery: join(root, 'new', 'data', 'recovery'), receipts: join(root, 'new', 'data', 'receipts'), temp: join(root, 'new', 'cache', 'temp') } } };
  await writeFile(join(dirname(value.candidate.executable), 'storage-paths.json'), JSON.stringify(bootstrap));
  await writeFile(value.phases[2].launcher, legacyForwarder(value.candidate.executable));
  await writeFile(join(root, 'dataset.json'), JSON.stringify(value));
  return value;
}

test('a complete generated fixture is file-inspected while native and child-environment execution remain pending', async () => {
  const value = await inspectionFixture(), result = await inspectEntrypoints(value.root);
  assert.equal(result.status, 'entrypoint-files-inspected-native-run-pending');
  assert.equal(result.guiRun, false);
  assert.equal(result.environmentCheck, 'plan-only-no-child-process-launched');
});

test('any later legacy bootstrap is refused before inspecting it as a launchable configuration', async () => {
  const value = await inspectionFixture(), path = join(dirname(value.legacy.executable), 'storage-paths.json');
  const variants = [
    { formatVersion: 1, config: { managedRoot: value.root, overrides: { state: value.phases[0].dataDirectory, webview: 'C:\\outside-profile' } } },
    { formatVersion: 1, unknown: 'Rust rejects this field', config: { managedRoot: value.phases[0].dataDirectory } },
    { formatVersion: 1, config: { managedRoot: value.phases[0].dataDirectory, overrides: { state: '' } } },
    null,
  ];
  for (const bootstrap of variants) {
    await writeFile(path, bootstrap ? JSON.stringify(bootstrap) : 'unparseable JSON');
    await assert.rejects(inspectEntrypoints(value.root), /Unexpected legacy bootstrap/);
    assert.equal(await readFile(path, 'utf8'), bootstrap ? JSON.stringify(bootstrap) : 'unparseable JSON');
  }
});

test('inspection checks the approved fixture root before reading a dataset', async () => {
  for (const root of [projectRoot, 'C:\\Users', 'relative-fixture']) await assert.rejects(inspectEntrypoints(root), /outside the approved validation tree/);
  const value = await inspectionFixture(), file = join(value.root, 'ordinary-file');
  await writeFile(file, 'not a directory');
  await assert.rejects(inspectEntrypoints(file), /ordinary directory/);
});

test('inspection rejects a junction fixture root and retains its generated target', async () => {
  const value = await inspectionFixture(), link = join(dirname(value.root), `${value.root.split(/[\\/]/).at(-1)}-link`);
  await symlink(value.root, link, 'junction');
  await assert.rejects(inspectEntrypoints(link), /reparse path/);
  assert.equal(JSON.parse(await readFile(join(value.root, 'dataset.json'))).root, value.root);
});

test('inspection refuses a linked dataset file before reading its generated external target', async () => {
  for (const kind of ['symbolic', 'hard']) {
    const value = await inspectionFixture(), external = await inspectionFixture();
    const path = join(value.root, 'dataset.json'), target = join(external.root, 'dataset.json');
    await rename(path, join(value.root, 'held-dataset.json'));
    const before = await readFile(target, 'utf8');
    if (kind === 'symbolic') await symlink(target, path, 'file'); else await link(target, path);
    await assert.rejects(inspectEntrypoints(value.root), /reparse path|single-link file/);
    assert.equal(await readFile(target, 'utf8'), before);
  }
});
