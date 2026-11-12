import test from 'node:test';
import assert from 'node:assert/strict';
import { packageBytes, packageCommitResult, packagePreview, packageResult, packageSession, packageSessionLabel, packageSessions, samePackagePath } from '../src/runtime-package.ts';

const hash = 'a'.repeat(64);
const session = (changes = {}) => ({ id: 'session', revision: 2, recipe: 'edgeMcpNpmV1', version: '1.2.3', resourceId: null, destinationPath: 'D:/resources/edge-v1', downloadDirectory: 'D:/resources/downloads', workingDirectory: 'D:/resources/work', status: 'resolved', error: null, downloadComplete: false, materialized: false, executionVerified: false, createdAt: '2026-10-31T00:00:00Z', updatedAt: '2026-10-31T00:00:00Z', ...changes });
const current = () => packageSession(session());
const common = () => ({ id: 'preview', canApply: true, sessionId: 'session', sessionRevision: 2, resourceId: null });
const download = () => ({ ...common(), kind: 'runtimePackageDownload', recipe: 'edgeMcpNpmV1', directory: 'D:/resources/downloads', bytesPerSecond: 0, artifacts: [{ package: '@playwright/mcp', filename: 'mcp.tgz', url: 'https://registry.npmjs.org/@playwright/mcp/-/mcp-1.2.3.tgz', bytes: null, sha256: null, sha512: 'sha512-YWJjZA==' }], downloadBytes: null, maximumArtifactBytes: 536870912, planHash: hash, installsFiles: false, executesCode: false, warning: '仅下载精确资产' });
const binding = () => ({ path: 'D:/resources/downloads/agent_reach.whl', file: { bytes: 31, sha256: hash, modified: '2026-10-31' }, origin: { kind: 'githubRelease', source: { repository: 'https://github.com/panniantong/agent-reach', version: 'v1.2.3' } } });
const receipt = () => ({ recipe: 'edgeMcpNpmV1', root: 'D:/resources/edge-v1', files: [{ path: 'LICENSE', role: 'license', installedSha256: hash }], complete: true, dependencyCheckPassed: true, executionVerified: false, error: null, createdPaths: ['D:/resources/edge-v1'], temporaryPaths: [] });
const resource = () => ({ id: 'edge', name: 'Edge Control', kind: 'mcp', rootPath: 'D:/resources/edge-v1', alias: '', notes: '', enabled: false, revision: 1, ownership: 'managedFiles', managementScope: 'ownedFiles', actions: [], capabilities: [], createdAt: '', updatedAt: '' });
const commit = (changes = {}) => ({ ...common(), kind: 'resourcePackageCommit', recipe: 'edgeMcpNpmV1', version: '1.2.3', targetPath: 'D:/resources/edge-v1', mode: 'register', files: receipt().files, warnings: [], ...changes });

test('journal states remain readable after restart without becoming a completed installation', () => {
  for (const status of ['preparing', 'downloading', 'materializing', 'materializationIncomplete']) {
    const value = packageSession(session({ status }));
    assert(!packageSessionLabel(value).includes('已登记'));
  }
  assert.throws(() => packageSession(session({ executionVerified: true })));
  assert.throws(() => packageSession(session({ status: 'unknown' })));
  assert.throws(() => packageSessions({ sessions: [session(), session()] }));
});

test('Windows path spelling is normalized without equating different locations', () => {
  assert(samePackagePath('\\\\?\\D:\\Resources\\Edge-v1\\', 'd:/resources/edge-v1'));
  assert(!samePackagePath('D:/resources/edge-v1/../other', 'D:/resources/other'));
  assert(!samePackagePath('//server/resources/edge-v1', 'D:/resources/edge-v1'));
});

test('download accepts npm SRI and reports unknown byte counts as unknown', () => {
  const value = packagePreview(download(), 'download', current());
  assert.equal(value.assets[0].digest, 'sha512-YWJjZA==');
  assert.equal(value.assets[0].bytes, null);
  assert.equal(packageBytes(value.downloadBytes), '未知');
  assert.equal(packageBytes(0), '0 B');
  assert.throws(() => packagePreview({ ...download(), artifacts: [{ ...download().artifacts[0], sha512: 'not-an-integrity' }] }, 'download', current()));
  assert.throws(() => packagePreview({ ...download(), executesCode: true }, 'download', current()));
});

test('later previews bind exact session, revision, resource, recipe and selected directory', () => {
  for (const changes of [{ sessionId: 'other' }, { sessionRevision: 3 }, { resourceId: 'other' }, { recipe: 'agentReachWheelV1' }, { directory: 'D:/elsewhere' }]) assert.throws(() => packagePreview({ ...download(), ...changes }, 'download', current()));
});

test('Reach prepare requires a verified artifact and reveals uncapped resolver downloads', () => {
  const raw = { id: 'prepare', canApply: true, kind: 'runtimePackagePreparation', recipe: 'agentReachWheelV1', version: '1.2.3', targetPath: 'D:/resources/reach', workingDirectory: 'D:/resources/work', downloadDirectory: 'D:/resources/downloads', bytesPerSecond: 0, source: binding(), resourceId: null, network: { hosts: ['pypi.org', 'files.pythonhosted.org'], purpose: '解析 wheel', resolverMayDownloadWheels: true, resolverDownloadsRateLimited: false, temporaryCacheParent: 'D:/resources/work' }, installsFiles: false, executionVerified: false, warning: '下载可能发生在解析阶段' };
  const value = packagePreview(raw, 'prepare');
  assert.equal(value.resolverMayDownload, true); assert.equal(value.resolverRateLimited, false);
  assert.equal(value.assets[0].bytes, 31);
  assert.throws(() => packagePreview({ ...raw, source: null }, 'prepare'));
  assert.throws(() => packagePreview({ ...raw, network: { ...raw.network, resolverDownloadsRateLimited: true } }, 'prepare'));
});

test('resume keeps actual partial paths and never replays installation', () => {
  const value = { ...common(), kind: 'runtimePackageResume', plan: download(), transfers: [{ package: '@playwright/mcp', target: 'D:/resources/downloads/mcp.tgz', partial: 'D:/resources/downloads/mcp.part', observed: { bytes: 20, sha256: hash, modified: '2026-10-31' }, complete: false, error: '中断' }], willReplayInstall: false };
  const result = packagePreview(value, 'resume', current());
  assert.deepEqual(result.partialFiles, [{ path: 'D:/resources/downloads/mcp.part', complete: false, bytes: 20, error: '中断' }]);
  assert.throws(() => packagePreview({ ...value, willReplayInstall: true }, 'resume', current()));
});

test('materialization shows inspected licenses and preserves unknown total size', () => {
  const raw = { ...common(), kind: 'npmRuntimeMaterialization', recipe: 'edgeMcpNpmV1', targetPath: 'D:/resources/edge-v1', artifacts: { '@playwright/mcp': { ...binding(), origin: { kind: 'npmRegistry', package: '@playwright/mcp', version: '1.2.3', tarball: 'https://registry.npmjs.org/mcp.tgz' } } }, files: { '@playwright/mcp': { unpackedBytes: 12, files: [{ path: 'LICENSE', bytes: 12, sha256: hash, license: true }] } }, planHash: hash, nodeMajorMinimum: 18, executionVerified: false, warnings: [] };
  assert.deepEqual(packagePreview(raw, 'materialize', current()).licenses, ['@playwright/mcp · LICENSE']);
  assert.throws(() => packagePreview({ ...raw, kind: 'pythonRuntimeMaterialization' }, 'materialize', current()));
});

test('a completed receipt alone is not successful registration or capability evidence', () => {
  const result = packageResult({ session: session({ downloadComplete: true, materialized: true, status: 'materialized' }), complete: true, installed: false, executionVerified: false, receipt: receipt() }, 'materialize');
  assert.equal(result.registered, false); assert.equal(result.resource, undefined); assert.equal(result.executionVerified, false);
  assert.throws(() => packageResult({ ...result, receipt: { ...receipt(), dependencyCheckPassed: false } }, 'materialize'));
  assert.throws(() => packageResult({ ...result, executionVerified: true }, 'materialize'));
});

test('registration is a separate commit bound to prepared files, mode and real resource identity', () => {
  const prepared = packageSession(session({ downloadComplete: true, materialized: true, status: 'materialized' }));
  const preview = packagePreview(commit(), 'commit', prepared);
  const raw = { complete: true, executionVerified: false, registered: true, staged: false, switched: false, ownershipSaved: true, receipt: receipt(), resource: resource() };
  assert.equal(packageCommitResult(raw, preview, prepared).resource?.id, 'edge');
  for (const changes of [{ rootPath: 'D:/unrelated' }, { kind: 'cli' }, { revision: 0 }]) assert.throws(() => packageCommitResult({ ...raw, resource: { ...resource(), ...changes } }, preview, prepared));
  for (const changes of [{ switched: true }, { executionVerified: true }, { ownershipSaved: false }, { staged: true }]) assert.throws(() => packageCommitResult({ ...raw, ...changes }, preview, prepared));
  assert.throws(() => packagePreview(commit({ mode: 'candidate' }), 'commit', prepared));
  assert.throws(() => packagePreview(commit(), 'commit', current()));
  assert.throws(() => packageResult({ ...raw, session: prepared }, 'materialize'));
});

test('candidate commit retains original resource root and version until explicit later switching', () => {
  const prepared = packageSession(session({ resourceId: 'edge', downloadComplete: true, materialized: true, status: 'materialized' }));
  const preview = packagePreview(commit({ resourceId: 'edge', mode: 'candidate' }), 'commit', prepared);
  const raw = { complete: true, executionVerified: false, registered: false, staged: true, switched: false, ownershipSaved: true, receipt: receipt(), resource: { ...resource(), rootPath: 'D:/resources/edge-old', version: '0.9.0' } };
  const result = packageCommitResult(raw, preview, prepared); assert.equal(result.resource?.rootPath, 'D:/resources/edge-old');
  assert.throws(() => packageCommitResult({ ...raw, resource: { ...raw.resource, id: 'other' } }, preview, prepared));
  assert.throws(() => packageCommitResult({ ...raw, registered: true, staged: false }, preview, prepared));
  const failed = packageCommitResult({ ...raw, complete: false, ownershipSaved: false, registered: false, staged: false, resource: undefined, error: '保存记录失败' }, preview, prepared);
  assert.equal(failed.complete, false); assert.equal(failed.receipt.root, prepared.destinationPath); assert.equal(failed.error, '保存记录失败');
});
