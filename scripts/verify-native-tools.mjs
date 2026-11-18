import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeUiaSession } from './native-uia-client.mjs';
import { createPerformanceFixture } from './performance-fixture.mjs';

const argumentTokens = process.argv.slice(2);
const args = Object.fromEntries(argumentTokens.reduce((out, item, i, all) => item.startsWith('--') ? [...out, [item.slice(2), all[i + 1]?.startsWith('--') || !all[i + 1] ? true : all[i + 1]]] : out, []));
const transportFlag = '--transport-file-sha256';
const transportInput = args['transport-file-sha256'];
const transportFlags = argumentTokens.filter(token => token === transportFlag).length;
if (transportFlags > 1 || (transportFlags && (typeof transportInput !== 'string' || !/^[a-f0-9]{64}$/i.test(transportInput)))) {
  throw new Error('--transport-file-sha256 requires one exact SHA256 digest.');
}
const requestedTransportSha256 = transportInput?.toLowerCase();
if (args.help) {
  console.log('Prepare: --prepare. Native acceptance: --candidate <release exe> --candidate-build-info <json> [--prepared <report.json>] [--transport-file-sha256 <64hex>]. The transport digest defaults to the candidate digest. Uses only generated data plus explicitly adopted existing tool roots, real GUI confirmations and fixed read-only task observations. No login changes, installations or Dragon launch.');
  process.exit(0);
}
const approved = 'D:\\03_github_projects\\Agent_Management\\Agent_Resource_Manager\\validation\\manager-data';
const roots = { agentReach: 'D:\\03_github_projects\\Web_Tools\\Agent_Reach', edgeControl: 'D:\\03_github_projects\\Web_Tools\\Playwright-MCP', dragonCodexBoot: 'D:\\03_github_projects\\Interface_Tools\\Dragon_Codex_Boot' };
const names = { agentReach: 'Agent Reach', edgeControl: 'Playwright MCP', dragonCodexBoot: 'DragonCodexBoot' };
const scope = { mutations: 'Only the generated management database receives catalogue, task and evidence records; tool-native command bookkeeping may update its own health observations.', browser: 'Use existing Edge extension/profile; no browser navigation, login, account change, credential extraction or user browser shutdown is requested.', dragon: 'Metadata adoption only. No launcher execution or integration change.', evidence: 'Actual single action result only; version/doctor/channels do not prove all platform reads, and MCP initialize does not prove a tool result.', privacy: 'No browser contents, tool stdout/stderr, environment values, token or URL lists are persisted.' };
const sleep = ms => new Promise(done => setTimeout(done, ms));
const hash = async path => { const digest = createHash('sha256'); for await (const data of createReadStream(path)) digest.update(data); return digest.digest('hex'); };
const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
const active = value => ['queued', 'running'].includes(value.status);
const exec = promisify(execFile);
async function wait(read, predicate, ms = 20000) {
  const deadline = Date.now() + ms;
  for (;;) { const value = await read(); if (predicate(value)) return value; if (Date.now() >= deadline) throw new Error('Exact owned native state did not become available; no operation was replayed.'); await sleep(50); }
}
async function invoke(app, name, scope) {
  report.lastStep = 'control:' + name;
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  await wait(() => app.call('state', { name, ...(scope ? { scope } : {}) }), value => array(value).filter(item => item.type === 'ControlType.Button' && item.enabled).length === 1);
  return app.call('invokeName', { name, ...(scope ? { scope } : {}) });
}
async function field(app, prefix, type = 'ControlType.Edit') {
  report.lastStep = 'field:' + prefix;
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  const fields = await wait(() => app.call('fields'), value => array(value).some(item => item.type === type && item.name.startsWith(prefix) && item.enabled));
  const matches = array(fields).filter(item => item.type === type && item.name.startsWith(prefix) && item.enabled);
  assert.equal(matches.length, 1, 'Native field must be unique.'); return matches[0].name;
}
async function fill(app, prefix, value) { return app.call('setField', { name: await field(app, prefix), value }); }
async function clickTask(app, name, action, buttonScope) {
  report.lastStep = 'task:' + action;
  const previous = new Set((await app.call('tasks')).tasks.map(task => task.id));
  await invoke(app, name, buttonScope);
  const observed = await wait(() => app.call('tasks'), value => value.tasks.some(task => !previous.has(task.id) && task.action === action));
  const matches = observed.tasks.filter(task => !previous.has(task.id) && task.action === action);
  assert.equal(matches.length, 1, 'Native action must create exactly one expected task.');
  return (await wait(() => app.call('task', { taskId: matches[0].id }), value => value.task && !active(value.task), 65000)).task;
}
function assertSuccess(task) { assert.equal(task.status, 'succeeded', `Native ${task.action} did not succeed; inspect its redacted status evidence.`); return task.result; }
function protocol(value) {
  if (!value || typeof value !== 'object') return null;
  return { method: value.method, toolName: value.toolName, protocolVersion: value.protocolVersion, rpcResultReceived: value.rpcResultReceived, isError: value.isError, jsonRpcError: value.jsonRpcError };
}
function actionObservation(task) {
  const result = task.result, run = result?.run;
  return { taskId: task.id, taskAction: task.action, taskStatus: task.status, run: run ? { runId: run.runId, resourceId: run.resourceId, actionId: run.actionId, mode: run.mode, status: run.status, pid: run.pid, exitCode: run.exitCode, startedAt: run.startedAt, finishedAt: run.finishedAt, protocol: protocol(run.protocolEvidence) } : null, evidenceSaved: result?.capabilityEvidence?.saved === true, evidenceWarning: typeof result?.capabilityEvidenceWarning === 'string', noOutputPersisted: true };
}
async function processes(directory) {
  const command = "$ErrorActionPreference='Stop';$all=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('msedge.exe','Codex.exe') });$ids=@($all.ProcessId);@($all | Where-Object { $_.ParentProcessId -notin $ids } | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;parentPid=$_.ParentProcessId;name=$_.Name;created=$_.CreationDate.ToUniversalTime().ToString('o')} }) | ConvertTo-Json -Compress";
  const { stdout } = await exec('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, TEMP: directory, TMP: directory } });
  return array(JSON.parse(stdout.trim() || '[]'));
}
const sameProcess = (before, after) => before.every(item => after.some(current => current.pid === item.pid && current.created === item.created && current.name === item.name));
const fixedFiles = {
  agentReach: ['agent-reach.cmd', 'Scripts/agent-reach.exe', 'Lib/site-packages/agent_reach/cli.py', 'Lib/site-packages/agent_reach/runtime/cli.py', 'Lib/site-packages/agent_reach/runtime/manage.py'],
  edgeControl: ['install-manifest.json', 'node_modules/@playwright/mcp/cli.js', 'node_modules/@playwright/mcp/package.json', 'node_modules/playwright-core/package.json', 'node_modules/playwright-core/lib/coreBundle.js', 'node_modules/playwright-core/lib/utilsBundle.js'],
  dragonCodexBoot: ['DragonCodexBoot.exe', 'VERSION', 'launcher.json'],
};
async function rootHashes() {
  return Object.fromEntries(await Promise.all(Object.entries(fixedFiles).map(async ([adapter, files]) => [adapter, await Promise.all(files.map(async path => ({ path, sha256: await hash(join(roots[adapter], path)) })))])));
}
async function provenance() {
  assert.equal(typeof args.candidate, 'string'); assert.equal(typeof args['candidate-build-info'], 'string');
  const path = resolve(args.candidate), buildInfoPath = resolve(args['candidate-build-info']);
  assert.equal(basename(path).toLowerCase(), 'agent-resource-manager.exe');
  const bytes = await readFile(path), offset = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.readUInt16LE(0), 0x5a4d); assert.equal(bytes.readUInt32LE(offset), 0x4550); assert.equal(bytes.readUInt16LE(offset + 4), 0x8664);
  const sha256 = await hash(path), buildInfo = JSON.parse(await readFile(buildInfoPath, 'utf8'));
  assert.equal(buildInfo.buildMode, 'release'); assert.equal((buildInfo.executableSha256 || buildInfo.sha256)?.toLowerCase(), sha256); assert.ok(buildInfo.sourceIdentity || buildInfo.sourceCommit);
  return { path, sha256, buildInfoPath, buildInfoSha256: await hash(buildInfoPath), sourceIdentity: buildInfo.sourceIdentity || buildInfo.sourceCommit, version: buildInfo.version };
}
async function adopt(app, adapter) {
  await invoke(app, '登记现有工具'); await fill(app, '原目录', roots[adapter]); await invoke(app, '接管现有工具');
  await app.call('selectCombo', { name: await field(app, '接管工具类型', 'ControlType.ComboBox'), option: names[adapter] });
  const preview = assertSuccess(await clickTask(app, '预览接管', 'preview_resource_adapter'));
  assert.equal(preview.adapter, adapter); assert.equal(preview.canApply, true); assert.equal(resolve(preview.rootPath).toLowerCase(), resolve(roots[adapter]).toLowerCase());
  for (const key of ['sourceVerified', 'filesChanged', 'deleteGrant', 'automaticUpdateGrant']) assert.equal(preview[key], false);
  const applied = assertSuccess(await clickTask(app, '保存接管', 'apply_resource_adapter'));
  for (const key of ['complete', 'adopted']) assert.equal(applied[key], true);
  for (const key of ['executed', 'filesChanged', 'sourceVerified']) assert.equal(applied[key], false);
  assert.equal(applied.ownership, 'external'); assert.equal(applied.resource.ownership, 'external');
  if (adapter === 'dragonCodexBoot') assert.equal(applied.resource.actions.length, 0, 'Dragon must have no trial launch action.');
  await invoke(app, '关闭编辑');
  return { adapter, resourceId: applied.resource.id, name: applied.resource.name, rootPath: applied.resource.rootPath, version: applied.resource.version, metadataAdopted: true, executedDuringAdoption: false, actions: applied.resource.actions.map(action => ({ id: action.id, label: action.label, mode: action.mode })) };
}
async function callAction(app, label, url) {
  await invoke(app, `使用${label}`);
  if (url) await fill(app, '公开网页 URL', url);
  return actionObservation(await clickTask(app, '执行', 'resource_invoke'));
}
async function capability(app) {
  await invoke(app, '调用证据');
  const result = assertSuccess(await clickTask(app, '读取调用证据', 'resource_capability_evidence'));
  assert.equal(result.scope, 'ownedActionCompletion'); assert.equal(result.outputStored, false); assert.equal(result.parametersStored, false);
  return { resourceId: result.resourceId, scope: result.scope, total: result.total, actions: result.actions.map(action => ({ actionId: action.actionId, status: action.status, completionKind: action.latest?.completionKind || null, processStatus: action.latest?.processStatus || null, exitCode: action.latest?.exitCode ?? null, protocol: protocol(action.latest?.protocol) })) };
}

await mkdir(approved, { recursive: true });
let report, reportPath;
if (args.prepared) {
  reportPath = resolve(args.prepared); assert.ok(reportPath.startsWith(approved + '\\'));
  report = JSON.parse(await readFile(reportPath, 'utf8')); assert.equal(report.status, 'prepared'); assert.equal(report.fixture.skillCount, 1000); assert.equal(report.fixture.toolCount, 0);
  assert.deepEqual(report.roots, roots); assert.equal(resolve(reportPath), join(report.output, 'report.json'));
} else {
  const output = await mkdtemp(join(approved, 'native-tools-'));
  report = { formatVersion: 1, status: 'prepared', output, roots, fixture: await createPerformanceFixture(output, 'catalogue', 0), scope, adoptions: [], actions: [], capabilities: [], limitations: [] };
  reportPath = join(output, 'report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}
if (args.prepare) { console.log(JSON.stringify({ status: 'prepared', reportPath, fixture: report.fixture.dataDir, noNativeLaunch: true })); process.exit(0); }
let app;
try {
  report.candidate = await provenance();
  const transportSha256 = requestedTransportSha256 || report.candidate.sha256;
  report.transportFileSha256 = transportSha256;
  report.harness = await Promise.all(['verify-native-tools.mjs', 'native-uia-client.mjs', 'verify-native-uia.ps1', 'performance-fixture.mjs'].map(async name => ({ name, sha256: await hash(fileURLToPath(new URL(name, import.meta.url))) })));
  report.staticBefore = await rootHashes(); report.processesBefore = await processes(report.output); report.startedAt = new Date().toISOString();
  report.status = 'running';
  app = await NativeUiaSession.launch({ executable: report.candidate.path, sha256: report.candidate.sha256, transportSha256, dataDir: report.fixture.dataDir, reportPath: join(report.output, 'native-driver.json'), privateUi: true, accessibilityInput: true });
  assert.equal(app.privateUi, true, 'Private native observations must be enforced by the driver.');
  assert.equal(app.identity.executableSha256, report.candidate.sha256); assert.equal(resolve(app.identity.dataDirectory).toLowerCase(), resolve(report.fixture.dataDir).toLowerCase());
  report.native = { pid: app.identity.pid, creationFileTime: app.identity.creationFileTime, executableSha256: app.identity.executableSha256, dataDirectory: app.identity.dataDirectory };
  await invoke(app, '工具', '主要导航');
  for (const adapter of ['agentReach', 'edgeControl', 'dragonCodexBoot']) report.adoptions.push(await adopt(app, adapter));
  await invoke(app, 'Agent Reach');
  for (const label of ['读取 CLI 版本', '检查本地依赖', '列出平台与动作']) report.actions.push(await callAction(app, label));
  report.actions.push(await callAction(app, '读取公共网页', 'https://example.com'));
  report.capabilities.push(await capability(app));
  await invoke(app, 'Playwright MCP');
  for (const label of ['读取 MCP 版本', '列出 Edge 标签页', '读取当前 Edge 页面']) report.actions.push(await callAction(app, label));
  report.capabilities.push(await capability(app));
  report.processesBeforeOwnedDisconnect = await processes(report.output);
  const disconnects = array(await app.call('state', { name: '断开连接' })).filter(item => item.type === 'ControlType.Button' && item.enabled);
  if (disconnects.length) {
    assert.equal(disconnects.length, 1, 'Only one explicitly owned Edge transport may be disconnected.');
    const stopped = await clickTask(app, '断开连接', 'resource_stop');
    report.disconnect = { taskId: stopped.id, status: stopped.status, runStatus: stopped.result?.run?.status, mode: stopped.result?.run?.mode, protocolSession: stopped.result?.run?.protocolSession, exitCode: stopped.result?.run?.exitCode ?? null };
    assert.equal(report.disconnect.status, 'succeeded'); assert.equal(report.disconnect.protocolSession, true); assert.equal(report.disconnect.runStatus, 'stopped');
  } else report.disconnect = { attempted: false, reason: 'No running manager-owned Edge connection remained after the observed calls.' };
  report.processesAfterOwnedDisconnect = await processes(report.output); report.existingProcessesPreservedAtDisconnect = sameProcess(report.processesBeforeOwnedDisconnect, report.processesAfterOwnedDisconnect);
  assert.equal(report.existingProcessesPreservedAtDisconnect, true, 'A preexisting Edge or Codex main-process identity disappeared; review this observation before claiming independence.');
  report.normalExit = (await app.quit()).driverReport.closedNormally; app = null;
  report.staticAfter = await rootHashes(); assert.deepEqual(report.staticAfter, report.staticBefore, 'Existing fixed entry/binding files changed during native acceptance.');
  report.processesAfter = await processes(report.output); report.existingProcessesPreserved = sameProcess(report.processesBefore, report.processesAfter);
  report.status = report.actions.every(action => action.taskStatus === 'succeeded' && action.run?.status === 'succeeded' && action.evidenceSaved && !action.evidenceWarning) && report.existingProcessesPreserved ? 'observed-actions-passed' : 'observed-with-limitations';
  if (report.status !== 'observed-actions-passed') report.limitations.push('One or more real actions or existing-process observations did not pass; the individually recorded result remains authoritative. No browser/login remedy or write retry was executed.');
} catch (error) {
  report.status = 'failed-or-blocked'; report.failure = { name: error.name, message: String(error.message).slice(0, 600), scope: 'Harness invariant or exact native control; no tool output is copied.' };
} finally {
  if (app) { try { report.normalExit = (await app.quit()).driverReport.closedNormally; } catch { report.normalExit = false; report.limitations.push('Normal test-app quit was not verified; no forced browser or process-name termination was attempted.'); } }
  report.finishedAt = new Date().toISOString(); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ status: report.status, reportPath, adoptions: report.adoptions.length, actions: report.actions.length, normalExit: report.normalExit }));
if (report.status === 'failed-or-blocked') process.exitCode = 1;
