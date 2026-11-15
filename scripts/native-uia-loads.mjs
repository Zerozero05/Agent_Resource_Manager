import { readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { readNativeLoadFixture } from './performance-load-fixture.mjs';

const sleep = ms => new Promise(done => setTimeout(done, ms));
const active = task => ['queued', 'running'].includes(task.status);
const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
const within = (path, root) => { const key = relative(resolve(root), resolve(path)); return key === '' || (!key.startsWith('..') && !isAbsolute(key)); };
async function waitRead(read, predicate, timeoutMs = 60000) { const deadline = Date.now() + timeoutMs; for (;;) { const value = await read(); if (predicate(value)) return value; if (Date.now() >= deadline) throw new Error('The exact native load-control state did not become available. No write action was replayed.'); await sleep(30); } }
async function enabled(app, name) { return waitRead(() => app.call('state', { name }), value => array(value).filter(item => item.type === 'ControlType.Button' && item.enabled).length === 1); }
async function invoke(app, name, scope) { await enabled(app, name); return app.call('invokeName', { name, ...(scope ? { scope } : {}) }); }
async function fieldName(app, prefix, type = 'ControlType.Edit') { const value = await waitRead(() => app.call('fields'), value => array(value).some(item => item.type === type && item.name.startsWith(prefix) && item.enabled)); const matches = array(value).filter(item => item.type === type && item.name.startsWith(prefix) && item.enabled); if (matches.length !== 1) throw new Error(`Native field prefix is ambiguous: ${prefix}`); return matches[0].name; }
async function setField(app, prefix, value, numeric = false) { return app.call('setField', { name: await fieldName(app, prefix, numeric ? 'ControlType.Spinner' : 'ControlType.Edit'), value: String(value), numeric }); }
async function select(app, prefix, option, focusBeforeExpand = false, catalogueOptions) {
  const name = await fieldName(app, prefix, 'ControlType.ComboBox');
  const focusAccessibleCombo = focusBeforeExpand && app.accessibilityInput === true && app.foregroundSelection !== true;
  const result = app.popupComboSelection
    ? await app.call('keyboardSelectPopupCombo', { name, option, catalogueOptions })
    : app.closedComboSelection
    ? await app.call('keyboardSelectClosedCombo', { name, option, ...(catalogueOptions ? { catalogueOptions } : {}) })
    : await app.call('selectCombo', { name, option, foreground: app.foregroundSelection === true, ...(focusAccessibleCombo ? { focusBeforeExpand: true } : {}) });
  if (result.selected !== option || result.functionalOnly !== true) throw new Error('The exact native dropdown selection was not verified as a functional-only operation.');
  (app.functionalSelections ||= []).push({ control: name, option, ...result });
  return result;
}
async function actionTask(app, name, action, scope) {
  const prior = new Set((await app.call('tasks')).tasks.map(task => task.id));
  await invoke(app, name, scope);
  const value = await waitRead(() => app.call('tasks'), value => value.tasks.some(task => !prior.has(task.id) && task.action === action));
  const matches = value.tasks.filter(task => !prior.has(task.id) && task.action === action);
  if (matches.length !== 1) throw new Error('The native form did not create exactly one new expected task.');
  return matches[0];
}
export async function waitNativeTask(app, taskId, timeoutMs = 120000) {
  const value = await waitRead(() => app.call('task', { taskId }), value => value.task && !active(value.task), timeoutMs);
  if (value.task.status !== 'succeeded') throw new Error(`Native task ${taskId} did not succeed: ${value.task.error || value.task.status}`);
  return value.task;
}
async function goTools(app) { await app.call('invokeName', { name: '工具', scope: '主要导航' }); await waitRead(() => app.call('fields'), value => array(value).some(item => item.name === '搜索工具')); }
async function goSkills(app) { await app.call('invokeName', { name: 'Skills', scope: '主要导航' }); await waitRead(() => app.call('fields'), value => array(value).some(item => item.name === '搜索 Skill' && !item.offscreen)); }

/** Uses the real local update form and its explicit confirmation. The ZIP has
 * generated text only; the current root and content must remain unchanged. */
export async function beginUiaNativeStage(app, dataset, fixturePath) {
  const fixture = await readNativeLoadFixture(fixturePath);
  if (resolve(app.identity.dataDirectory).toLowerCase() !== resolve(dataset.dataDir).toLowerCase() || dataset.skillCount !== 1000 || dataset.toolCount !== 100) throw new Error('Native update load requires the exact isolated 1000/100 dataset.');
  await goTools(app); await app.call('setField', { name: '搜索工具', value: 'Perf Update Fixture' });
  await invoke(app, 'Perf Update Fixture'); await invoke(app, '更新运行版本');
  await setField(app, '候选版本 ZIP', fixture.nextArchive.path);
  await waitNativeTask(app, (await actionTask(app, '读取文件清单', 'resource_package_inspect')).id);
  await app.call('setField', { name: '固定版本', value: 'v2', scope: '更新 Perf Update Fixture' });
  // A never-used destination is required; production validates its independence.
  const destination = join(fixture.candidateParent, 'native-uia-v2');
  await setField(app, '候选保存目录（必须为未使用的新目录）', destination);
  await invoke(app, '全选文件');
  const previewTask = await actionTask(app, '预览候选版本', 'preview_resource_update');
  const preview = (await waitNativeTask(app, previewTask.id)).result;
  if (!preview?.canApply || resolve(preview.targetPath).toLowerCase() !== resolve(destination).toLowerCase() || resolve(preview.originalPath).toLowerCase() !== resolve(fixture.currentRoot).toLowerCase()) throw new Error('Native update preview did not confirm the exact generated current/candidate scope.');
  const task = await actionTask(app, '确认准备这些文件', 'apply_resource_update_stage');
  await goSkills(app);
  return { kind: 'update', taskId: task.id, action: task.action, initialStatus: task.status, generatedScope: fixture.root, destination, startedAt: task.startedAt, async finish() { const result = (await waitNativeTask(app, task.id)).result; if (!result?.staged || result.switched || !result.complete || resolve(result.resource.rootPath).toLowerCase() !== resolve(fixture.currentRoot).toLowerCase()) throw new Error('The native stage result did not preserve the original runtime.'); for (const file of fixture.oldArchive.files) { const bytes = await readFile(join(fixture.currentRoot, file.path)); if (createHash('sha256').update(bytes).digest('hex') !== file.installedSha256) throw new Error('Generated original runtime changed during candidate preparation.'); } return { taskId: task.id, complete: true, staged: true, switched: false, destination }; } };
}

/** Only official GitHub release metadata and the normal native confirmation are
 * accepted. No localhost URLs, no production source overrides and no execution. */
export function nativeDownloadPreviewMatches(preview, specification) {
  return preview?.canApply === true && preview.alreadyComplete === false
    && preview.releaseId === specification.releaseId && preview.assetId === specification.assetId
    && preview.repository === `https://github.com/${specification.repository}`
    && typeof preview.targetPath === 'string' && within(preview.targetPath, specification.directory);
}

export async function beginUiaNativeDownload(app, dataset, specification) {
  const { repository, tag, releaseId, assetId, assetName, assetBytes, directory, bytesPerSecond = 16384 } = specification;
  if (!within(directory, 'D:\\03_github_projects\\Agent_Resource_Manager\\validation\\resources') || !Number.isSafeInteger(bytesPerSecond) || bytesPerSecond <= 0 || typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Download load must use the approved resource tree and explicit official repository/rate.');
  if (!(await stat(directory)).isDirectory() || resolve(app.identity.dataDirectory).toLowerCase() !== resolve(dataset.dataDir).toLowerCase()) throw new Error('Native download load scope does not match the exact isolated dataset.');
  await goTools(app); await invoke(app, '安装发行包'); await invoke(app, 'GitHub 发行版', '发行包来源');
  await setField(app, 'GitHub 仓库或发行链接', `https://github.com/${repository}`); await setField(app, '固定版本（可选）', tag);
  const query = await waitNativeTask(app, (await actionTask(app, '查询发行版本', 'resource_github_releases')).id);
  const release = query.result?.releases?.find(value => value.id === releaseId && value.tag === tag), asset = release?.assets?.find(value => value.id === assetId && value.name === assetName && value.size === assetBytes);
  if (!release || !asset) throw new Error('The actual current official GitHub release/asset differs from the pinned native load specification.');
  const releaseOption = `${release.tag}${release.prerelease ? ' · 预发布' : ''}${release.name && release.name !== release.tag ? ` · ${release.name}` : ''}`;
  const releaseLabels = ['请选择版本', ...query.result.releases.map(item => `${item.tag}${item.prerelease ? ' · 预发布' : ''}${item.name && item.name !== item.tag ? ` · ${item.name}` : ''}`)];
  await select(app, '发行版本', releaseOption, true, releaseLabels);
  const assetLabel = item => `${item.name} · ${item.size >= 1048576 ? `${(item.size / 1048576).toFixed(1)} MiB` : `${(item.size / 1024).toFixed(1)} KiB`}`;
  await select(app, '发行文件', assetLabel(asset), true, ['请选择发行文件', ...release.assets.map(assetLabel)]);
  await setField(app, '下载保存目录', directory); await setField(app, '下载限速（MiB/s，0 为不限速）', bytesPerSecond / 1048576, true);
  const preview = (await waitNativeTask(app, (await actionTask(app, '预览下载', 'preview_resource_download')).id)).result;
  if (!nativeDownloadPreviewMatches(preview, specification)) throw new Error('The actual native download preview does not match the pinned GitHub HTTPS repository, release, asset and new save path.');
  const task = await actionTask(app, '确认下载此文件', 'apply_resource_download'); await goSkills(app);
  return { kind: 'download', taskId: task.id, action: task.action, initialStatus: task.status, generatedScope: directory, repository, tag, releaseId, assetId, expectedBytes: assetBytes, bytesPerSecond, startedAt: task.startedAt, downloadId: preview.downloadId, partialPath: preview.partialPath, targetPath: preview.targetPath, async finish() {
    const limit = Math.max(120000, assetBytes / bytesPerSecond * 1000 + 60000);
    const result = (await waitNativeTask(app, task.id, limit)).result;
    if (!within(result?.archivePath || '', directory) || (await stat(result.archivePath)).size !== assetBytes) throw new Error('The completed native download does not match the selected official asset scope/size.');
    return { taskId: task.id, complete: true, archivePath: result.archivePath, downloadId: result.downloadId };
  } };
}

/** Restart acceptance uses only the existing native history and confirmation.
 * The caller supplies the partial fingerprint saved after a real normal quit. */
export async function resumeUiaNativeDownload(app, dataset, specification, interrupted) {
  if (resolve(app.identity.dataDirectory).toLowerCase() !== resolve(dataset.dataDir).toLowerCase()
    || !within(specification.directory, 'D:\\03_github_projects\\Agent_Resource_Manager\\validation\\resources')
    || !within(interrupted.partialPath || '', specification.directory)
    || !within(interrupted.targetPath || '', specification.directory)
    || !(interrupted.bytes > 0 && interrupted.bytes < specification.assetBytes)
    || !Number.isSafeInteger(specification.bytesPerSecond) || specification.bytesPerSecond <= 0
    || !/^[a-f0-9]{64}$/.test(interrupted.sha256 || '')) throw new Error('Restart continuation requires the exact isolated dataset and saved nonempty partial.');
  await goTools(app); await invoke(app, '安装发行包'); await invoke(app, 'GitHub 发行版', '发行包来源');
  const page = (await waitNativeTask(app, (await actionTask(app, '继续已有下载', 'resource_downloads')).id)).result;
  const record = page?.downloads?.find(value => value.id === interrupted.downloadId);
  if (page?.total !== 1 || page.downloads.length !== 1 || !record || record.status !== 'interrupted'
    || record.repository !== `https://github.com/${specification.repository}` || record.version !== specification.tag
    || record.assetName !== specification.assetName || record.totalBytes !== specification.assetBytes
    || record.receivedBytes !== interrupted.bytes
    || resolve(record.targetPath).toLowerCase() !== resolve(interrupted.targetPath).toLowerCase()
    || resolve(record.partialPath).toLowerCase() !== resolve(interrupted.partialPath).toLowerCase()) throw new Error('The native history did not restore the exact interrupted download.');
  const assertUnchangedPartial = async () => {
    const bytes = await readFile(interrupted.partialPath);
    if (bytes.length !== interrupted.bytes || createHash('sha256').update(bytes).digest('hex') !== interrupted.sha256) throw new Error('The saved partial changed before explicit continuation.');
    const tasks = (await app.call('tasks')).tasks;
    if (tasks.some(value => value.action === 'apply_resource_download' && active(value))) throw new Error('A download restarted before the explicit native confirmation.');
  };
  await assertUnchangedPartial();
  await sleep(2000);
  await assertUnchangedPartial();
  const preview = (await waitNativeTask(app, (await actionTask(app, '核对并继续', 'preview_resource_resume', '已有下载记录')).id)).result;
  if (!nativeDownloadPreviewMatches(preview, specification) || preview.downloadId !== interrupted.downloadId
    || preview.receivedBytes !== interrupted.bytes || preview.downloadBytes !== specification.assetBytes
    || resolve(preview.targetPath).toLowerCase() !== resolve(interrupted.targetPath).toLowerCase()
    || resolve(preview.partialPath).toLowerCase() !== resolve(interrupted.partialPath).toLowerCase()) throw new Error('The native continuation preview changed the fixed asset, record or partial.');
  await assertUnchangedPartial();
  const task = await actionTask(app, '确认继续此文件', 'apply_resource_download', '下载影响清单');
  return { taskId: task.id, previewId: preview.id, downloadId: preview.downloadId, restoredStatus: record.status, restoredBytes: record.receivedBytes, noAutomaticRestartObservedMs: 2000, async finish() {
    const timeoutMs = Math.max(120000, specification.assetBytes / specification.bytesPerSecond * 1000 + 60000);
    const result = (await waitNativeTask(app, task.id, timeoutMs)).result;
    if (result?.complete !== true || result.downloadId !== interrupted.downloadId || result.format !== 'zip'
      || resolve(result.archivePath || '').toLowerCase() !== resolve(interrupted.targetPath).toLowerCase()
      || !Array.isArray(result.files) || result.files.length === 0 || !(result.unpackedBytes > 0)
      || result.source?.repository !== `https://github.com/${specification.repository}`
      || result.source?.version !== specification.tag || result.source?.releaseId !== specification.releaseId
      || result.source?.assetId !== specification.assetId) throw new Error('The continued native task did not return the same completed ZIP and fixed source receipt.');
    const bytes = await readFile(result.archivePath), sha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== specification.assetBytes || bytes.readUInt32LE(0) !== 0x04034b50
      || result.source.sha256 !== sha256
      || createHash('sha256').update(bytes.subarray(0, interrupted.bytes)).digest('hex') !== interrupted.sha256
      || preview.expectedSha256 && preview.expectedSha256 !== sha256) throw new Error('Completed ZIP size, receipt hash, upstream digest or saved prefix mismatch.');
    return { taskId: task.id, downloadId: result.downloadId, archivePath: result.archivePath, bytes: bytes.length, sha256, savedPrefixBytes: interrupted.bytes, savedPrefixSha256: interrupted.sha256, productionZipInventoryFiles: result.files.length, upstreamDigestVerified: Boolean(preview.expectedSha256), noInstallationOrInvocation: true };
  } };
}
