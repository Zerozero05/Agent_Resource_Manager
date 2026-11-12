import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeUiaSession } from './native-uia-client.mjs';
import { createPerformanceFixture, FIXTURE_FORMAT } from './performance-fixture.mjs';

// No backend mutation shortcut: even package preparation and candidate commit
// are submitted by exactly one invocation of their real native UI controls.
const FORMAT = 'agent-resource-manager-native-packages-v1';
const VALIDATION = 'D:\\03_github_projects\\Agent_Resource_Manager\\validation';
const MANAGER_DATA = join(VALIDATION, 'manager-data');
const RESOURCE_DATA = join(VALIDATION, 'resources');
const VERSIONS = ['0.0.82', '0.0.83'];
const DEPENDENCY_VERSION = { '0.0.82': '1.64.0-alpha-1789764292000', '0.0.83': '1.64.0-alpha-1790635538000' };
const ARGS = new Set(['phase', 'prepared', 'candidate', 'candidate-build-info', 'await-foreground', 'help']);
const options = {};
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  if (!flag.startsWith('--') || !ARGS.has(flag.slice(2))) throw new Error('Unknown argument; use --help.');
  const key = flag.slice(2);
  if (key === 'help') options[key] = true;
  else {
    const value = process.argv[++index];
    if (!value || value.startsWith('--') || Object.hasOwn(options, key)) throw new Error(`Missing or duplicate --${key}.`);
    options[key] = value;
  }
}
if (options.help) {
  console.log('Default: prepare generated test data only. Run: --phase run --prepared <report.json> --candidate <release exe> --candidate-build-info <json> [--await-foreground true]. The optional foreground wait is restricted to run; after native readiness it prints the owned PID/HWND and waits up to sixty seconds for external activation using read-only observations, without input or focus retries. The run downloads exact official Playwright MCP 0.0.82 and 0.0.83 packages through the real native UI, installs/stages them in independent selected D-drive directories, checks CLI-only verification and confirms one version switch. It does not test browser operations or touch existing tool roots.');
  process.exit(0);
}
const phase = options.phase || 'prepare';
assert.ok(['prepare', 'run'].includes(phase), 'Use --phase prepare or --phase run.');
if (options['await-foreground'] !== undefined) {
  assert.ok(['true', 'false'].includes(options['await-foreground']), '--await-foreground requires an explicit true or false.');
  assert.equal(phase, 'run', '--await-foreground is available only for --phase run.');
}
const awaitForeground = options['await-foreground'] === 'true';
assert.equal(process.platform, 'win32', 'This native UI acceptance requires Windows.');
const normalized = value => resolve(value.replace(/^\\\\\?\\(?=[a-z]:\\)/i, ''));
const same = (left, right) => typeof left === 'string' && typeof right === 'string' && normalized(left).toLowerCase() === normalized(right).toLowerCase();
const inside = (path, root) => { const rel = relative(normalized(root), normalized(path)); return rel === '' || !rel.startsWith('..') && !isAbsolute(rel); };
const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
const active = task => ['queued', 'running'].includes(task.status);
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function digest(path, algorithm = 'sha256', encoding = 'hex') { const hash = createHash(algorithm); for await (const data of createReadStream(path)) hash.update(data); return hash.digest(encoding); }
async function json(path, max = 16 * 1024 * 1024) { assert.ok((await lstat(path)).size <= max, 'JSON evidence is unexpectedly large.'); return JSON.parse(await readFile(path, 'utf8')); }
async function waitRead(read, predicate, ms = 60000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() >= deadline) throw new Error('The exact native UI/task state did not become ready. No confirmation was replayed.');
    await sleep(120);
  }
}
async function assertPlainDirectory(path) {
  const metadata = await lstat(path);
  assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink(), 'The selected validation directory must be a plain directory.');
  assert.ok(same(await realpath(path), path), 'A validation directory may not resolve through a different target.');
}
async function prepare() {
  await mkdir(MANAGER_DATA, { recursive: true }); await mkdir(RESOURCE_DATA, { recursive: true });
  const output = await mkdtemp(join(MANAGER_DATA, 'native-packages-'));
  const resourcesRoot = await mkdtemp(join(RESOURCE_DATA, 'native-packages-'));
  const fixture = await createPerformanceFixture(output, 'catalogue', 0);
  const paths = {};
  for (const version of VERSIONS) {
    const root = join(resourcesRoot, `v${version}`), work = join(root, 'work'), downloads = join(root, 'downloads');
    await mkdir(root); await mkdir(work); await mkdir(downloads);
    paths[version] = { root, work, downloads, runtime: join(root, 'runtime') };
  }
  const sentinel = join(resourcesRoot, 'generated-personal-data.txt');
  await writeFile(sentinel, 'Original generated data outside both runtimes; never copied or used by a tool.\n', { flag: 'wx' });
  const report = {
    format: FORMAT, status: 'prepared-not-run', output, resourcesRoot, fixture, paths,
    versions: VERSIONS, nodePath: process.execPath, nodeSha256: await digest(process.execPath),
    sentinel: { path: sentinel, sha256: await digest(sentinel) },
    generatedDatabaseSha256: await digest(fixture.dbPath), createdAt: new Date().toISOString(),
    scope: {
      packages: 'Exact official @playwright/mcp 0.0.82 and 0.0.83 with their complete reviewed three-package npm closures.',
      writes: 'Generated manager database only; downloaded artifacts, work and both new final runtimes stay in the independently selected validation/resources subtree.',
      confirmations: 'Each prepare/download/materialize/commit/switch write uses a separate current preview and one real UI confirmation. There is no task-dispatch write shortcut or reusable confirmation flag.',
      verification: 'CLI version/help and the actual post-switch entry only. No browser connection, tab/page read, authenticated session, arbitrary custom action or platform coverage is claimed.',
      preservation: 'No user database, existing tool files, profiles, source tree or backup is copied. No cleanup, forced termination or deletion is requested.',
    },
    stages: [], checks: {}, limitations: ['The existing user Edge Control browser capability remains outside this separate CLI-only test resource.', 'Network duration depends on the actual official registry route; these observations do not establish a general performance percentile.'],
  };
  await writeFile(join(resourcesRoot, 'fixture-owner.json'), JSON.stringify({ format: FORMAT, output, resourcesRoot, syntheticOnly: true }, null, 2) + '\n', { flag: 'wx' });
  const reportPath = join(output, 'report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return { reportPath, report };
}
async function readPrepared(reportPath) {
  assert.ok(inside(reportPath, MANAGER_DATA), 'A prepared package report under the selected manager-data test location is required.');
  const report = await json(reportPath);
  assert.equal(report.format, FORMAT); assert.equal(report.status, 'prepared-not-run', 'A native run is single-use; never replay an interrupted confirmation.');
  assert.ok(same(reportPath, join(report.output, 'report.json')) && inside(report.output, MANAGER_DATA));
  assert.ok(inside(report.resourcesRoot, RESOURCE_DATA) && !inside(report.resourcesRoot, report.output) && !inside(report.output, report.resourcesRoot));
  const owner = await json(join(report.resourcesRoot, 'fixture-owner.json'));
  assert.equal(owner.format, FORMAT); assert.equal(owner.syntheticOnly, true); assert.ok(same(owner.output, report.output) && same(owner.resourcesRoot, report.resourcesRoot));
  const descriptor = await json(join(report.fixture.root, 'dataset.json'));
  assert.equal(descriptor.format, FIXTURE_FORMAT); assert.equal(descriptor.syntheticOnly, true); assert.equal(descriptor.skillCount, 1000); assert.equal(descriptor.toolCount, 0);
  assert.ok(same(descriptor.dataDir, report.fixture.dataDir) && same(report.fixture.dataDir, join(report.fixture.root, 'data')) && inside(report.fixture.root, report.output));
  assert.ok(same(report.fixture.dbPath, join(report.fixture.dataDir, 'manager.sqlite3')) && same(descriptor.dbPath, report.fixture.dbPath));
  const fixtureOwner = await json(join(report.fixture.root, 'fixture-owner.json'));
  assert.equal(fixtureOwner.format, FIXTURE_FORMAT); assert.equal(fixtureOwner.syntheticOnly, true);
  assert.equal(await digest(report.fixture.dbPath), report.generatedDatabaseSha256, 'Only the original never-run generated database may start this acceptance.');
  assert.deepEqual(report.versions, VERSIONS); assert.ok(same(report.nodePath, process.execPath)); assert.equal(await digest(process.execPath), report.nodeSha256);
  for (const root of [report.output, report.fixture.root, report.fixture.dataDir, report.resourcesRoot]) await assertPlainDirectory(root);
  for (const version of VERSIONS) {
    const chosen = report.paths[version];
    for (const path of [chosen.root, chosen.work, chosen.downloads]) { assert.ok(inside(path, report.resourcesRoot)); await assertPlainDirectory(path); }
    assert.ok(same(chosen.runtime, join(chosen.root, 'runtime')) && !await exists(chosen.runtime), 'The native final directory must be a never-used new path.');
  }
  assert.equal(await digest(report.sentinel.path), report.sentinel.sha256);
  return report;
}
async function candidateProvenance() {
  assert.equal(typeof options.candidate, 'string'); assert.equal(typeof options['candidate-build-info'], 'string');
  const path = resolve(options.candidate), infoPath = resolve(options['candidate-build-info']);
  assert.equal(basename(path).toLowerCase(), 'agent-resource-manager.exe');
  const bytes = await readFile(path), header = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.readUInt16LE(0), 0x5a4d); assert.equal(bytes.readUInt32LE(header), 0x4550); assert.equal(bytes.readUInt16LE(header + 4), 0x8664);
  const sha256 = await digest(path), info = await json(infoPath, 1024 * 1024);
  assert.equal(info.buildMode, 'release'); assert.equal((info.executableSha256 || info.sha256)?.toLowerCase(), sha256); assert.ok(info.sourceIdentity || info.sourceCommit);
  return { path, sha256, buildInfoPath: infoPath, buildInfoSha256: await digest(infoPath), sourceIdentity: info.sourceIdentity || info.sourceCommit, version: info.version };
}

let report, reportPath, app;
async function persist() { await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); }
async function awaitOwnedForeground() {
  const started = performance.now(), timeoutMs = 60000;
  const request = { phase: 'await-owned-foreground', pid: app.identity.pid, windowHandle: app.identity.windowHandle, creationFileTime: app.identity.creationFileTime, timeoutMs, method: 'read-only-owned-window-identity' };
  report.foregroundPreparation = { ...request, status: 'waiting' }; await persist(); console.log(JSON.stringify(request));
  const deadline = started + timeoutMs;
  for (;;) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw new Error('The exact owned PID/HWND was not observed in the foreground within sixty seconds; no focus retry or input was sent.');
    const identity = await app.call('windowIdentity', {}, Math.min(20000, remaining));
    assert.equal(identity.capturedHandle, app.identity.windowHandle, 'The observed native HWND changed while awaiting foreground activation.');
    assert.equal(identity.uiaProcessId, app.identity.pid, 'The observed native PID changed while awaiting foreground activation.');
    if (identity.foregroundHandle === identity.capturedHandle && performance.now() <= deadline) {
      report.foregroundPreparation = { ...request, status: 'observed', elapsedMs: performance.now() - started, foregroundHandle: identity.foregroundHandle }; await persist(); return;
    }
    await sleep(Math.min(250, Math.max(0, deadline - performance.now())));
  }
}
async function note(step) { report.lastStep = step; report.updatedAt = new Date().toISOString(); await persist(); console.log(JSON.stringify({ step, at: report.updatedAt })); }
async function invoke(name, scope) {
  report.pendingControl = { kind: 'button', name, scope }; await persist();
  await waitRead(() => app.call('state', { name, ...(scope ? { scope } : {}) }), rows => array(rows).filter(row => row.type === 'ControlType.Button' && row.enabled).length === 1);
  return app.call('invokeName', { name, ...(scope ? { scope } : {}) });
}
async function field(name, value) {
  report.pendingControl = { kind: 'field', name }; await persist();
  const numeric = name === '软件包下载限速', type = numeric ? 'ControlType.Spinner' : 'ControlType.Edit';
  await waitRead(() => app.call('fields'), rows => array(rows).filter(row => row.type === type && row.name === name && row.enabled).length === 1);
  return app.call('setField', { name, value, numeric });
}
async function select(name, option) {
  report.pendingControl = { kind: 'select', name, option }; await persist();
  await waitRead(() => app.call('fields'), rows => array(rows).filter(row => row.type === 'ControlType.ComboBox' && row.name === name && row.enabled).length === 1);
  return app.call('selectCombo', { name, option });
}
async function taskFrom(label, button, action, timeout = 180000) {
  await note(label);
  const prior = new Set((await app.call('tasks')).tasks.map(task => task.id));
  const startedAt = new Date().toISOString(), start = performance.now();
  const stage = { label, action, button, startedAt, status: 'confirmation-not-replayed', confirmations: 0 };
  report.stages.push(stage); await persist();
  // Record the attempt before sending input. An uncertain result is terminal;
  // neither this script nor a second run may repeat this invocation.
  stage.confirmations = 1; await persist(); await invoke(button);
  const observed = await waitRead(() => app.call('tasks'), value => value.tasks.some(task => !prior.has(task.id) && task.action === action));
  const created = observed.tasks.filter(task => !prior.has(task.id) && task.action === action);
  assert.equal(created.length, 1, 'The UI must create exactly one task for the intended current operation.');
  stage.taskId = created[0].id; await persist();
  const done = (await waitRead(() => app.call('task', { taskId: stage.taskId }), value => value.task && !active(value.task), timeout)).task;
  stage.status = done.status; stage.finishedAt = new Date().toISOString(); stage.elapsedMs = performance.now() - start;
  stage.evidencePath = join(report.output, `task-${report.stages.length.toString().padStart(2, '0')}-${action}.json`);
  await writeFile(stage.evidencePath, JSON.stringify(done, null, 2) + '\n', { flag: 'wx' }); await persist();
  console.log(JSON.stringify({ stage: label, taskId: stage.taskId, status: stage.status, elapsedMs: stage.elapsedMs }));
  assert.equal(done.status, 'succeeded', `Native ${action} did not succeed; its original task evidence is retained and no confirmation was replayed.`);
  return done.result;
}
function assertPreview(value, session, chosen, version) {
  assert.ok(value && typeof value.id === 'string' && value.canApply === true);
  assert.equal(value.recipe, 'edgeMcpNpmV1');
  if (session) { assert.equal(value.sessionId, session.id); assert.equal(value.sessionRevision, session.revision); }
  if (value.targetPath) assert.ok(same(value.targetPath, chosen.runtime));
  if (value.version) assert.equal(value.version, version);
  assert.notEqual(value.executionVerified, true);
}
function assertOrigins(artifacts, version, portable = false) {
  assert.equal(artifacts.length, 3, 'The reviewed npm runtime requires exactly three official packages.');
  const names = new Set();
  for (const artifact of artifacts) {
    const origin = artifact.origin, expected = origin.package === '@playwright/mcp' ? version : DEPENDENCY_VERSION[version];
    assert.equal(origin.kind, 'npmRegistry'); assert.ok(['@playwright/mcp', 'playwright', 'playwright-core'].includes(origin.package) && !names.has(origin.package)); names.add(origin.package);
    assert.equal(origin.version, expected); assert.equal(origin.registry, 'https://registry.npmjs.org');
    assert.equal(origin.repository, origin.package === '@playwright/mcp' ? 'https://github.com/microsoft/playwright-mcp' : 'https://github.com/microsoft/playwright');
    const leaf = origin.package.split('/').at(-1);
    assert.equal(origin.tarball, `https://registry.npmjs.org/${origin.package}/-/${leaf}-${expected}.tgz`);
    assert.match(origin.integrity, /^sha512-[A-Za-z0-9+/]+=*$/);
    assert.match(portable ? artifact.sha256 : artifact.file.sha256, /^[a-f0-9]{64}$/);
    assert.ok((portable ? artifact.bytes : artifact.file.bytes) > 0);
  }
}
async function verifyReceipt(receipt, chosen, version) {
  assert.ok(receipt?.complete && receipt.dependencyCheckPassed); assert.equal(receipt.executionVerified, false); assert.equal(receipt.recipe, 'edgeMcpNpmV1'); assert.ok(same(receipt.root, chosen.runtime));
  assertOrigins(receipt.sourceArtifacts, version);
  assert.equal(receipt.runtime.kind, 'node'); assert.ok(same(receipt.runtime.binding.path, report.nodePath)); assert.equal(receipt.runtime.binding.file.sha256, report.nodeSha256);
  let downloadedBytes = 0;
  for (const artifact of receipt.sourceArtifacts) {
    assert.ok(inside(artifact.path, chosen.downloads)); assert.equal(await digest(artifact.path), artifact.file.sha256);
    assert.equal(`sha512-${await digest(artifact.path, 'sha512', 'base64')}`, artifact.origin.integrity); downloadedBytes += (await lstat(artifact.path)).size;
  }
  assert.ok(receipt.files.length > 3 && receipt.files.some(file => file.role === 'license') && receipt.files.some(file => file.role === 'privateDependency'));
  const expected = new Map(), roles = new Set(['runtime', 'privateDependency', 'license']); let runtimeBytes = 0;
  for (const file of receipt.files) {
    assert.ok(roles.has(file.role) && typeof file.path === 'string' && !isAbsolute(file.path) && !file.path.split(/[\\/]/).some(part => ['.', '..', ''].includes(part)));
    const path = join(chosen.runtime, file.path); assert.ok(inside(path, chosen.runtime));
    const metadata = await lstat(path); assert.ok(metadata.isFile() && !metadata.isSymbolicLink());
    assert.equal(await digest(path), file.installedSha256); expected.set(file.path, file.installedSha256); runtimeBytes += metadata.size;
  }
  for (const relativePath of ['node_modules/@playwright/mcp/cli.js', 'node_modules/playwright/index.js', 'node_modules/playwright-core/lib/coreBundle.js']) assert.ok(expected.has(relativePath));
  report.measurements ||= []; report.measurements.push({ version, downloadedBytes, runtimeBytes, ownedFiles: receipt.files.length, sourceArtifacts: receipt.sourceArtifacts.map(a => ({ package: a.origin.package, version: a.origin.version, bytes: a.file.bytes, sha256: a.file.sha256, integrity: a.origin.integrity })) }); await persist();
  return Object.fromEntries(expected);
}
async function verifyManifest(root, version, resourceId) {
  const path = join(root, '.agent-resource.json'), manifest = await json(path, 8 * 1024 * 1024);
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.resourceId, resourceId); assert.equal(manifest.version, version); assert.equal(manifest.complete, true);
  const source = manifest.source; assert.ok(source?.runtimePackage); assert.equal(source.runtimePackage.recipe, 'edgeMcpNpmV1'); assert.equal(source.runtimePackage.version, version); assertOrigins(source.runtimePackage.artifacts, version, true);
  for (const key of ['releaseId', 'assetId', 'assetName', 'archiveSha256']) assert.ok(source[key] == null, 'npm origin must never become a fake GitHub ZIP asset.');
  const inspect = value => { if (Array.isArray(value)) value.forEach(inspect); else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { assert.ok(!['path', 'runtime', 'localPath', 'executable', 'executionGrant', 'deleteGrant'].includes(key), 'Portable package origin must not export local paths or execution/ownership grants.'); inspect(child); } };
  inspect(source.runtimePackage);
  return { path, sha256: await digest(path), bytes: (await lstat(path)).size, version, origin: source.runtimePackage };
}
async function packageCycle(version, candidate = false) {
  const chosen = report.paths[version];
  await select('官方软件', 'Edge Control');
  for (const [name, value] of [['软件包精确版本', version], ['软件包运行程序', report.nodePath]]) await field(name, value);
  for (const [name, value] of [['准备工作目录', chosen.work], ['依赖下载目录', chosen.downloads], ['新运行目录', chosen.runtime]]) {
    await invoke(`手动填写${name}`);
    await field(`${name}完整路径`, value);
  }
  await field('软件包下载限速', '0');
  const plan = await taskFrom(`${version}: preview official preparation`, '预览准备范围', 'preview_resource_package_prepare'); assertPreview(plan, null, chosen, version);
  assert.deepEqual(plan.network.hosts, ['registry.npmjs.org']); assert.equal(plan.network.downloadsArchives, false); assert.ok(same(plan.workingDirectory, chosen.work) && same(plan.downloadDirectory, chosen.downloads));
  assert.equal(await exists(chosen.runtime), false);
  let result = await taskFrom(`${version}: confirm metadata resolution`, '确认解析依赖', 'apply_resource_package_prepare');
  assert.equal(result.complete, true); assert.equal(result.installed, false); assert.equal(result.executionVerified, false); let session = result.session;
  assert.equal(session.recipe, 'edgeMcpNpmV1'); assert.equal(session.version, version); assert.equal(session.status, 'resolved'); assert.ok(same(session.destinationPath, chosen.runtime));
  assert.equal(session.resourceId, candidate ? report.installed.id : null);
  const downloadPlan = await taskFrom(`${version}: preview exact dependency download`, '预览依赖下载', 'preview_resource_package_download'); assertPreview(downloadPlan, session, chosen, version); assert.equal(downloadPlan.artifacts.length, 3); assert.equal(downloadPlan.downloadBytes, null);
  result = await taskFrom(`${version}: confirm real official downloads`, '确认下载依赖文件', 'apply_resource_package_download', 900000);
  assert.equal(result.complete, true); assert.equal(result.session.id, session.id); assert.equal(result.session.downloadComplete, true); assert.equal(result.installed, false); session = result.session;
  const materializePlan = await taskFrom(`${version}: preview independent final runtime`, '预览运行目录', 'preview_resource_package_materialize'); assertPreview(materializePlan, session, chosen, version); assert.equal(await exists(chosen.runtime), false);
  result = await taskFrom(`${version}: confirm actual runtime preparation`, '确认准备运行目录', 'apply_resource_package_materialize', 300000);
  assert.equal(result.complete, true); assert.equal(result.session.id, session.id); assert.equal(result.session.materialized, true); assert.equal(result.installed, false); session = result.session;
  const hashes = await verifyReceipt(result.receipt, chosen, version);
  const commitPlan = await taskFrom(`${version}: preview ${candidate ? 'candidate' : 'installation'} registration`, candidate ? '预览保存候选' : '预览登记运行目录', 'preview_resource_package_commit'); assertPreview(commitPlan, session, chosen, version); assert.equal(commitPlan.mode, candidate ? 'candidate' : 'register');
  const committed = await taskFrom(`${version}: confirm ${candidate ? 'candidate' : 'installation'} registration`, candidate ? '确认保存候选' : '确认登记运行目录', 'apply_resource_package_commit');
  assert.equal(committed.complete, true); assert.equal(committed.ownershipSaved, true); assert.equal(committed.executionVerified, false); assert.equal(committed.switched, false);
  assert.ok(committed.resource?.id && committed.receipt?.complete);
  if (candidate) {
    assert.equal(committed.staged, true); assert.ok(same(committed.resource.rootPath, report.paths[VERSIONS[0]].runtime));
    const prepared = committed.resource.installation.updateState.candidate; assert.ok(prepared.complete && same(prepared.root, chosen.runtime)); assert.equal(prepared.version, version);
  } else {
    assert.equal(committed.registered, true); assert.ok(same(committed.resource.rootPath, chosen.runtime)); assert.equal(committed.resource.version, version);
  }
  const manifest = await verifyManifest(chosen.runtime, version, committed.resource.id);
  return { resource: committed.resource, hashes, manifest, sessionId: session.id };
}
async function readVersion(version) {
  await invoke('使用读取版本');
  const result = await taskFrom(`${version}: invoke the actual registered CLI entry`, '执行', 'resource_invoke');
  assert.equal(result.run?.status, 'succeeded'); assert.equal(result.run?.exitCode, 0); assert.equal(result.run?.actionId, 'version');
  assert.ok(result.capabilityEvidence?.saved === true && !result.capabilityEvidenceWarning, 'The actual version action must save its own bounded completion evidence.');
  const output = result.stdout ?? result.run.stdout;
  if (typeof output === 'string') assert.match(output, new RegExp(`(?:^|\\s)${version.replaceAll('.', '\\.')}\\s*$`), 'The actual entry returned an unexpected version.');
  await invoke('关闭调用参数');
  return { version, actualActionCompleted: true, versionTextChecked: typeof output === 'string', broaderBrowserCoverage: false };
}
async function verifyRetained(hashes, root) { for (const [path, expected] of Object.entries(hashes)) assert.equal(await digest(join(root, path)), expected, 'The original side-by-side runtime must remain intact.'); }

if (phase === 'prepare') {
  const prepared = await prepare();
  console.log(JSON.stringify({ status: prepared.report.status, reportPath: prepared.reportPath, fixture: prepared.report.fixture.dataDir, resourcesRoot: prepared.report.resourcesRoot, noNativeLaunch: true, noDownload: true }));
} else {
  assert.equal(typeof options.prepared, 'string', 'Run requires --prepared from this script.'); reportPath = resolve(options.prepared);
  report = await readPrepared(reportPath);
  try {
    report.candidate = await candidateProvenance();
    report.harness = await Promise.all(['verify-native-packages.mjs', 'native-uia-client.mjs', 'verify-native-uia.ps1', 'performance-fixture.mjs'].map(async name => ({ name, sha256: await digest(fileURLToPath(new URL(name, import.meta.url))) })));
    report.status = 'running'; report.startedAt = new Date().toISOString(); await persist();
    app = await NativeUiaSession.launch({ executable: report.candidate.path, sha256: report.candidate.sha256, dataDir: report.fixture.dataDir, reportPath: join(report.output, 'native-driver.json'), accessibilityInput: true });
    assert.equal(app.identity.executableSha256, report.candidate.sha256); assert.ok(same(app.identity.dataDirectory, report.fixture.dataDir));
    report.native = app.identity; report.foregroundAwaitRequested = awaitForeground;
    if (awaitForeground) await awaitOwnedForeground();
    await app.call('resize', { width: 1280, height: 850 }); await note('Open official package installation through the real native UI');
    await invoke('工具', '主要导航'); await invoke('安装发行包'); await invoke('官方软件包');
    const original = await packageCycle(VERSIONS[0]); report.installed = { id: original.resource.id, name: original.resource.name, rootPath: original.resource.rootPath, version: original.resource.version }; report.originalManifest = original.manifest; await persist();
    await invoke('关闭安装'); report.checks.originalVersionAction = await readVersion(VERSIONS[0]);
    await invoke('更新运行版本'); await invoke('官方软件包');
    const candidate = await packageCycle(VERSIONS[1], true); report.candidateManifest = candidate.manifest; await persist();
    await verifyRetained(original.hashes, report.paths[VERSIONS[0]].runtime);
    const verified = await taskFrom('Verify the actual isolated candidate CLI version/help', '验证候选入口', 'verify_resource_update', 180000);
    assert.equal(verified.verified, true); assert.ok(same(verified.resource.rootPath, report.paths[VERSIONS[0]].runtime));
    const preview = await taskFrom('Preview the exact side-by-side runtime switch', '预览切换', 'preview_resource_update_switch');
    assert.equal(preview.canApply, true); assert.equal(preview.kind, 'resourceUpdateSwitch'); assert.equal(preview.resourceId, report.installed.id); assert.ok(same(preview.originalPath, report.paths[VERSIONS[0]].runtime) && same(preview.targetPath, report.paths[VERSIONS[1]].runtime)); assert.equal(preview.version, VERSIONS[1]);
    const switched = await taskFrom('Confirm one actual runtime switch and post-switch verification', '确认切换运行入口', 'apply_resource_update_switch', 180000);
    assert.equal(switched.complete, true); assert.equal(switched.switched, true); assert.notEqual(switched.rolledBack, true); assert.ok(same(switched.resource.rootPath, report.paths[VERSIONS[1]].runtime)); assert.equal(switched.resource.version, VERSIONS[1]);
    const state = await taskFrom('Read actual persisted update state through its native UI control', '读取更新记录', 'resource_update_state');
    assert.ok(same(state.resource.rootPath, report.paths[VERSIONS[1]].runtime)); assert.equal(state.updateState.candidate, null); assert.ok(state.updateState.previous.some(previous => same(previous.root, report.paths[VERSIONS[0]].runtime) && previous.version === VERSIONS[0]));
    assert.equal(state.updateState.switchCheck.status, 'passed');
    assert.equal(state.resource.installation.runtimePackage.recipe, 'edgeMcpNpmV1'); assert.equal(state.resource.installation.runtimePackage.version, VERSIONS[1]);
    assertOrigins(state.resource.installation.runtimePackage.sourceArtifacts, VERSIONS[1]);
    assert.equal(state.resource.installation.downloadSource, null); assert.equal(state.resource.installation.archivePath, ''); assert.equal(state.resource.installation.archiveSha256, '');
    for (const scope of ['cliVersion', 'cliHelp']) assert.ok(state.updateState.switchCheck.verifiedScopes.includes(scope));
    const action = state.resource.actions.find(item => item.id === 'version'); assert.ok(action && same(action.executable, report.nodePath) && same(action.workingDirectory, report.paths[VERSIONS[1]].runtime));
    assert.ok(same(action.args[0].value, join(report.paths[VERSIONS[1]].runtime, 'node_modules/@playwright/mcp/cli.js'))); assert.equal(action.args[1].value, '--version');
    report.checks.updatedVersionAction = await readVersion(VERSIONS[1]);
    await verifyRetained(original.hashes, report.paths[VERSIONS[0]].runtime); await verifyRetained(candidate.hashes, report.paths[VERSIONS[1]].runtime);
    assert.equal(await digest(original.manifest.path), original.manifest.sha256); report.finalManifest = await verifyManifest(report.paths[VERSIONS[1]].runtime, VERSIONS[1], report.installed.id);
    assert.equal(await digest(report.sentinel.path), report.sentinel.sha256); assert.equal(await digest(report.nodePath), report.nodeSha256);
    report.checks = { ...report.checks, realOfficialAssetsAndHashes: true, oldRuntimeRetained: true, currentEntryRebound: true, actualPostSwitchCliVerification: true, noFakeGithubZipOrigin: true, generatedPersonalDataRetained: true, sharedNodeUnchanged: true, noBrowserCapabilityClaim: true };
    report.normalExit = (await app.quit()).driverReport.closedNormally; app = null; assert.equal(report.normalExit, true);
    report.status = 'official-npm-install-and-update-passed';
  } catch (error) {
    report.status = 'failed-or-blocked'; report.failure = { name: error.name, message: String(error.message).slice(0, 1800), lastStep: report.lastStep, noConfirmationReplay: true };
    if (app && !app.exited && !app.operationError) {
      try { const path = join(report.output, 'failure-owned-window.png'); await app.call('screenshot', { path }); report.failure.screenshot = path; await writeFile(join(report.output, 'failure-owned-controls.json'), JSON.stringify(await app.call('names'), null, 2)); } catch { /* Preserve the original failed step; no input retry. */ }
    }
  } finally {
    if (app) { try { report.normalExit = (await app.quit()).driverReport.closedNormally; } catch (error) { report.normalExit = false; report.limitations.push(`Normal owned-app exit was not verified: ${String(error.message).slice(0, 500)}. No forced termination was attempted.`); } }
    report.finishedAt = new Date().toISOString(); await persist();
  }
  console.log(JSON.stringify({ status: report.status, reportPath, stages: report.stages.length, normalExit: report.normalExit, resourcesRoot: report.resourcesRoot }));
  if (report.status !== 'official-npm-install-and-update-passed') process.exitCode = 1;
}
