import { readFile, writeFile, appendFile, mkdir, mkdtemp, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, hostname, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { NativeUiaSession, assertNoUserManager } from './native-uia-client.mjs';
import { beginUiaNativeStage, beginUiaNativeDownload, resumeUiaNativeDownload } from './native-uia-loads.mjs';
import { readNativeLoadFixture, attachNativeLoadResource } from './performance-load-fixture.mjs';
import { createPerformanceFixture } from './performance-fixture.mjs';
import { PERFORMANCE_POLICY as policy, ownedForeground, startupComparison, localInteractionVerdict, backgroundLoadVerdict, freezeConvergenceBounds, stabilityVerdict } from './performance-policy.mjs';

const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, index, args) => arg.startsWith('--') ? [...pairs, [arg.slice(2), args[index + 1]?.startsWith('--') || !args[index + 1] ? true : args[index + 1]]] : pairs, []));
function validateLoadSelection(options, suite) {
  const kind = options['load-kind'];
  if (kind !== undefined && (suite !== 'loads' || !['check', 'download', 'update'].includes(kind))) throw new Error('--load-kind requires --suite loads and exactly check, download or update.');
  if (suite === 'loads') {
    if (kind === undefined && (!options['download-spec'] || !options['stage-fixture'])) throw new Error('The loads suite requires both --download-spec and --stage-fixture.');
    if (kind === 'download' && !options['download-spec']) throw new Error('The download-only loads selection requires --download-spec.');
    if (kind === 'update' && !options['stage-fixture']) throw new Error('The update-only loads selection requires --stage-fixture.');
  }
  return kind;
}
function validateInteractionSelection(options, suite) {
  const kind = options['interaction-kind'];
  if (kind !== undefined && (suite !== 'interactive' || kind !== 'document')) throw new Error('--interaction-kind requires --suite interactive and exactly document.');
  if (kind !== undefined && ['load-kind', 'download-spec', 'stage-fixture'].some(name => options[name] !== undefined)) throw new Error('--interaction-kind document cannot be combined with load selection or specifications.');
  return kind;
}
function transportDigest(value, candidateSha256) {
  if (value === undefined) return candidateSha256;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) throw new Error('--transport-file-sha256 requires one exact SHA256 digest.');
  return value.toLowerCase();
}
if (options.help) {
  console.log('Native release UIAutomation acceptance: --candidate <exe> --candidate-build-info <json> [--baseline <v0.2.11 exe> --baseline-build-info <json>] --suite prepare|probe|startup|interactive|loads|stability|all. Measured interactions require the exact owned window in the foreground before and after input. Optional --accessibility-input --concurrent-observation separates observed UI readiness from the accessibility call return as diagnostics only. Optional --foreground-select true permits guarded foreground keyboard selection only for GitHub release and asset dropdowns; these functional-only selections are recorded separately and do not change the measured UIA category. Optional --await-foreground true is restricted to probe, interactive, loads or stability; after native readiness it prints the owned PID/HWND and waits up to sixty seconds for external activation using read-only observations. It sends no input and changes no measurement threshold. The complete loads suite requires --download-spec and --stage-fixture. All files stay in the approved validation directory. Downloads require an explicit specification.');
  console.log('Optional --closed-select true is limited to --suite loads --accessibility-input. It uses ordinary closed-select Home/Down keyboard setup for the two GitHub fields, records raw option state, and verifies the final exact value. It cannot be combined with --foreground-select.');
  console.log('Optional --popup-select true is limited to --suite loads --accessibility-input. It opens the exact native select by mouse, uses its completed catalogue for bounded Home/Down/Enter, and verifies the retained exact value. Popup focus requires exact RawView ancestry and owned Win32 focus. This functional setup is excluded from P95 and is mutually exclusive with the other select modes.');
  console.log('Optional --load-kind check|download|update is restricted to --suite loads and explicitly resumes that one original workload with the same six measured overlap inputs and thresholds. Download requires --download-spec; update requires --stage-fixture and does not read or download an optional --download-spec. Success is partial-limited evidence only. Omit --load-kind for the original complete loads run, which still requires both specifications.');
  console.log('Optional --interaction-kind document is restricted to --suite interactive without load selection or specifications. It resumes only the original document category with the same unmeasured preparation, one hundred measured inputs and thresholds. Success is document-only partial evidence, not a complete interactive or all-suite pass. Omit it for the original four-category run.');
  console.log('Short --suite download-resume --download-spec <existing pinned official spec> creates one fresh approved download directory, starts one native download, normally quits with partial bytes, reopens the same isolated data and explicitly continues via its native history. It runs no interaction/stability loop and makes no performance claim. The existing --accessibility-input, --popup-select true and --await-foreground true setup options are available.');
  console.log('Optional --existing-stdio-proof <json> forwards only an explicitly frozen arm-pinned-existing-stdio-v1 manifest matching the candidate SHA to the unchanged ownership preflight; it does not permit a running GUI/backend.');
  process.exit(0);
}
const requestedTransportSha256 = transportDigest(options['transport-file-sha256']);
const suite = options.suite || 'all';
const interactionKind = validateInteractionSelection(options, suite);
const loadKind = validateLoadSelection(options, suite);
const passedLoadsStatus = loadKind ? 'passed-partial-limited-background-loads-only' : 'passed-background-loads-only';
const passedInteractionStatus = 'passed-partial-document-interactions-only';
if (options['await-foreground'] !== undefined && !['true', 'false'].includes(options['await-foreground'])) throw new Error('--await-foreground requires an explicit true or false.');
if (options['await-foreground'] !== undefined && !['probe', 'interactive', 'loads', 'stability', 'download-resume'].includes(suite)) throw new Error('--await-foreground is available only for probe, interactive, loads, stability or download-resume.');
const awaitForeground = options['await-foreground'] === 'true';
if (options['existing-stdio-proof'] !== undefined && typeof options['existing-stdio-proof'] !== 'string') throw new Error('--existing-stdio-proof requires an explicit JSON path.');
let pinnedTransports, existingStdioProof;
if (options['foreground-select'] !== undefined && ![true, 'true', 'false'].includes(options['foreground-select'])) throw new Error('--foreground-select accepts only true or false.');
const foregroundSelection = options['foreground-select'] === true || options['foreground-select'] === 'true';
if (options['closed-select'] !== undefined && !['true', 'false'].includes(options['closed-select'])) throw new Error('--closed-select requires an explicit true or false.');
const closedSelection = options['closed-select'] === 'true';
if (closedSelection && (!['loads', 'download-resume'].includes(suite) || !options['accessibility-input'] || foregroundSelection)) throw new Error('--closed-select requires the accessibility-only loads or download-resume suite without --foreground-select.');
if (options['popup-select'] !== undefined && !['true', 'false'].includes(options['popup-select'])) throw new Error('--popup-select requires an explicit true or false.');
const popupSelection = options['popup-select'] === 'true';
if (popupSelection && (!['loads', 'download-resume'].includes(suite) || !options['accessibility-input'] || foregroundSelection || closedSelection)) throw new Error('--popup-select requires the accessibility-only loads or download-resume suite without either other select mode.');
const inputCondition = options['accessibility-input'] ? 'native-accessibility-input-to-painted-result' : 'native-ui-input-to-painted-result';
if (options['concurrent-observation'] && !options['accessibility-input']) throw new Error('Concurrent observation requires explicit --accessibility-input.');
if (!['prepare', 'probe', 'startup', 'interactive', 'loads', 'stability', 'all', 'download-resume'].includes(suite)) throw new Error('Unsupported native acceptance suite.');
if (suite === 'download-resume' && (!options['download-spec'] || options['stage-fixture'] || options['concurrent-observation'])) throw new Error('download-resume requires only one explicit --download-spec and synchronous native observation; no stage fixture.');
const approved = 'D:\\03_github_projects\\Agent_Management\\Agent_Resource_Manager\\validation\\manager-data';
await mkdir(approved, { recursive: true });
const output = await mkdtemp(join(approved, 'uia-performance-')), logPath = join(output, 'observations.jsonl');
const sleep = ms => new Promise(done => setTimeout(done, Math.max(0, ms)));
const emit = async (kind, value) => appendFile(logPath, JSON.stringify({ observedAt: new Date().toISOString(), kind, ...value }) + '\n');
const digest = async path => { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); };
const harnessNames = ['verify-uia-performance.mjs', 'native-uia-client.mjs', 'verify-native-uia.ps1', 'native-uia-loads.mjs', 'performance-load-fixture.mjs', 'performance-policy.mjs', 'performance-fixture.mjs'];
const harness = await Promise.all(harnessNames.map(async name => { const path = fileURLToPath(new URL(name, import.meta.url)); return { path, sha256: await digest(path) }; }));
const report = { inputMethod: options['accessibility-input'] ? 'native-accessibility-patterns' : 'SendInput', formatVersion: 1, status: 'incomplete', suite, output, policy, harness, machine: { hostname: hostname(), platform: process.platform, release: release(), logicalProcessors: cpus().length, cpuModel: cpus()[0]?.model, node: process.version }, measurement: { mode: options['accessibility-input'] ? 'same-release-native-Windows-UIAutomation-patterns-DwmFlush' : 'same-release-native-Windows-UIAutomation-SendInput-DwmFlush', start: 'native monotonic clock immediately before Process.Start; driver compilation excluded', interaction: options['accessibility-input'] ? 'before native UIAutomation pattern invocation, through the exact expected native UI result and two DwmFlush calls; UIA observation cost included' : 'before SendInput, through the exact expected native UI result and two DwmFlush calls; UIA observation cost included', cold: 'fresh database and app WebView profile; operating-system caches untouched', warm: 'same app profile and data, after complete native backend shutdown', processMemory: 'sum of owned manager and descendant process private bytes; summed working sets recorded separately', noRealResources: true }, startup: { baseline: { cold: [], warm: [] }, candidate: { cold: [], warm: [] } }, interactions: [], backgroundCoverage: [], nativeErrors: [], limitations: ['Application-cold does not claim a reboot or purged operating-system cache.', 'Download and update concurrency require actual same-native-candidate load evidence; local check overlap alone does not satisfy those workloads.'] };
report.observationMode = options['concurrent-observation'] ? 'concurrent-accessibility-diagnostic' : 'synchronous-input-then-observation';
report.foregroundSelectionRequested = foregroundSelection;
report.closedSelectionRequested = closedSelection;
report.popupSelectionRequested = popupSelection;
report.foregroundAwaitRequested = awaitForeground;
report.measurement.foregroundCondition = 'Measured interactions require matching launched PID and captured/main/foreground HWND before and after input, plus true native foregroundBefore/foregroundAfter flags. Nonmeasured setup and stability cycles keep their existing context.';
report.measurement.stabilityPreparationIdleMs = 120000;
report.functionalSelections = [];
if (interactionKind) {
  report.interactionSelection = { scope: 'partial-limited', kind: interactionKind, omittedKinds: ['search', 'filter', 'tab'], requiredSamples: policy.localSamplesPerCategory, fullInteractiveAcceptanceClaimed: false };
  report.limitations.push('This explicit document-only continuation retains the original unmeasured preparation and document loop. It does not rerun or claim the omitted categories, background loads, startup or stability; existing results are not automatically merged into a complete interactive or all-suite pass.');
}
if (loadKind) {
  report.loadSelection = { scope: 'partial-limited', kind: loadKind, omittedKinds: ['check', 'download', 'update'].filter(kind => kind !== loadKind), requiredOverlapInputs: 6, fullLoadsAcceptanceClaimed: false };
  report.limitations.push('This explicit single-workload continuation does not rerun or claim the omitted workloads. Existing results remain separate evidence; they are not automatically merged into a complete loads pass.');
}
if (foregroundSelection) report.limitations.push('Only GitHub release/asset dropdowns may mix guarded foreground keyboard input into functional setup. Their exact methods are recorded separately; they are excluded from measured UIA interaction samples and do not change the measurement category.');
if (closedSelection) report.limitations.push('GitHub release and asset setup uses an explicitly enabled ordinary closed-select Home/Down keyboard path, with exact final selection. Original accessible-option properties remain recorded and unchanged. This functional setup is excluded from measured interaction samples.');
if (popupSelection) report.limitations.push('Explicit popup selection uses a single guarded native click and completed-catalogue Home/Down/Enter. Each key requires exact RawView focus ancestry and owned Win32 focus. Only the committed native exact value establishes selection, and the existing pinned source/asset preview checks remain required. This functional setup is excluded from measured P95 samples.');
if (options['concurrent-observation']) {
  report.measurement.interaction = 'clock before starting one MTA native accessibility input; main thread observes the exact initially-false result, two DwmFlush calls and reconfirmation; successful input return is independently required before proceeding';
  report.limitations.push('Concurrent accessibility observation is diagnostic only; uiReadyMs, inputCallReturnedMs and inputReturnedAfterReadyMs remain separate and do not replace synchronous acceptance evidence.');
}
await writeFile(join(output, 'policy-before-run.json'), JSON.stringify({ policy, harness, measurement: report.measurement, interactionSelection: report.interactionSelection, loadSelection: report.loadSelection, startedAt: new Date().toISOString() }, null, 2));

async function executableInfo(path, buildInfoPath) {
  if (typeof path !== 'string' || typeof buildInfoPath !== 'string') throw new Error('Pass the native release executable and its exact build-info JSON.');
  path = resolve(path); buildInfoPath = resolve(buildInfoPath);
  if (!/^(agent-resource-manager|skill-manager)\.exe$/i.test(basename(path))) throw new Error('Pass the real app executable, not an installer.');
  const bytes = await readFile(path), offset = bytes.readUInt32LE(0x3c);
  if (bytes.readUInt16LE(0) !== 0x5a4d || bytes.readUInt32LE(offset) !== 0x4550 || bytes.readUInt16LE(offset + 4) !== 0x8664) throw new Error('Only the native Windows x64 release may be measured.');
  const sha256 = await digest(path), buildInfo = JSON.parse(await readFile(buildInfoPath, 'utf8'));
  if (buildInfo.buildMode !== 'release' || (buildInfo.executableSha256 || buildInfo.sha256)?.toLowerCase() !== sha256 || !(buildInfo.sourceIdentity || buildInfo.sourceCommit)) throw new Error('The build-info does not bind the exact release bytes and source identity.');
  return { path, sha256, source: buildInfo.sourceIdentity || buildInfo.sourceCommit, buildInfoPath, buildInfoSha256: await digest(buildInfoPath), buildMode: 'release', releaseProvenanceVerified: true, version: buildInfo.version || null };
}

async function launch(info, fixture, label) {
  if (await digest(info.path) !== info.sha256 || await digest(info.buildInfoPath) !== info.buildInfoSha256) throw new Error('Candidate bytes or source provenance changed during this native acceptance run.');
  if (existingStdioProof && await digest(existingStdioProof.path) !== existingStdioProof.sha256) throw new Error('The frozen existing-stdio manifest changed; no native launch was attempted.');
  const transportSha256 = requestedTransportSha256 || info.sha256;
  if (suite === 'download-resume') {
    const checked = await assertNoUserManager({ transportSha256, ...(pinnedTransports ? { pinnedTransports } : {}) });
    await emit('download-resume-launch-preflight', { label, ...checked });
  }
  const prepareFunctionalForeground = (foregroundSelection || closedSelection || popupSelection) && Boolean(options['accessibility-input']) && (label === 'candidate-mixed-1000-100' || suite === 'download-resume');
  const app = await NativeUiaSession.launch({ executable: info.path, sha256: info.sha256, transportSha256, dataDir: fixture.dataDir, reportPath: join(output, `${label}-driver.json`), accessibilityInput: Boolean(options['accessibility-input']), concurrentObservation: Boolean(options['concurrent-observation']), keyboardInput: prepareFunctionalForeground, ...(pinnedTransports ? { pinnedTransports } : {}) });
  if (app.identity.executableSha256 !== info.sha256 || resolve(app.identity.dataDirectory).toLowerCase() !== resolve(fixture.dataDir).toLowerCase()) { app.child.stdin.end(); throw new Error('The native driver did not open the exact isolated fixture.'); }
  app.info = info; app.fixture = fixture; app.label = label; app.foregroundSelection = foregroundSelection; app.functionalSelections = report.functionalSelections;
  app.closedComboSelection = closedSelection;
  app.popupComboSelection = popupSelection;
  await emit('native-startup', { label, ...app.identity, executable: info.path, sourceIdentity: info.source, skillCount: fixture.skillCount, toolCount: fixture.toolCount, completeBackendStartup: true });
  if (awaitForeground && (closedSelection || popupSelection)) {
    try { await awaitOwnedForeground(app); }
    catch (error) {
      try { await close(app); } catch (closeError) { report.nativeErrors.push({ phase: 'closed-selection-foreground-normal-exit', message: String(closeError.message) }); }
      throw error;
    }
  }
  if (prepareFunctionalForeground) {
    try {
      const preparation = await app.call('prepareKeyboardForeground');
      (report.foregroundPreparations ||= []).push({ phase: 'functional-selection-preparation', label, ...preparation });
      await emit('functional-selection-preparation', preparation);
    } catch (error) {
      try { await close(app); } catch (closeError) { report.nativeErrors.push({ phase: 'functional-selection-preparation-normal-exit', message: String(closeError.message) }); }
      throw error;
    }
  }
  if (awaitForeground && !closedSelection && !popupSelection) {
    try { await awaitOwnedForeground(app); }
    catch (error) {
      try { await close(app); } catch (closeError) { report.nativeErrors.push({ phase: 'foreground-preparation-normal-exit', message: String(closeError.message) }); }
      throw error;
    }
  }
  return app;
}
async function awaitOwnedForeground(app) {
  const started = performance.now(), timeoutMs = 60000;
  const request = { phase: 'await-owned-foreground', label: app.label, pid: app.identity.pid, windowHandle: app.identity.windowHandle, creationFileTime: app.identity.creationFileTime, timeoutMs, method: 'read-only-owned-window-identity' };
  console.log(JSON.stringify(request)); await emit('foreground-preparation-start', request);
  const deadline = started + timeoutMs;
  for (;;) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw new Error('The exact owned PID/HWND was not observed in the foreground within sixty seconds; no focus retry or input was sent.');
    const identity = await app.call('windowIdentity', {}, Math.min(20000, remaining));
    if (identity.capturedHandle !== app.identity.windowHandle || identity.currentMainHandle !== app.identity.windowHandle || identity.uiaProcessId !== app.identity.pid) throw new Error('The observed native PID/HWND changed while awaiting foreground activation.');
    if (ownedForeground(identity, app.identity) && performance.now() <= deadline) {
      const observed = { ...request, elapsedMs: performance.now() - started, foregroundHandle: identity.foregroundHandle };
      (report.foregroundPreparations ||= []).push(observed); await emit('foreground-preparation-observed', observed); return;
    }
    await sleep(Math.min(250, Math.max(0, deadline - performance.now())));
  }
}
async function close(app) { if (app) { const result = await app.quit(); await emit('native-normal-exit', { label: app.label, pid: app.identity.pid, creationFileTime: app.identity.creationFileTime, closedNormally: result.driverReport.closedNormally }); } }
async function interaction(app, op, fields = {}, measured = true) {
  if (!measured) return app.call(op, fields);
  const before = await app.call('windowIdentity');
  if (!ownedForeground(before, app.identity)) {
    report.foregroundFailure = { phase: 'before-measured-input', op, expected: app.identity, identity: before };
    await emit('native-measurement-foreground-rejected', report.foregroundFailure);
    throw new Error('The exact owned PID and captured/main HWND must be foreground before a measured interaction.');
  }
  const sample = await app.call(op, fields);
  let after;
  try {
    after = await app.call('windowIdentity');
    if (!ownedForeground(after, app.identity) || sample.foregroundBefore !== true || sample.foregroundAfter !== true
      || sample.pid !== app.identity.pid || sample.windowHandle !== app.identity.windowHandle || sample.creationFileTime !== app.identity.creationFileTime) {
      throw new Error('The measured input lost the exact owned foreground condition or native process/window identity.');
    }
  } catch (error) {
    report.foregroundFailure = { phase: 'after-measured-input', op, expected: app.identity, before, after: after || null, error: String(error) };
    (report.rejectedInteractions ||= []).push(sample);
    await emit('native-interaction-rejected', { ...report.foregroundFailure, sample });
    throw error;
  }
  report.interactions.push(sample); await emit('native-interaction', sample); return sample;
}
async function check(app) {
  const before = await app.call('tasks'), known = new Set(before.tasks.map(task => task.id));
  await app.call('check');
  const deadline = performance.now() + 20000;
  for (;;) {
    const after = await app.call('tasks');
    const created = after.tasks.filter(task => !known.has(task.id) && task.action === 'check_now');
    if (created.length > 1) throw new Error('The native check control created more than one check task.');
    if (created.length === 1) return { observedAt: new Date().toISOString(), taskIds: created.map(task => task.id), initialStatuses: created.map(task => task.status) };
    if (performance.now() >= deadline) throw new Error('The native check task was not observed before the deadline; the click was not replayed.');
    await sleep(30);
  }
}
async function recordBackground(app, initial, category) { const after = await app.call('tasks'); report.backgroundCoverage.push({ category, ...initial, tasks: after.tasks.filter(task => initial.taskIds.includes(task.id)).map(task => ({ id: task.id, status: task.status, createdAt: task.createdAt, startedAt: task.startedAt, finishedAt: task.finishedAt })), kind: 'native-local-check-only' }); }
async function interactionRun(app, count) {
  let load;
  if (!interactionKind) {
    load = await check(app);
    for (let i = 0; i < count; i++) await interaction(app, 'search', { index: i });
    await recordBackground(app, load, 'search'); await app.call('clear'); load = await check(app);
    for (let i = 0; i < count; i++) await interaction(app, 'filter', { github: i % 2 === 0 });
    await recordBackground(app, load, 'filter');
  }
  await interaction(app, 'search', { index: 0 }, false); await interaction(app, 'openDocument', { index: 0 }, false);
  if (!interactionKind) {
    load = await check(app);
    for (let i = 0; i < count; i++) await interaction(app, 'tab', { home: i % 2 === 0 });
    await recordBackground(app, load, 'tab');
  }
  await app.call('closeDocument', { index: 0 }); load = await check(app);
  for (let i = 0; i < count; i++) { await interaction(app, 'search', { index: i + 10 }, false); await interaction(app, 'openDocument', { index: i + 10 }); await app.call('closeDocument', { index: i + 10 }); }
  await recordBackground(app, load, 'document'); await app.call('clear');
}
async function loadSample(app, load, op, fields) {
  const before = (await app.call('tasks')).tasks.find(task => task.id === load.taskId), beforeObservedAtMs = Date.now();
  const sample = await interaction(app, op, fields);
  const after = (await app.call('tasks')).tasks.find(task => task.id === load.taskId), afterObservedAtMs = Date.now();
  const record = { kind: load.kind, taskId: load.taskId, taskAction: before?.action || after?.action, beforeStatus: before?.status, afterStatus: after?.status, beforeObservedAtMs, afterObservedAtMs, taskStartedAt: before?.startedAt || after?.startedAt, taskFinishedAt: after?.finishedAt, sample };
  (report.loadCoverage ||= []).push(record); await emit('native-background-input-overlap', record);
}
async function loadInteractions(app, load) {
  await loadSample(app, load, 'search', { index: 17 }); await app.call('clear');
  await loadSample(app, load, 'filter', { github: true }); await loadSample(app, load, 'filter', { github: false });
  await interaction(app, 'search', { index: 0 }, false); await loadSample(app, load, 'openDocument', { index: 0 });
  await loadSample(app, load, 'tab', { home: true }); await loadSample(app, load, 'tab', { home: false });
  await app.call('closeDocument', { index: 0 }); await app.call('clear');
  if (load.finish) { const value = await load.finish(); await emit('native-load-finished', { kind: load.kind, ...value }); }
}
async function backgroundLoads(app) {
  if (!loadKind || loadKind === 'check') {
    const local = await check(app); if (local.taskIds.length !== 1) throw new Error('The actual native local check task was not uniquely observed.');
    await loadInteractions(app, { kind: 'check', taskId: local.taskIds[0] }); await waitTasks(app);
  }
  if ((!loadKind || loadKind === 'download') && options['download-spec']) {
    const path = resolve(options['download-spec']), specification = JSON.parse(await readFile(path, 'utf8')); report.downloadSpecification = { path, sha256: await digest(path) };
    await loadInteractions(app, await beginUiaNativeDownload(app, app.fixture, specification));
  }
  if ((!loadKind || loadKind === 'update') && options['stage-fixture']) await loadInteractions(app, await beginUiaNativeStage(app, app.fixture, resolve(options['stage-fixture'])));
  report.loadVerdict = backgroundLoadVerdict(report.loadCoverage || [], app.identity.pid, inputCondition);
}
async function cycle(app, index) {
  await interaction(app, 'search', { index: index % 1000 }, false); await app.call('clear');
  await interaction(app, 'filter', { github: true }, false); await interaction(app, 'filter', { github: false }, false);
  await interaction(app, 'search', { index: 0 }, false); await interaction(app, 'openDocument', { index: 0 }, false);
  await interaction(app, 'tab', { home: true }, false); await interaction(app, 'tab', { home: false }, false); await app.call('closeDocument', { index: 0 }); await app.call('clear');
}
async function waitTasks(app) { const end = performance.now() + 60000; for (;;) { const value = await app.call('tasks'); if (!value.tasks.some(task => ['queued', 'running'].includes(task.status))) return; if (performance.now() >= end) throw new Error('Real tasks remained active; an idle convergence sample cannot be claimed.'); await sleep(50); } }
function cpuDelta(first, second) { const old = new Map(first.processes.map(value => [`${value.pid}:${value.creationFileTime}`, value.cpuMs])); return second.processes.reduce((sum, value) => sum + Math.max(0, value.cpuMs - (old.get(`${value.pid}:${value.creationFileTime}`) ?? 0)), 0); }
async function idleSample(app, elapsedMs) {
  await waitTasks(app); const first = await app.call('memory'), start = performance.now(); await sleep(3000); const second = await app.call('memory');
  const cache = await app.call('cache');
  return { elapsedMs, observedAt: new Date().toISOString(), privateBytes: second.privateBytes, workingSetBytes: second.workingSetBytes, idleCpuPercent: cpuDelta(first, second) / (performance.now() - start) / cpus().length * 100, cache, ownedProcesses: second.processes, idleMeasurementWindowMs: performance.now() - start };
}
async function stabilityRun(app) {
  for (let i = 0; i < policy.warmupCycles; i++) { await cycle(app, i); await emit('fixed-warmup-cycle', { cycle: i + 1 }); }
  await emit('fixed-stability-preparation', { durationMs: report.measurement.stabilityPreparationIdleMs, position: 'after-five-warmup-cycles-before-all-eleven-calibration-samples', adaptive: false });
  await sleep(report.measurement.stabilityPreparationIdleMs);
  const idle = [], calibrationStart = performance.now();
  for (let i = 0; i < policy.idleCalibrationSamples; i++) { await sleep(calibrationStart + i * policy.sampleIntervalMs - performance.now()); const sample = await idleSample(app, performance.now() - calibrationStart); idle.push(sample); await emit('idle-calibration', sample); }
  const bounds = freezeConvergenceBounds(idle); await writeFile(join(output, 'convergence-bounds-before-loop.json'), JSON.stringify(bounds, null, 2));
  const samples = []; let start = performance.now();
  for (let i = 0; i <= policy.stabilityDurationMs / policy.sampleIntervalMs; i++) {
    await sleep(start + i * policy.sampleIntervalMs - performance.now());
    if (i % 2 === 0) await check(app); await cycle(app, i + policy.warmupCycles);
    const sample = await idleSample(app, 0); sample.elapsedMs = performance.now() - start;
    if (!i) { start = performance.now(); sample.elapsedMs = 0; }
    sample.cycle = i + 1; samples.push(sample); await emit('stability-sample', sample);
    console.log(JSON.stringify({ phase: 'native-stability', sample: i + 1, of: 61, privateMiB: +(sample.privateBytes / 1048576).toFixed(1), cacheBytes: sample.cache.bytes }));
  }
  return { warmupCycles: policy.warmupCycles, idleCalibration: idle, bounds, samples, verdict: stabilityVerdict(samples, bounds, policy.warmupCycles) };
}

async function downloadRestartContinue(info, fixture) {
  const specPath = resolve(options['download-spec']), originalSpec = JSON.parse(await readFile(specPath, 'utf8'));
  if (originalSpec.repository !== 'Panniantong/Agent-Reach' || originalSpec.tag !== 'v1.6.0'
    || originalSpec.releaseId !== 421526768 || originalSpec.assetId !== 668240314
    || originalSpec.assetName !== 'agent-reach.zip' || originalSpec.assetBytes !== 676536) throw new Error('Short continuation acceptance requires the existing pinned official asset specification.');
  const resourceParent = 'D:\\03_github_projects\\Agent_Management\\Agent_Resource_Manager\\validation\\resources';
  await mkdir(resourceParent, { recursive: true });
  const directory = await mkdtemp(join(resourceParent, 'native-download-resume-'));
  const specification = { ...originalSpec, directory, bytesPerSecond: 16384 };
  await writeFile(join(output, 'download-resume-spec.json'), JSON.stringify(specification, null, 2) + '\n', { flag: 'wx' });
  const readOriginalData = () => {
    const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      const state = JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload);
      delete state.stateRevision;
      return { state, resources: db.prepare('SELECT id,root_key,payload FROM resource_catalog ORDER BY id').all().map(row => ({ id: row.id, rootKey: row.root_key, record: JSON.parse(row.payload) })) };
    } finally { db.close(); }
  };
  const original = readOriginalData();
  // Ignore only fields added by normal schema initialization; every originally
  // present synthetic value, resource identity and source relationship must remain.
  function originalProjection(value, expected) {
    if (Array.isArray(expected)) {
      if (!Array.isArray(value) || value.length !== expected.length) throw new Error('Original fixture array changed.');
      return expected.map((entry, index) => originalProjection(value[index], entry));
    }
    if (expected !== null && typeof expected === 'object') {
      if (value === null || typeof value !== 'object') throw new Error('Original fixture object changed.');
      return Object.fromEntries(Object.keys(expected).sort().map(key => [key, originalProjection(value[key], expected[key])]));
    }
    if (value !== expected) throw new Error('Original fixture value changed during download/restart.');
    return value;
  }
  const originalSha256 = createHash('sha256').update(JSON.stringify(originalProjection(original, original))).digest('hex');
  const checkOriginalData = () => {
    const proof = createHash('sha256').update(JSON.stringify(originalProjection(readOriginalData(), original))).digest('hex');
    if (proof !== originalSha256) throw new Error('Original synthetic management data changed.');
    return proof;
  };
  report.downloadResume = { scope: 'one-download-normal-restart-explicit-native-continuation-only', inputSpecification: specPath, inputSpecificationSha256: await digest(specPath), effectiveSpecification: specification, originalDataSha256: originalSha256, performanceAcceptanceClaimed: false, passed: false };
  let first, second;
  try {
    first = await launch(info, fixture, 'candidate-download-resume-before-quit');
    const begun = await beginUiaNativeDownload(first, fixture, specification);
    if (!begun.downloadId || !begun.partialPath || !begun.targetPath) throw new Error('Native download preview did not expose its fixed continuation identity.');
    const deadline = Date.now() + 60000;
    for (;;) {
      const task = (await first.call('task', { taskId: begun.taskId })).task;
      if (!task || !['queued', 'running'].includes(task.status)) throw new Error('Download completed or failed before the normal-quit partial checkpoint.');
      const partial = await lstat(begun.partialPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (partial && partial.isFile() && !partial.isSymbolicLink() && partial.size > 0 && partial.size < specification.assetBytes) break;
      if (Date.now() >= deadline) throw new Error('No nonempty partial appeared before the bounded normal-quit checkpoint.');
      await sleep(100);
    }
    const oldIdentity = first.identity;
    await close(first); first = null;
    const partialStat = await lstat(begun.partialPath), partialBytes = await readFile(begun.partialPath);
    if (!partialStat.isFile() || partialStat.isSymbolicLink() || partialBytes.length !== partialStat.size
      || !(partialBytes.length > 0 && partialBytes.length < specification.assetBytes)) throw new Error('Normal quit did not retain a nonempty incomplete ordinary partial.');
    const interrupted = { downloadId: begun.downloadId, partialPath: begun.partialPath, targetPath: begun.targetPath, bytes: partialBytes.length, sha256: createHash('sha256').update(partialBytes).digest('hex') };
    report.downloadResume.interrupted = { ...interrupted, firstTaskId: begun.taskId, processId: oldIdentity.pid, creationFileTime: oldIdentity.creationFileTime, normalExit: true, originalDataSha256: checkOriginalData() };
    await emit('download-resume-normal-quit-partial', report.downloadResume.interrupted);
    second = await launch(info, fixture, 'candidate-download-resume-after-reopen');
    if (second.identity.pid === oldIdentity.pid && second.identity.creationFileTime === oldIdentity.creationFileTime) throw new Error('Restart reused the previous native process.');
    if ((await readFile(interrupted.partialPath)).length !== interrupted.bytes
      || await digest(interrupted.partialPath) !== interrupted.sha256
      || (await second.call('tasks')).tasks.some(task => task.action === 'apply_resource_download' && ['queued', 'running'].includes(task.status))) throw new Error('Reopen resumed or changed the download before explicit user confirmation.');
    checkOriginalData();
    const continued = await resumeUiaNativeDownload(second, fixture, specification, interrupted);
    const completed = await continued.finish();
    report.downloadResume.completed = { ...completed, restoredStatus: continued.restoredStatus, restoredBytes: continued.restoredBytes, noAutomaticRestartObservedMs: continued.noAutomaticRestartObservedMs, secondProcessId: second.identity.pid, secondCreationFileTime: second.identity.creationFileTime };
    await close(second); second = null;
    report.downloadResume.finalOriginalDataSha256 = checkOriginalData();
    report.downloadResume.passed = true;
    await emit('download-resume-explicit-continuation-completed', report.downloadResume.completed);
  } finally {
    if (first) await close(first);
    if (second) await close(second);
  }
}

try {
  const mixed = await createPerformanceFixture(output, 'mixed-native-fixture', 100); report.dataset = mixed;
  if ((!loadKind || loadKind === 'update') && options['stage-fixture']) { const fixture = await readNativeLoadFixture(resolve(options['stage-fixture'])); report.stageFixture = { path: resolve(options['stage-fixture']), sha256: await digest(resolve(options['stage-fixture'])), seed: await attachNativeLoadResource(mixed, fixture) }; }
  if (suite === 'prepare') report.status = 'prepared-not-measured';
  else {
    if (process.platform !== 'win32') throw new Error('Real Windows native acceptance must run on Windows.');
    report.candidate = await executableInfo(options.candidate, options['candidate-build-info']);
    report.transportFileSha256 = requestedTransportSha256 || report.candidate.sha256;
    if (options['existing-stdio-proof']) {
      const path = resolve(options['existing-stdio-proof']), bytes = await readFile(path), manifest = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
      if (manifest.format !== 'arm-pinned-existing-stdio-v1' || manifest.candidateSha256 !== report.transportFileSha256 || !Array.isArray(manifest.transports)) throw new Error('Existing-stdio proof must use the exact format, transport-file SHA and frozen transport list.');
      pinnedTransports = manifest.transports;
      existingStdioProof = { path, sha256: createHash('sha256').update(bytes).digest('hex'), transportCount: pinnedTransports.length, candidateSha256: manifest.candidateSha256 };
      report.existingStdioProof = existingStdioProof;
    }
    if (['startup', 'all'].includes(suite)) {
      report.baseline = await executableInfo(options.baseline, options['baseline-build-info']);
      const warm = {};
      for (const label of ['baseline', 'candidate']) { warm[label] = await createPerformanceFixture(output, `${label}-warm`, 0); let app; try { app = await launch(report[label], warm[label], `${label}-warm-conditioning`); } finally { await close(app); } }
      for (let index = 0; index < policy.startupSamples; index++) for (const label of ['baseline', 'candidate']) for (const condition of ['cold', 'warm']) {
        const fixture = condition === 'cold' ? await createPerformanceFixture(output, `${label}-cold-${index}`, 0) : warm[label];
        let app; try { app = await launch(report[label], fixture, `${label}-${condition}-${index}`); report.startup[label][condition].push(app.identity.startupMs); } finally { await close(app); }
      }
      report.startup.verdict = { cold: startupComparison(report.startup.baseline.cold, report.startup.candidate.cold), warm: startupComparison(report.startup.baseline.warm, report.startup.candidate.warm) };
    }
    if (['probe', 'interactive', 'loads', 'stability', 'all'].includes(suite)) {
      let app;
      try {
        app = await launch(report.candidate, mixed, 'candidate-mixed-1000-100');
        if (['probe', 'interactive', 'all'].includes(suite)) {
          await interactionRun(app, suite === 'probe' ? 2 : policy.localSamplesPerCategory);
          if (suite !== 'probe' && (options['download-spec'] || options['stage-fixture'])) await backgroundLoads(app);
          report.interactionVerdict = localInteractionVerdict(report.interactions, inputCondition);
        }
        if (suite === 'loads') await backgroundLoads(app);
        if (['stability', 'all'].includes(suite)) report.stability = await stabilityRun(app);
      } finally { await close(app); }
    }
    if (suite === 'download-resume') await downloadRestartContinue(report.candidate, mixed);
    const gates = [report.startup.verdict?.cold.status, report.startup.verdict?.warm.status, ...Object.values(report.interactionVerdict || {}).map(value => value.status), report.stability?.verdict.status].filter(Boolean);
    const loadFailure = Object.values(report.loadVerdict || {}).some(value => ['failed', 'invalid'].includes(value.status));
    const loadsPassed = ['check', 'download', 'update'].every(kind => report.loadVerdict?.[kind]?.status === 'passed');
    report.status = gates.some(status => ['failed', 'invalid'].includes(status)) ? 'failed' : suite === 'probe' ? 'diagnostic-only' : suite === 'all' && gates.length === 7 && gates.every(status => status === 'passed') ? loadsPassed ? 'passed' : 'measured-gates-passed-load-coverage-incomplete' : 'incomplete';
    if (suite === 'interactive' && interactionKind && report.status !== 'failed' && report.interactionVerdict?.[interactionKind]?.status === 'passed') report.status = passedInteractionStatus;
    if (suite === 'loads' && (loadKind ? report.loadVerdict?.[loadKind]?.status === 'passed' : loadsPassed)) report.status = passedLoadsStatus;
    if (suite === 'download-resume' && report.downloadResume?.passed === true) report.status = 'passed-native-download-restart-continue-only';
    if (loadFailure) report.status = 'failed';
    if (options['concurrent-observation'] && report.status !== 'failed') report.status = 'diagnostic-only-concurrent-observation';
  }
} catch (error) { report.status = 'blocked-or-failed'; report.error = String(error); process.exitCode = 1; }
finally {
  report.harnessChangedDuringRun = (await Promise.all(harness.map(async file => await digest(file.path) !== file.sha256))).some(Boolean);
  if (report.harnessChangedDuringRun) { report.status = 'failed'; report.error = 'The fixed measurement harness changed during this run.'; }
  report.finishedAt = new Date().toISOString(); await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  if (['failed', 'blocked-or-failed'].includes(report.status)) process.exitCode = 1;
  else if (interactionKind && report.status !== passedInteractionStatus) process.exitCode = 2;
  else if (suite === 'all' && report.status !== 'passed') process.exitCode = 2;
  else if (suite === 'loads' && report.status !== passedLoadsStatus) process.exitCode = 2;
  else if (suite === 'download-resume' && report.status !== 'passed-native-download-restart-continue-only') process.exitCode = 2;
  console.log(JSON.stringify({ status: report.status, report: join(output, 'report.json'), interactionSelection: report.interactionSelection, loadSelection: report.loadSelection, error: report.error || null }));
}
