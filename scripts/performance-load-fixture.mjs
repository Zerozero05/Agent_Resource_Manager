import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile, appendFile, lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FIXTURE_FORMAT } from './performance-fixture.mjs';

export const LOAD_FIXTURE_FORMAT = 'agent-resource-manager-native-load-v1';
export const VALIDATION_RESOURCE_PARENT = 'D:\\03_github_projects\\Agent_Resource_Manager\\validation\\resources';
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => { let crc = index; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; return crc >>> 0; });
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Stored ZIP files are deliberate: exercise real streaming and filesystem work,
 * not enormous compression ratios, external executables or installer scripts. */
export function storedZip(files) {
  if (files.length > 50000) throw new Error('Fixture ZIP exceeds the real selected-file limit.');
  const local = [], central = []; let offset = 0;
  for (const file of files) {
    if (!/^[a-zA-Z0-9._/-]+$/.test(file.path) || file.path.startsWith('/') || file.path.split('/').includes('..')) throw new Error('Fixture names must be safe package-relative paths.');
    const name = Buffer.from(file.path), body = Buffer.from(file.bytes), crc = crc32(body);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt32LE(crc, 14); header.writeUInt32LE(body.length, 18); header.writeUInt32LE(body.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, body);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(body.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, name); offset += header.length + name.length + body.length;
  }
  const directoryBytes = central.reduce((sum, bytes) => sum + bytes.length, 0), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directoryBytes, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

export async function createNativeLoadFixture(parent = VALIDATION_RESOURCE_PARENT, { fileCount = 4096, bytesPerFile = 4096 } = {}) {
  parent = resolve(parent);
  const approved = resolve(VALIDATION_RESOURCE_PARENT), within = relative(approved, parent);
  if (process.platform === 'win32' && (within.startsWith('..') || isAbsolute(within))) throw new Error('Synthetic load resources must stay in the approved validation/resources tree.');
  if (!Number.isInteger(fileCount) || fileCount < 1 || fileCount > 32768 || !Number.isInteger(bytesPerFile) || bytesPerFile < 64 || bytesPerFile > 16384) throw new Error('Use a bounded package workload: 1–32768 files and 64–16384 bytes per file.');
  await mkdir(parent, { recursive: true });
  if (process.platform === 'win32' && !/^D:\\/i.test(await realpath(parent))) throw new Error('The selected resource parent must resolve to the D drive.');
  const root = await mkdtemp(join(parent, 'native-load-')), scopeId = randomUUID();
  const oldFiles = [{ path: 'LICENSE', bytes: Buffer.from('Synthetic generated fixture. No third-party code or user data.\n'), role: 'license' }, { path: 'bin/tool.txt', bytes: Buffer.from('Synthetic version v1. This is text, never executable.\n'), role: 'runtime' }];
  const files = [{ ...oldFiles[0] }, { ...oldFiles[1], bytes: Buffer.from('Synthetic version v2. This is text, never executable.\n') }];
  for (let index = 0; index < fileCount; index++) { const body = Buffer.alloc(bytesPerFile, 65 + index % 26); body.write(`Generated payload ${index}. No commands or personal content.\n`); files.push({ path: `data/payload-${String(index).padStart(5, '0')}.bin`, bytes: body, role: 'runtime' }); }
  const oldZip = storedZip(oldFiles), nextZip = storedZip(files), oldArchivePath = join(root, 'v1.zip'), archivePath = join(root, 'v2.zip'), currentRoot = join(root, 'current-runtime'), candidateParent = join(root, 'candidates'), downloadDirectory = join(root, 'downloads');
  await Promise.all([writeFile(oldArchivePath, oldZip), writeFile(archivePath, nextZip), mkdir(currentRoot), mkdir(candidateParent), mkdir(downloadDirectory)]);
  for (const file of oldFiles) { const path = join(currentRoot, file.path); await mkdir(resolve(path, '..'), { recursive: true }); await writeFile(path, file.bytes); }
  const summarize = input => input.map(file => ({ path: file.path, role: file.role, installedSha256: sha256(file.bytes), bytes: file.bytes.length }));
  const repository = 'synthetic/arm-performance-fixture', asset = { id: 8202, name: 'native-load.zip', size: nextZip.length, state: 'uploaded', digest: `sha256:${sha256(nextZip)}`, updated_at: '2026-10-30T00:00:00Z', browser_download_url: `https://github.com/${repository}/releases/download/v2/native-load.zip` };
  const release = { id: 7102, tag_name: 'v2', name: 'Synthetic native load', draft: false, prerelease: false, author: { login: 'synthetic' }, html_url: `https://github.com/${repository}/releases/tag/v2`, published_at: '2026-10-30T00:00:00Z', assets: [asset] };
  const fixture = { format: LOAD_FIXTURE_FORMAT, scopeId, syntheticOnly: true, root, repository, oldArchive: { path: oldArchivePath, sha256: sha256(oldZip), files: summarize(oldFiles) }, nextArchive: { path: archivePath, sha256: sha256(nextZip), bytes: nextZip.length, files: summarize(files) }, currentRoot, candidateParent, downloadDirectory, asset, release,
    transport: { allowedInProduction: false, seam: 'resource_github::Source::{get,open}', wire: 'canonical GitHub metadata with test-only loopback transport; ordinary production URL validation stays unchanged' },
    operations: { download: { previewAction: 'preview_resource_download', applyAction: 'apply_resource_download', previewArguments: { repo: repository, releaseId: release.id, assetId: asset.id, downloadDirectory, bytesPerSecond: 128 * 1024 } }, update: { previewAction: 'preview_resource_update', applyAction: 'apply_resource_update_stage', version: 'v2', selectedFiles: files.map(file => file.path), fileRoles: Object.fromEntries(files.filter(file => file.role !== 'license').map(file => [file.path, file.role])) } },
    limits: { fileCount: files.length, unpackedBytes: files.reduce((sum, file) => sum + file.bytes.length, 0), noExecution: true, noNetworkOutsideLoopback: true, updateStageOnly: true, noVerifiedVersionSwitch: true } };
  await writeFile(join(root, 'load-fixture.json'), JSON.stringify(fixture, null, 2) + '\n');
  return fixture;
}

export async function readNativeLoadFixture(path) {
  const fixture = JSON.parse(await readFile(resolve(path), 'utf8'));
  if (fixture.format !== LOAD_FIXTURE_FORMAT || fixture.syntheticOnly !== true || !/^[a-f0-9-]{36}$/.test(fixture.scopeId) || !isAbsolute(fixture.root)) throw new Error('Invalid synthetic native load fixture.');
  if (resolve(dirname(path)) !== resolve(fixture.root)) throw new Error('The load manifest must stay in its exact generated fixture root.');
  const actualRoot = resolve(await realpath(fixture.root));
  for (const [field, name] of [['currentRoot', 'current-runtime'], ['candidateParent', 'candidates'], ['downloadDirectory', 'downloads']]) {
    if (fixture[field] !== join(fixture.root, name) || (await lstat(fixture[field])).isSymbolicLink() || resolve(await realpath(fixture[field])) !== join(actualRoot, name)) throw new Error('Synthetic resource paths must stay in their fixed local scope.');
  }
  for (const archive of [fixture.oldArchive, fixture.nextArchive]) {
    const name = relative(fixture.root, archive.path);
    if (name.startsWith('..') || isAbsolute(name) || (await lstat(archive.path)).isSymbolicLink()) throw new Error('Load archives must be ordinary files inside their exact fixture root.');
    if (sha256(await readFile(archive.path)) !== archive.sha256) throw new Error('Synthetic archive changed; prepare a fresh native load scope.');
  }
  return fixture;
}

/** Seed only one existing generated row while the native application is stopped.
 * It supplies a static local baseline for the real update-stage business path.
 * No ownership or version evidence about user resources is ever fabricated. */
export async function attachNativeLoadResource(dataset, fixture) {
  if (dataset.format !== FIXTURE_FORMAT || dataset.syntheticOnly !== true || dataset.toolCount !== 100) throw new Error('Use the exact generated 100-tools performance dataset.');
  const owner = JSON.parse(await readFile(join(dataset.root, 'fixture-owner.json'), 'utf8'));
  if (owner.format !== FIXTURE_FORMAT || owner.syntheticOnly !== true) throw new Error('No synthetic dataset ownership marker.');
  if (dataset.dbPath !== join(dataset.root, 'data', 'manager.sqlite3') || dataset.toolsRoot !== join(dataset.root, 'tools') || (await lstat(dataset.dbPath)).isSymbolicLink() || !(await lstat(dataset.dbPath)).isFile()) throw new Error('The exact generated database is required.');
  await readNativeLoadFixture(join(fixture.root, 'load-fixture.json'));
  const db = new DatabaseSync(dataset.dbPath);
  try {
    const state = JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload);
    const rows = db.prepare('SELECT id FROM resource_catalog').all();
    if (rows.length !== 100 || rows.some(row => !/^perf-tool-\d{3}$/.test(row.id)) || state.skills.length !== 1000 || state.sources.length || state.connections.length || state.skills.some(skill => !/^perf-skill-\d{4}$/.test(skill.id) || skill.localPath !== join(dataset.root, 'skills', skill.id))) throw new Error('Only a fresh, wholly generated performance database may receive the load fixture.');
    const value = db.prepare('SELECT payload FROM resource_catalog WHERE id=?').get('perf-tool-000');
    if (!value) throw new Error('The reserved generated tool is missing.');
    const record = JSON.parse(value.payload);
    if (record.revision !== 1 || record.installation || record.repository || record.actions.length || record.rootPath !== join(dataset.toolsRoot, 'perf-tool-000')) throw new Error('The generated tool has already changed; never replace a live or user record.');
    const at = '2026-10-30T00:00:00Z';
    record.rootPath = fixture.currentRoot; record.name = 'Perf Update Fixture'; record.kind = 'portable'; record.version = 'v1'; record.ownership = 'managedFiles'; record.managementScope = 'ownedFiles';
    record.installation = { schemaVersion: 1, installedAt: at, archivePath: fixture.oldArchive.path, archiveSha256: fixture.oldArchive.sha256, sourceRepository: null, sourceVersion: 'v1', downloadSource: null, files: fixture.oldArchive.files.map(({ bytes, ...file }) => file), systemEntries: [], status: 'installed', error: null, pendingRepair: null, retainedRepairFiles: [], updateState: null, removalState: null, resourceManifest: null };
    record.updatePolicy = { mode: 'manual', intervalHours: 24, pinnedVersion: null, skippedVersions: [] };
    const key = process.platform === 'win32' ? record.rootPath.replaceAll('/', '\\').toLowerCase() : record.rootPath;
    db.prepare('UPDATE resource_catalog SET root_key=?,payload=? WHERE id=? AND revision=1').run(key, JSON.stringify(record), record.id);
    return { resourceId: record.id, resourceRevision: record.revision, rootPath: record.rootPath, fixtureScopeId: fixture.scopeId, totalTools: db.prepare('SELECT COUNT(*) AS n FROM resource_catalog').get().n };
  } finally { db.close(); }
}

export async function startNativeLoadServer(fixture, { chunkBytes = 65536, chunkDelayMs = 0 } = {}) {
  const verified = await readNativeLoadFixture(join(fixture.root, 'load-fixture.json'));
  const assetBytes = await readFile(verified.nextArchive.path), etag = `"native-load-${verified.nextArchive.sha256}"`, requests = [], logPath = join(fixture.root, 'http-observations.jsonl'), sockets = new Set();
  const prefix = `/${fixture.scopeId}`;
  const server = createServer(async (request, response) => {
    const startedAt = Date.now(), entry = { method: request.method, path: request.url, startedAt, status: 0, bytesSent: 0, completed: false };
    requests.push(entry);
    response.on('close', () => { entry.finishedAt = Date.now(); void appendFile(logPath, JSON.stringify(entry) + '\n'); });
    const end = (status, body, headers = {}) => { entry.status = status; response.writeHead(status, headers); response.end(body); };
    if (request.method !== 'GET' || request.headers.authorization || !request.url.startsWith(`${prefix}/`)) return end(403, 'Only this synthetic GET scope is served.');
    const path = request.url.slice(prefix.length);
    let value;
    if (path === '/releases') value = [verified.release];
    else if ([`/releases/${verified.release.id}`, '/releases/tags/v2'].includes(path)) value = verified.release;
    else if (path === `/releases/assets/${verified.asset.id}`) value = verified.asset;
    if (value) return end(200, JSON.stringify(value), { 'Content-Type': 'application/json' });
    if (path !== '/asset') return end(404, 'No such fixture resource.');
    let start = 0, stop = assetBytes.length - 1, status = 200;
    if (request.headers.range && (!request.headers['if-range'] || request.headers['if-range'] === etag)) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
      if (!match) return end(416, '', { 'Content-Range': `bytes */${assetBytes.length}` });
      start = Number(match[1]); stop = match[2] ? Number(match[2]) : stop;
      if (start > stop || stop >= assetBytes.length) return end(416, '', { 'Content-Range': `bytes */${assetBytes.length}` });
      status = 206;
    }
    entry.status = status; entry.rangeStart = start; entry.rangeEnd = stop;
    response.writeHead(status, { 'Content-Type': 'application/zip', 'Content-Length': stop - start + 1, ETag: etag, 'Accept-Ranges': 'bytes', ...(status === 206 ? { 'Content-Range': `bytes ${start}-${stop}/${assetBytes.length}` } : {}) });
    for (let offset = start; offset <= stop && !response.destroyed; offset += chunkBytes) {
      const bytes = assetBytes.subarray(offset, Math.min(offset + chunkBytes, stop + 1));
      if (!response.write(bytes)) await new Promise(done => { response.once('drain', done); response.once('close', done); });
      entry.bytesSent += bytes.length;
      if (chunkDelayMs) await new Promise(done => setTimeout(done, chunkDelayMs));
    }
    if (!response.destroyed) { entry.completed = true; response.end(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const endpoint = `http://127.0.0.1:${server.address().port}${prefix}`;
  return { format: LOAD_FIXTURE_FORMAT, scopeId: fixture.scopeId, endpoint, metadataUrl: `${endpoint}/releases`, assetUrl: `${endpoint}/asset`, etag, requests, close: () => new Promise(done => { for (const socket of sockets) socket.destroy(); server.close(done); }) };
}

/** Starts real native update staging and returns immediately after admission so
 * the caller can drive the actual UI concurrently. `invoke` must be the owning
 * WebView's manager_request bridge, not an in-process mock. The returned facts
 * are observations only; the caller still records the exact executable SHA and
 * driver input/paint intervals. This never attempts candidate execution/switch. */
export async function beginNativeStageLoad(invoke, dataset, fixture, resourceId = 'perf-tool-000') {
  const checked = await readNativeLoadFixture(join(fixture.root, 'load-fixture.json'));
  const state = await invoke({ action: 'get_state' });
  const normalize = value => resolve(value).replace(/^\\\\\?\\/, '').toLowerCase();
  if (normalize(state.dataDir) !== normalize(dataset.dataDir) || state.skills?.length !== 1000 || state.sources.length || state.connections.length || state.skills.some(skill => !/^perf-skill-\d{4}$/.test(skill.id))) throw new Error('Native bridge is not connected to the isolated performance dataset.');
  const storage = (await invoke({ action: 'storage_get' })).storage;
  if (normalize(storage.managedRoot) !== normalize(dataset.dataDir)) throw new Error('Native manager root is not the explicitly locked synthetic data directory.');
  const snapshot = await invoke({ action: 'resource_update_state', id: resourceId }), record = snapshot.resource;
  if (record.id !== resourceId || normalize(record.rootPath) !== normalize(checked.currentRoot) || record.version !== 'v1' || record.actions.length || record.repository || record.installation?.updateState?.candidate) throw new Error('Native update input is not the exact untouched, non-executable local fixture.');
  const destinationPath = join(checked.candidateParent, checked.scopeId);
  async function start(request, label) { return (await invoke({ action: 'start_task', request, label, origin: { view: 'tools', resourceId }, foreground: false })).task; }
  async function wait(task) {
    const end = Date.now() + 120000;
    while (['queued', 'running'].includes(task.status) && Date.now() < end) { await new Promise(done => setTimeout(done, 50)); task = (await invoke({ action: 'get_task', taskId: task.id })).task; }
    if (['queued', 'running'].includes(task.status)) throw new Error('Native update task did not finish within two minutes.');
    if (task.status !== 'succeeded') throw new Error(task.error || `Native update task ${task.status}`);
    if (task.result === undefined) task = (await invoke({ action: 'get_task', taskId: task.id })).task;
    return task;
  }
  const previewTask = await wait(await start({ action: 'preview_resource_update', id: resourceId, expectedRevision: record.revision, archivePath: checked.nextArchive.path, destinationPath, version: 'v2', selectedFiles: checked.operations.update.selectedFiles, fileRoles: checked.operations.update.fileRoles }, 'Synthetic native update-stage preview'));
  const plan = previewTask.result;
  if (plan?.kind !== 'resourceUpdateStage' || plan.canApply !== true || plan.resourceId !== resourceId || normalize(plan.targetPath) !== normalize(destinationPath)) throw new Error(`The ordinary native update preview refused this fixture: ${(plan?.warnings || []).join('; ')}`);
  let task = await start({ action: 'apply_resource_update_stage', previewId: plan.id }, 'Synthetic native update-stage load');
  const initial = { kind: 'update', phase: 'candidate-stage', scopeId: checked.scopeId, resourceId, taskId: task.id, actualAction: 'apply_resource_update_stage', currentRoot: checked.currentRoot, candidateRoot: destinationPath, noExecutionOrSwitch: true, storage };
  return {
    ...initial,
    async observe() {
      if (['queued', 'running'].includes(task.status)) task = (await invoke({ action: 'get_task', taskId: task.id })).task;
      return { ...initial, status: task.status, startedAt: task.startedAt || null, finishedAt: task.finishedAt || null, error: task.error || null };
    },
    async finish() {
      task = await wait(task);
      const result = task.result, candidate = result?.resource?.installation?.updateState?.candidate;
      const originalRetained = (await Promise.all(checked.oldArchive.files.map(async file => sha256(await readFile(join(checked.currentRoot, file.path))) === file.installedSha256))).every(Boolean);
      if (result?.complete !== true || result.staged !== true || result.switched !== false || normalize(result.resource.rootPath) !== normalize(checked.currentRoot) || !candidate?.complete || normalize(candidate.root) !== normalize(destinationPath) || candidate.files.length !== checked.nextArchive.files.length || !originalRetained) throw new Error('Native staging did not finish with the complete candidate and unchanged original fixture.');
      return { ...initial, status: task.status, startedAt: task.startedAt, finishedAt: task.finishedAt, staged: true, switched: false, fileCount: candidate.files.length, originalRetained, complete: true };
    },
  };
}
