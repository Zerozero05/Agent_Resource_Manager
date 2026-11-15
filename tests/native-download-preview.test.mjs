import assert from 'node:assert/strict';
import test from 'node:test';
import { beginUiaNativeStage, nativeDownloadPreviewMatches } from '../scripts/native-uia-loads.mjs';

const specification = {
  repository: 'Panniantong/Agent-Reach',
  releaseId: 421526768,
  assetId: 668240314,
  directory: 'D:/validation/downloads',
};
const preview = {
  canApply: true,
  alreadyComplete: false,
  repository: 'https://github.com/Panniantong/Agent-Reach',
  releaseId: specification.releaseId,
  assetId: specification.assetId,
  targetPath: 'D:/validation/downloads/agent-reach.zip',
};

test('native download preview uses the production GitHub HTTPS repository contract', () => {
  assert.equal(nativeDownloadPreviewMatches(preview, specification), true);
  assert.equal(nativeDownloadPreviewMatches({ ...preview, repository: specification.repository }, specification), false);
});

test('native download preview retains pinned source and asset checks', () => {
  for (const change of [
    { repository: 'https://github.com/other/Agent-Reach' },
    { repository: 'http://github.com/Panniantong/Agent-Reach' },
    { repository: 'https://credential@github.com/Panniantong/Agent-Reach' },
    { releaseId: 1 },
    { assetId: 1 },
    { alreadyComplete: true },
    { canApply: false },
    { canApply: undefined },
    { alreadyComplete: undefined },
  ]) assert.equal(nativeDownloadPreviewMatches({ ...preview, ...change }, specification), false);
});

test('native download preview requires a target within the approved download directory', () => {
  for (const targetPath of [
    'D:/validation/downloads-other/agent-reach.zip',
    'D:/validation/downloads/../agent-reach.zip',
    'C:/agent-reach.zip',
    undefined,
  ]) assert.equal(nativeDownloadPreviewMatches({ ...preview, targetPath }, specification), false);
  assert.equal(nativeDownloadPreviewMatches(null, specification), false);
});

test('native stage selects its exact version field only inside the update panel', () => {
  assert.match(beginUiaNativeStage.toString(), /app\.call\('setField', \{ name: '固定版本', value: 'v2', scope: '更新 Perf Update Fixture' \}\)/);
  assert.doesNotMatch(beginUiaNativeStage.toString(), /setField\(app, '固定版本'/);
});
