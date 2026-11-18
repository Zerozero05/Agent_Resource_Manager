import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { get } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { createPerformanceFixture } from '../scripts/performance-fixture.mjs';
import { createNativeLoadFixture, readNativeLoadFixture, attachNativeLoadResource, attachNativeLoadResources, MAX_NATIVE_UPDATE_FIXTURES, startNativeLoadServer, storedZip } from '../scripts/performance-load-fixture.mjs';
import { beginUiaNativeStage } from '../scripts/native-uia-loads.mjs';

function request(url, headers = {}) {
  return new Promise((done, fail) => { const req = get(url, { headers, agent: false }, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.once('end', () => done({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) })); }); req.once('error', fail); });
}

test('synthetic load ZIP names cannot escape the selected fixture scope', () => {
  assert.throws(() => storedZip([{ path: '../not-allowed', bytes: Buffer.from('x') }]), /safe package-relative/);
  assert.throws(() => storedZip([{ path: '/absolute', bytes: Buffer.from('x') }]), /safe package-relative/);
});

test('generated ZIPs and loopback Range metadata are valid inputs, never native performance evidence', { skip: process.platform !== 'win32' }, async () => {
  const fixture = await createNativeLoadFixture(undefined, { fileCount: 4, bytesPerFile: 128 });
  assert.equal((await readNativeLoadFixture(join(fixture.root, 'load-fixture.json'))).scopeId, fixture.scopeId);
  const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead('${fixture.nextArchive.path.replaceAll("'", "''")}'); try{@($zip.Entries | ForEach-Object {[pscustomobject]@{name=$_.FullName;bytes=$_.Length}}) | ConvertTo-Json -Compress}finally{$zip.Dispose()}`;
  const entries = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8' }));
  assert.equal(entries.length, 6); assert.equal(entries.find(entry => entry.name === 'data/payload-00003.bin').bytes, 128);
  const server = await startNativeLoadServer(fixture);
  try {
    const metadata = await request(server.metadataUrl); assert.equal(metadata.status, 200);
    const release = JSON.parse(metadata.body); assert.equal(release[0].assets[0].digest, `sha256:${fixture.nextArchive.sha256}`);
    assert(release[0].assets[0].browser_download_url.startsWith('https://github.com/'), 'the test transport does not rewrite the production source URL policy');
    const part = await request(server.assetUrl, { Range: 'bytes=10-29', 'If-Range': server.etag });
    assert.equal(part.status, 206); assert.equal(part.headers['content-range'], `bytes 10-29/${fixture.nextArchive.bytes}`);
    assert.deepEqual(part.body, (await readFile(fixture.nextArchive.path)).subarray(10, 30));
    const bad = await request(server.assetUrl, { Range: `bytes=${fixture.nextArchive.bytes + 1}-` }); assert.equal(bad.status, 416);
    const denied = await request(server.assetUrl, { Authorization: 'Synthetic-only-not-a-user-credential' }); assert.equal(denied.status, 403);
    assert(server.requests.some(entry => entry.status === 206 && entry.bytesSent === 20 && entry.completed));
  } finally { await server.close(); }
  console.log(`Prepared load input only: ${fixture.root}`);
});

test('native update load setup replaces only a fresh generated tool and preserves the exact one-hundred-tool scale', { skip: process.platform !== 'win32' }, async () => {
  const parent = 'D:\\03_github_projects\\Agent_Management\\Agent_Resource_Manager\\validation\\manager-data'; await mkdir(parent, { recursive: true });
  const work = await mkdtemp(join(parent, 'load-input-test-'));
  const dataset = await createPerformanceFixture(work, 'generated-catalogue', 100), fixture = await createNativeLoadFixture(undefined, { fileCount: 1, bytesPerFile: 64 });
  const attached = await attachNativeLoadResource(dataset, fixture); assert.equal(attached.totalTools, 100); assert.equal(attached.resourceId, 'perf-tool-000');
  const db = new DatabaseSync(dataset.dbPath, { readOnly: true });
  try { const record = JSON.parse(db.prepare('SELECT payload FROM resource_catalog WHERE id=?').get(attached.resourceId).payload); assert.deepEqual(record.updatePolicy, { mode: 'manual', intervalHours: 24, pinnedVersion: null, skippedVersions: [] }); assert.equal(record.installation.files.length, 2); assert.equal(record.repository, null); assert.equal(record.actions.length, 0); }
  finally { db.close(); }
  await assert.rejects(attachNativeLoadResource(dataset, fixture), /already changed/);
  console.log(`Prepared synthetic catalogue only: ${dataset.root}`);
});

test('sampled update fixtures atomically bind distinct pristine synthetic tools without changing the catalogue scale', { skip: process.platform !== 'win32' }, async () => {
  const parent = 'D:\\03_github_projects\\Agent_Management\\Agent_Resource_Manager\\validation\\manager-data';
  await mkdir(parent, { recursive: true });
  const work = await mkdtemp(join(parent, 'sampled-update-test-'));
  const dataset = await createPerformanceFixture(work, 'generated-catalogue', 100);
  const fixtures = await Promise.all([1, 2].map(fileCount => createNativeLoadFixture(undefined, { fileCount, bytesPerFile: 64 })));
  await assert.rejects(attachNativeLoadResources(dataset, []), /1–12 independent/);
  await assert.rejects(attachNativeLoadResources(dataset, Array(MAX_NATIVE_UPDATE_FIXTURES + 1).fill(fixtures[0])), /1–12 independent/);
  await assert.rejects(attachNativeLoadResources(dataset, [fixtures[0], fixtures[0]]), /distinct roots and scope IDs/);

  // If the second row changed, attaching the first one must roll back, too.
  const db = new DatabaseSync(dataset.dbPath);
  try {
    const payload = db.prepare('SELECT payload FROM resource_catalog WHERE id=?');
    const record = id => JSON.parse(payload.get(id).payload);
    const revise = db.prepare('UPDATE resource_catalog SET revision=? WHERE id=?');
    revise.run(2, 'perf-tool-001');
    await assert.rejects(attachNativeLoadResources(dataset, fixtures), /already changed/);
    assert.equal(record('perf-tool-000').name, 'Perf Tool 000');
    assert.equal(record('perf-tool-000').installation, null);
    revise.run(1, 'perf-tool-001');
    const untouched = payload.get('perf-tool-002').payload;
    const seeds = await attachNativeLoadResources(dataset, fixtures);
    for (const [index, seed] of seeds.entries()) {
      const fixture = fixtures[index], suffix = `00${index}`;
      assert.deepEqual(seed, { resourceId: `perf-tool-${suffix}`, resourceRevision: 1, rootPath: fixture.currentRoot,
        fixtureScopeId: fixture.scopeId, totalTools: 100, toolName: `Perf Update Fixture ${suffix}`,
        fixturePath: join(fixture.root, 'load-fixture.json'), fileCount: fixture.nextArchive.files.length, archiveSha256: fixture.nextArchive.sha256 });
      const row = record(seed.resourceId);
      assert.equal(row.name, seed.toolName);
      assert.equal(row.rootPath, fixture.currentRoot);
      assert.equal(row.installation.archiveSha256, fixture.oldArchive.sha256);
      assert.equal(row.installation.updateState, null);
      assert.deepEqual(row.actions, []);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resource_catalog').get().n, 100);
    assert.equal(payload.get('perf-tool-002').payload, untouched);
    await assert.rejects(attachNativeLoadResources(dataset, fixtures), /already changed/);

    const app = { identity: { dataDirectory: dataset.dataDir }, call: () => assert.fail('Invalid seeds must be refused before calling the native app') };
    await assert.rejects(beginUiaNativeStage(app, dataset, seeds[0].fixturePath, seeds[1]), /exact seeded resource and archive/);
    await assert.rejects(beginUiaNativeStage(app, dataset, seeds[0].fixturePath, seeds[0]), /standard 4098-file/);
  } finally { db.close(); }
});
