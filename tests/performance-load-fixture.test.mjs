import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { get } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { createPerformanceFixture } from '../scripts/performance-fixture.mjs';
import { createNativeLoadFixture, readNativeLoadFixture, attachNativeLoadResource, startNativeLoadServer, storedZip } from '../scripts/performance-load-fixture.mjs';

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
