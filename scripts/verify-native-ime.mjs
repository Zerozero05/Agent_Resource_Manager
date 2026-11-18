import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NativeUiaSession, assertNoUserManager } from './native-uia-client.mjs';
import { createPerformanceFixture } from './performance-fixture.mjs';
import { ownedForeground } from './performance-policy.mjs';

const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, args) => value.startsWith('--') ? [...pairs, [value.slice(2), args[index + 1]]] : pairs, []));
if (Object.hasOwn(options, 'transport-file-sha256') && (typeof options['transport-file-sha256'] !== 'string' || !/^[a-f0-9]{64}$/i.test(options['transport-file-sha256']))) throw new Error('--transport-file-sha256 requires one exact SHA256 digest.');
if (options['await-foreground'] !== undefined) assert.ok(['true', 'false'].includes(options['await-foreground']));
if (options['prepare-chinese-ime'] !== undefined) assert.ok(['true', 'false'].includes(options['prepare-chinese-ime']));
if (Object.hasOwn(options, 'observe-chinese-ime')) assert.ok(['true', 'false'].includes(options['observe-chinese-ime']), '--observe-chinese-ime requires true or false.');
if (Object.hasOwn(options, 'mode-toggle-key')) assert.ok(['shift', 'ctrl'].includes(options['mode-toggle-key']), '--mode-toggle-key supports only shift or ctrl.');
const prepareChineseIme = options['prepare-chinese-ime'] === 'true';
const observeChineseIme = options['observe-chinese-ime'] === 'true';
const modeToggleKey = options['mode-toggle-key'] || 'shift';
assert.ok(!(prepareChineseIme && observeChineseIme), 'Chinese IME observation cannot also request a mode switch.');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const executable = resolve(options.candidate || '');
assert.match(executable, /\.exe$/i, 'Supply the exact normal candidate EXE.');
const build = JSON.parse(await readFile(resolve(options['candidate-build-info'] || ''), 'utf8'));
const executableSha256 = hash(await readFile(executable));
const transportSha256 = options['transport-file-sha256']?.toLowerCase() || executableSha256;
assert.equal(build.buildMode, 'release');
assert.notEqual(build.diagnosticOnly, true);
assert.equal((build.executableSha256 || build.sha256)?.toLowerCase(), executableSha256);
assert.ok(build.sourceIdentity || build.sourceCommit);
const harnessPath = new URL('./verify-native-uia.ps1', import.meta.url);
const clientPath = new URL('./native-uia-client.mjs', import.meta.url);
const harnessSource = await readFile(harnessPath, 'utf8'), clientSource = await readFile(clientPath, 'utf8');
assert.ok(harnessSource.includes('public object KeyboardIme(string name)') && clientSource.includes("op === 'keyboardIme'"), 'The reviewed IME proposal must be applied after the current harness freeze, before any native run.');
let pinnedTransports;
if (options['existing-stdio-proof'] !== undefined) {
  const proofPath = resolve(options['existing-stdio-proof']);
  assert.equal((await realpath(proofPath)).toLowerCase(), proofPath.toLowerCase(), 'The explicit stdio proof must not be redirected.');
  const proofBytes = await readFile(proofPath);
  assert.equal(hash(proofBytes), '32d632fd686121efdec22fe281eddc17711f76ecd18854791a6aec2b7434d685', 'Use the exact separately reviewed existing-stdio manifest.');
  const proof = JSON.parse(proofBytes.toString('utf8'));
  assert.equal(proof.format, 'arm-pinned-existing-stdio-v1');
  assert.equal(proof.candidateSha256, transportSha256);
  assert.equal(proof.noResourceInvokeDuringNativeTests, true);
  assert.equal(proof.loadedImageDigestClaim, false);
  assert.equal(proof.formalBackendAbsentAtObservation, true);
  assert.equal(proof.semanticArgvOnly, true);
  assert.ok(Array.isArray(proof.transports) && proof.transports.length === 12);
  pinnedTransports = proof.transports;
}
await assertNoUserManager({ transportSha256, ...(pinnedTransports ? { pinnedTransports } : {}) });
const parent = 'D:\\03_github_projects\\Agent_Management\\Agent_Resource_Manager\\validation\\manager-data';
const fixture = await createPerformanceFixture(parent, options.name || `native-ime-${Date.now()}`, 0);
const reportPath = join(fixture.root, 'ime-result.json'), driverPath = join(fixture.root, 'ime-driver.json');

async function protectedState() {
  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  let state, resources;
  try {
    state = JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload);
    resources = db.prepare('SELECT * FROM resource_catalog ORDER BY id').all();
  } finally { db.close(); }
  const files = [];
  for (let index = 0; index < fixture.skillCount; index++) {
    const path = join(fixture.skillsRoot, `perf-skill-${String(index).padStart(4, '0')}`, 'SKILL.md');
    assert.equal((await realpath(path)).toLowerCase(), path.toLowerCase());
    files.push({ path, sha256: hash(await readFile(path)) });
  }
  return { state, resources, files };
}

const before = await protectedState();
const report = {
  format: 'agent-resource-manager-physical-ime-v1', status: 'pending', syntheticOnly: true,
  fixture: fixture.root, executable, executableSha256, transportSha256, sourceIdentity: build.sourceIdentity || build.sourceCommit,
  harnessSha256: hash(harnessSource), clientSha256: hash(clientSource), startedAt: new Date().toISOString(),
  input: { field: '搜索 Skill', physicalKeys: 'ceshi Space', expectedValue: '测试', requiredLanguageId: '0x0804', clipboardUsed: false, unicodeInputUsed: false },
  prepareChineseImeRequested: prepareChineseIme,
  observeChineseImeRequested: observeChineseIme, modeToggleKey,
  imeCompositionVerified: false, normalExit: false, originalStatePreserved: false,
  limitations: [observeChineseIme
    ? 'The exact owned search field must already show a stable explicit Chinese taskbar mode. No mode-switch key is sent. Physical ceshi plus Space must commit 测试, the isolated field must be cleared, and the original taskbar mode must remain Chinese. Unreadable IMM flags remain unverified.'
    : prepareChineseIme
    ? `One existing Simplified Chinese layout. Readable IMM restoration verifies its original flags. A unique explicit taskbar mode can support guarded ${modeToggleKey} preparation and restoration while IMM flags remain unknown. Unknown taskbar status keeps natural-mode probing. Actual conversion, observed taskbar restoration and complete IMM state are reported separately. The isolated field is cleared under the same focus and layout guards.`
    : 'One existing Simplified Chinese keyboard layout and its current mode only. No input-method changes, candidate selection, Unicode injection or clipboard input.'],
};

function validateImeModeToggle(ime, expectedKey) {
  assert.equal(ime.modeToggleKey, expectedKey);
  assert.ok(['shift', 'ctrl'].includes(ime.modeToggleKey));
  for (const field of ['modeToggleAttempted', 'modeToggleSent', 'modeRestorationToggleSent', 'taskbarRestoreToggleSent']) assert.equal(typeof ime[field], 'boolean');
  assert.equal(ime.modeShiftAttempted, ime.modeToggleAttempted && expectedKey === 'shift');
  assert.equal(ime.modeShiftSent, ime.modeToggleSent && expectedKey === 'shift');
  assert.equal(ime.taskbarRestoreShiftSent, ime.taskbarRestoreToggleSent && expectedKey === 'shift');
  assert.ok(!ime.modeToggleSent || ime.modeToggleAttempted);
  assert.ok(!ime.modeRestorationToggleSent || ime.modeRestorationAttempted);
  assert.ok(!ime.taskbarRestoreToggleSent || ime.modeRestorationToggleSent);
  if (ime.status !== 'failed-or-blocked') assert.equal(ime.modeRestorationToggleSent, ime.modeRestorationAttempted);
}

function validateObservedChineseIme(ime) {
  assert.equal(ime.observeChineseImeRequested, true);
  assert.equal(ime.prepareChineseImeRequested, false);
  for (const field of ['modeToggleAttempted', 'modeToggleSent', 'modeShiftAttempted', 'modeShiftSent', 'modeRestorationRequired', 'modeRestorationAttempted', 'modeRestorationToggleSent', 'taskbarRestoreToggleSent', 'taskbarRestoreShiftSent', 'taskbarModePreparation', 'naturalModeProbe']) assert.equal(ime[field], false, `Observe-only IME must not switch modes: ${field}`);
  if (ime.status.startsWith('not-verified-')) {
    assert.ok(['not-verified-current-layout-not-simplified-chinese', 'not-verified-existing-ime-not-native', 'not-verified-current-ime-mode-unavailable', 'not-verified-existing-taskbar-not-chinese'].includes(ime.status));
    for (const field of ['textKeysAttempted', 'spaceAttempted', 'textKeysSent', 'spaceSent', 'taskbarChineseModeObservation']) assert.equal(ime[field], false);
    assert.equal(ime.taskbarChineseModePreserved, null);
    return;
  }
  assert.equal(ime.status, 'physical-ime-conversion-verified');
  assert.equal(ime.taskbarChineseModeObservation, true);
  assert.equal(ime.taskbarChineseModePreserved, true);
  assert.equal(ime.taskbarInputStopped, false);
  assert.equal(ime.modeEvidenceSource, 'taskbar-chinese-observation-only');
  const original = ime.taskbarModeBefore, context = ime.modeBefore;
  assert.ok(Number.isInteger(original.ownerPid) && original.ownerPid > 0);
  assert.ok(typeof original.ownerCreationFileTime === 'string' && /^\d+$/.test(original.ownerCreationFileTime) && BigInt(original.ownerCreationFileTime) > 0n);
  assert.ok(Number.isInteger(original.taskbarWindowHandle) && original.taskbarWindowHandle !== 0);
  assert.ok(Array.isArray(original.runtimeId) && original.runtimeId.length > 0 && original.runtimeId.every(Number.isInteger));
  assert.ok(Number.isInteger(context.focusWindowHandle) && context.focusWindowHandle !== 0);
  assert.ok(Number.isInteger(context.focusThread) && context.focusThread > 0);
  assert.ok(Number.isInteger(context.focusPid) && context.focusPid > 0);
  assert.match(context.hkl, /^0x[\dA-F]{12}0804$/);
  const sameFocus = observation => {
    for (const field of ['focusWindowHandle', 'focusThread', 'focusPid', 'hkl']) assert.equal(observation[field], context[field]);
  };
  for (const observation of [ime.taskbarModeInitialObservation, original, ime.taskbarModeAfterObservation]) {
    assert.equal(observation.source, 'taskbar-input-mode-indicator');
    assert.equal(observation.known, true); assert.equal(observation.mode, 'chinese');
    assert.equal(observation.name.split(/\r?\n/)[0], '任务栏输入指示 中文模式');
    assert.equal(observation.name, original.name);
    assert.equal(observation.ownerPid, original.ownerPid); assert.equal(observation.indicatorPid, original.ownerPid);
    assert.equal(observation.ownerCreationFileTime, original.ownerCreationFileTime);
    assert.equal(observation.taskbarWindowHandle, original.taskbarWindowHandle);
    assert.deepEqual(observation.runtimeId, original.runtimeId);
    sameFocus(observation.focusBefore); sameFocus(observation.focusAfter);
  }
  sameFocus(ime.modeAfterObservation);
  assert.ok(ime.modeAfterObservation.known === true ? ime.modeAfterObservation.native === true : ime.modeAfterObservation.known === false && ime.modeAfterObservation.modeApiUnavailable === true);
  if (context.known === true) {
    assert.equal(context.native, true);
    for (const field of ['contextAvailable', 'conversionRead', 'contextReleased', 'open']) assert.equal(context[field], true);
    assert.ok(Number.isInteger(context.conversion) && (context.conversion & 1) !== 0);
    assert.ok(Number.isInteger(context.sentence));
    for (const field of ['known', 'contextAvailable', 'conversionRead', 'contextReleased', 'open', 'conversion', 'sentence', 'native']) assert.equal(ime.modeAfterObservation[field], context[field]);
    assert.equal(ime.modeRestorationVerified, true);
    assert.equal(ime.modeRestorationStatus, 'original-taskbar-chinese-and-imm-unchanged');
  } else {
    assert.equal(context.known, false); assert.equal(context.modeApiUnavailable, true);
    assert.equal(context.conversion, null); assert.equal(context.sentence, null); assert.equal(context.native, null);
    assert.equal(ime.modeRestorationVerified, null, 'Unreadable IMM flags remain unverified.');
    assert.equal(ime.modeRestorationStatus, 'original-taskbar-chinese-preserved-imm-flags-unknown');
  }
}

let app;
try {
  app = await NativeUiaSession.launch({ executable, sha256: executableSha256, transportSha256, pinnedTransports, dataDir: fixture.dataDir, reportPath: driverPath, accessibilityInput: true, keyboardInput: true });
  assert.equal(app.identity.executableSha256, executableSha256);
  assert.equal(resolve(app.identity.dataDirectory).toLowerCase(), resolve(fixture.dataDir).toLowerCase());
  if (options['await-foreground'] === 'true') {
    console.log(JSON.stringify({ phase: 'await-owned-ime-foreground', ...app.identity, timeoutMs: 60000 }));
    const deadline = Date.now() + 60000;
    while (!ownedForeground(await app.call('windowIdentity'), app.identity)) {
      assert.ok(Date.now() < deadline, 'The exact IME test window was not observed in the foreground within sixty seconds. No input was sent.');
      await new Promise(done => setTimeout(done, 250));
    }
  }
  report.preparation = await app.call('prepareKeyboardForeground');
  report.ime = await app.call('keyboardIme', { name: '搜索 Skill', prepareChineseIme, observeChineseIme, modeToggleKey }, prepareChineseIme ? 40000 : 20000);
  assert.equal(report.ime.prepareChineseImeRequested, prepareChineseIme);
  assert.equal(report.ime.observeChineseImeRequested, observeChineseIme);
  validateImeModeToggle(report.ime, modeToggleKey);
  if (observeChineseIme) validateObservedChineseIme(report.ime);
  if (report.ime.naturalModeProbe === true) {
    assert.equal(prepareChineseIme, true);
    assert.equal(report.ime.modeBefore.known, false);
    assert.equal(report.ime.modeBefore.modeApiUnavailable, true);
    assert.equal(report.ime.modeShiftAttempted, false); assert.equal(report.ime.modeShiftSent, false);
    assert.equal(report.ime.modeRestorationRequired, false); assert.equal(report.ime.modeRestorationAttempted, false);
    assert.equal(report.ime.modeRestorationVerified, null);
    assert.equal(report.ime.modeRestorationStatus, 'not-required-no-mode-switch-api-unavailable');
  } else if (prepareChineseIme && report.ime.modeBefore?.known === true) {
    assert.equal(report.ime.modeRestorationVerified, true, 'The original readable IME mode must be queried and verified after the attempt.');
  }
  if (report.ime.taskbarModePreparation === true) {
    assert.equal(prepareChineseIme, true);
    assert.equal(report.ime.naturalModeProbe, false);
    assert.equal(report.ime.modeBefore.known, false);
    assert.equal(report.ime.modeBefore.modeApiUnavailable, true);
    assert.equal(report.ime.modeEvidenceSource, 'taskbar-input-mode-indicator');
    assert.equal(report.ime.modeBefore.conversion, null); assert.equal(report.ime.modeBefore.sentence, null);
    assert.equal(report.ime.modeBefore.native, null);
    assert.equal(report.ime.modeRestorationVerified, null, 'Complete IMM flags remain unknown.');
    const selectedModeKey = report.ime.modeToggleKey;
    assert.ok(['shift', 'ctrl'].includes(selectedModeKey));
    assert.equal(report.ime.modeShiftAttempted, selectedModeKey === 'shift'); assert.equal(report.ime.modeShiftSent, selectedModeKey === 'shift');
    assert.equal(report.ime.modeToggleAttempted, true); assert.equal(report.ime.modeToggleSent, true);
    assert.equal(report.ime.modeRestorationRequired, true);
    assert.equal(report.ime.taskbarInputStopped, false);
    assert.equal(typeof report.ime.modeRestorationAttempted, 'boolean');
    assert.equal(report.ime.taskbarRestoreToggleSent, report.ime.modeRestorationAttempted);
    assert.equal(report.ime.taskbarRestoreShiftSent, report.ime.modeRestorationAttempted && selectedModeKey === 'shift');
    assert.equal(report.ime.taskbarModeRestorationVerified, true);
    assert.equal(report.ime.modeRestorationStatus, 'original-taskbar-english-verified-imm-flags-unknown');
    const original = report.ime.taskbarModeBefore;
    assert.equal(original.mode, 'english');
    assert.ok(Number.isInteger(original.ownerPid) && original.ownerPid > 0);
    assert.ok(typeof original.ownerCreationFileTime === 'string' && BigInt(original.ownerCreationFileTime) > 0n);
    assert.ok(Number.isInteger(original.taskbarWindowHandle) && original.taskbarWindowHandle !== 0);
    assert.ok(Array.isArray(original.runtimeId) && original.runtimeId.length > 0);
    assert.ok(original.runtimeId.every(Number.isInteger));
    const observations = [report.ime.taskbarModeInitialObservation, original, report.ime.taskbarModeAfterPreparation, report.ime.taskbarModeBeforeRestoration, report.ime.taskbarModeAfterRestoration];
    for (const observation of observations) {
      assert.equal(observation.source, 'taskbar-input-mode-indicator');
      assert.equal(observation.known, true);
      assert.equal(observation.ownerPid, original.ownerPid);
      assert.equal(observation.indicatorPid, original.ownerPid);
      assert.equal(observation.ownerCreationFileTime, original.ownerCreationFileTime);
      assert.equal(observation.taskbarWindowHandle, original.taskbarWindowHandle);
      assert.deepEqual(observation.runtimeId, original.runtimeId);
      assert.equal(observation.name.split(/\r?\n/)[0], `任务栏输入指示 ${observation.mode === 'english' ? '英语模式' : '中文模式'}`);
      assert.ok(['english', 'chinese'].includes(observation.mode));
      for (const context of [observation.focusBefore, observation.focusAfter]) {
        assert.equal(context.focusWindowHandle, report.ime.modeBefore.focusWindowHandle);
        assert.equal(context.focusThread, report.ime.modeBefore.focusThread);
        assert.equal(context.focusPid, report.ime.modeBefore.focusPid);
        assert.equal(context.hkl, report.ime.modeBefore.hkl);
      }
    }
    assert.equal(report.ime.taskbarModeAfterRestoration.mode, 'english');
    assert.equal(report.ime.taskbarModeAfterRestoration.name, original.name);
    assert.equal(report.ime.taskbarModeInitialObservation.mode, 'english');
    assert.equal(report.ime.taskbarModeInitialObservation.name, original.name);
    if (report.ime.taskbarModeBeforeRestoration.mode === 'chinese') assert.equal(report.ime.modeRestorationAttempted, true);
    if (report.ime.status === 'physical-ime-conversion-verified') assert.equal(report.ime.taskbarModeAfterPreparation.mode, 'chinese');
    if (report.ime.taskbarModeAfterPreparation.mode === 'english') {
      assert.equal(report.ime.status, 'not-verified-taskbar-mode-not-prepared');
      assert.equal(report.ime.modeRestorationAttempted, false);
      assert.equal(report.ime.taskbarModeBeforeRestoration.mode, 'english');
    }
  }
  if (report.ime.textKeysAttempted === true) {
    assert.equal(report.ime.fieldCleanupAttempted, true); assert.equal(report.ime.fieldCleared, true);
    assert.equal(report.ime.afterCleanupValue, '');
    assert.equal(report.ime.layoutPreserved, true); assert.equal(report.ime.focusPreserved, true);
  }
  if (report.ime.status.startsWith('not-verified-')) {
    if (report.ime.status === 'not-verified-existing-mode-did-not-convert') {
      assert.equal(report.ime.naturalModeProbe, true);
      assert.equal(report.ime.textKeysAttempted, true); assert.equal(report.ime.spaceAttempted, true);
      assert.equal(report.ime.textKeysSent, true); assert.equal(report.ime.spaceSent, true);
      assert.notEqual(report.ime.afterValue, '测试'); assert.equal(report.ime.imeCompositionVerified, false);
    } else {
      assert.equal(report.ime.textKeysAttempted, false); assert.equal(report.ime.spaceAttempted, false);
      assert.equal(report.ime.textKeysSent, false); assert.equal(report.ime.spaceSent, false);
    }
    report.status = report.ime.status;
  } else {
    assert.equal(report.ime.status, 'physical-ime-conversion-verified');
    assert.equal(report.ime.textKeysAttempted, true); assert.equal(report.ime.spaceAttempted, true);
    assert.equal(report.ime.textKeysSent, true); assert.equal(report.ime.spaceSent, true);
    assert.equal(report.ime.languageId, 0x0804);
    assert.equal(report.ime.beforeValue, '');
    assert.equal(report.ime.afterValue, '测试');
    assert.equal(report.ime.method, 'guarded-fixed-SendInput-VK-ceshi-Space');
    assert.equal(report.ime.unicodeInputUsed, false); assert.equal(report.ime.clipboardUsed, false);
    assert.equal(report.ime.imeCompositionVerified, true);
    if (prepareChineseIme && report.ime.naturalModeProbe !== true && report.ime.taskbarModePreparation !== true) assert.equal(report.ime.modeRestorationVerified, true, 'The original IME mode must be queried and verified after any temporary preparation.');
    report.imeCompositionVerified = true; report.status = 'physical-ime-conversion-passed';
  }
} catch (error) { report.status = 'failed-or-blocked'; report.error = error.message; }
finally {
  if (app) {
    try { await app.quit(); } catch (error) { report.normalExitError = error.message; }
    try {
      report.nativeDriver = JSON.parse(await readFile(driverPath, 'utf8'));
      report.normalExit = report.nativeDriver.closedNormally === true;
      if (!report.ime && report.nativeDriver.keyboardIme) report.ime = report.nativeDriver.keyboardIme;
    }
    catch (error) { report.driverReadError = error.message; }
  }
  try { assert.deepEqual(await protectedState(), before); report.originalStatePreserved = true; }
  catch (error) { report.originalStateError = error.message; report.status = 'failed-or-blocked'; }
  report.finishedAt = new Date().toISOString();
  if (!report.normalExit) report.status = 'failed-or-blocked';
  await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
}
console.log(JSON.stringify({ status: report.status, report: reportPath, imeCompositionVerified: report.imeCompositionVerified, normalExit: report.normalExit, originalStatePreserved: report.originalStatePreserved }));
if (report.status !== 'physical-ime-conversion-passed' || !report.imeCompositionVerified || !report.normalExit || !report.originalStatePreserved) process.exitCode = 1;
