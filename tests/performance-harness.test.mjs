import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PERFORMANCE_POLICY as policy, ownedForeground, percentile, startupComparison, localInteractionVerdict, backgroundLoadVerdict, freezeConvergenceBounds, stabilityVerdict } from '../scripts/performance-policy.mjs';

test('CDP memory diagnostics require an explicit read-only observer option before any native launch', () => {
  const path = fileURLToPath(new URL('../scripts/verify-native-cdp-memory.mjs', import.meta.url));
  const source = readFileSync(path, 'utf8');
  assert.match(source, /import \{ assertNoUserManager \} from '\.\/native-uia-client\.mjs'/);
  assert.match(source, /\['verify-native-cdp-memory\.mjs', 'native-uia-client\.mjs', 'performance-fixture\.mjs'\]/);
  assert.match(source, /report\.launchPreflight = \{ \.\.\.await assertNoUserManager\(\), checkedAtUtc: new Date\(\)\.toISOString\(\) \};\s+child = spawn\(executable/);
  for (const options of [[], ['--uia-observer', 'read-only'], ['--uia-observer', 'read-only-detach']]) {
    const result = spawnSync(process.execPath, [path, '--help', ...options], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /UIA is disabled by default/);
    assert.match(result.stdout, /CDP remains the sole action driver/);
  }
  for (const options of [['--uia-observer'], ['--uia-observer', 'true'], ['--uia-observer', 'false'], ['--uia-observer', 'input'], ['--uia-observer', 'read-only-detach-input']]) {
    const result = spawnSync(process.execPath, [path, '--help', ...options], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /UIA observation requires explicit --uia-observer read-only/);
  }
});

test('observer detachment clears the live handle before waiting and never repeats close on success or failure', async () => {
  const source = readFileSync(new URL('../scripts/verify-native-cdp-memory.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function closeUiaObserver(reason) {');
  const end = source.indexOf('\nasync function processes(', start);
  assert.ok(start >= 0 && end > start);
  const createHarness = new Function('assert', 'performance', 'observer', `let uiaObserver=observer; const report={uiaObserver:{}}; ${source.slice(start, end)}; return {close:closeUiaObserver,current:()=>uiaObserver,report};`);
  for (const failing of [false, true]) {
    let calls = 0, unrefs = 0, harness;
    const unref = () => { unrefs++; };
    const observer = { process: { unref, stdin: { unref }, stdout: { unref }, stderr: { unref } }, close: async () => {
      calls++; assert.equal(harness.current(), null, 'No observer-memory call can use the closing handle.');
      if (failing) throw new Error('fixture observer exit failure');
      return { code: 0, signal: null };
    } };
    harness = createHarness(assert, performance, observer);
    if (failing) {
      await assert.rejects(harness.close('fixture-detach'), /fixture observer exit failure/);
      assert.equal(harness.report.uiaObserver.closedNormally, false);
      assert.equal(harness.report.uiaObserver.processRequiresAttention, true);
      assert.equal(unrefs, 4);
    } else {
      assert.ok(Number.isFinite(await harness.close('fixture-detach')));
      assert.equal(harness.report.uiaObserver.closedNormally, true);
      assert.deepEqual(harness.report.uiaObserver.exit, { code: 0, signal: null });
      assert.equal(unrefs, 0);
    }
    assert.equal(harness.current(), null);
    await assert.rejects(harness.close('fixture-repeated-close'), /must exist before closing/);
    assert.equal(calls, 1);
  }
});

test('the attached UIA observer has no input APIs and rejects an invalid owner before reading any window', { skip: process.platform !== 'win32' }, () => {
  const source = readFileSync(new URL('../scripts/verify-native-cdp-memory.mjs', import.meta.url), 'utf8');
  const script = source.match(/const attachedUiaScript = String\.raw`([\s\S]*?)`;/)?.[1];
  assert.ok(script, 'The exact embedded observer script must be available for review.');
  const encoded = Buffer.from(script).toString('base64');
  const command = `$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors);if($errors.Count){throw ($errors.Message -join '; ')};[pscustomobject]@{commands=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.CommandAst]},$true)|ForEach-Object {$_.GetCommandName()});members=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.InvokeMemberExpressionAst]},$true)|ForEach-Object {$_.Member.Value})}|ConvertTo-Json -Compress`;
  const parsed = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(parsed.status, 0, parsed.stderr);
  const ast = JSON.parse(parsed.stdout.trim());
  const allowed = new Set(['Add-Type', 'Get-Process', 'Read-OwnedProcess', 'Read-OwnedRoot', 'Read-ObserverMemory', 'Read-ElementSummary', 'Find-Named', 'Read-NavigationState', 'ConvertFrom-Json', 'ConvertTo-Json', 'Start-Sleep']);
  for (const name of ast.commands) assert.ok(allowed.has(name), `Unexpected observer command ${name}`);
  const forbidden = new Set(['SetFocus', 'SetValue', 'Select', 'Expand', 'Collapse', 'Invoke', 'Toggle', 'SendInput', 'SetForegroundWindow', 'Start', 'Kill', 'Collect', 'WaitForPendingFinalizers']);
  for (const name of ast.members) assert.ok(!forbidden.has(name), `Read-only observation cannot call ${name}`);
  assert.match(script, /StartTime\.ToUniversalTime\(\)\.ToFileTimeUtc\(\)\.ToString\(\) -cne \$taskOwner\.creationFileTime/);
  assert.match(script, /\$taskProcess\.MainWindowHandle -ne \$taskWindow/);
  assert.match(script, /\$taskRoot\.Current\.ProcessId -ne \$taskOwner\.pid/);
  assert.match(script, /Find-Named \$root 'Skill 详情' \(\[System\.Windows\.Automation\.ControlType\]::Tab\)/);
  assert.match(script, /Find-Named \$root '工作区标签' \(\[System\.Windows\.Automation\.ControlType\]::Tab\)/);
  assert.match(script, /Find-Named \$workspaceTabs 'Perf Skill 0000' \(\[System\.Windows\.Automation\.ControlType\]::TabItem\)/);
  assert.match(script, /\$matched=\$resourceSelected -and \$selected -and \$null -ne \$paragraph/);
  assert.match(script, /headingPropertySupported=\[bool\]\$supported/);
  assert.doesNotMatch(script, /80052/);
  assert.match(script, /\$taskElements\.Count -gt 1/);
  const invalidAttachment = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-MTA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
    input: JSON.stringify({ id: 42, op: 'attach', pid: 0, creationFileTime: '1', executable: 'D:\\invalid-observer-fixture.exe' }) + '\n',
  });
  assert.equal(invalidAttachment.status, 1, invalidAttachment.stderr);
  const rejected = JSON.parse(invalidAttachment.stdout.trim());
  assert.equal(rejected.id, 42);
  assert.match(rejected.error, /exact existing manager identity/);
});

test('measured foreground requires the exact launched PID and captured, main and foreground window', () => {
  const expected = { pid: 42, windowHandle: 1001 };
  const identity = { capturedHandle: 1001, currentMainHandle: 1001, uiaProcessId: 42, foregroundHandle: 1001 };
  assert.equal(ownedForeground(identity, expected), true);
  assert.equal(ownedForeground(null, expected), false);
  assert.equal(ownedForeground(identity, undefined), false);
  assert.equal(ownedForeground({}, expected), false);
  for (const [key, foreignValue] of Object.entries({ capturedHandle: 1002, currentMainHandle: 1002, uiaProcessId: 43, foregroundHandle: 1002 })) {
    assert.equal(ownedForeground({ ...identity, [key]: foreignValue }, expected), false, `${key} must match the launched identity`);
    const missing = { ...identity }; delete missing[key];
    assert.equal(ownedForeground(missing, expected), false, `${key} must be present`);
  }
  assert.equal(ownedForeground({ capturedHandle: 1002, currentMainHandle: 1002, uiaProcessId: 43, foregroundHandle: 1002 }, expected), false);
  for (const invalid of [undefined, null, 0, -1, NaN, Infinity, '1001']) {
    assert.equal(ownedForeground(identity, { ...expected, windowHandle: invalid }), false);
    assert.equal(ownedForeground(identity, { ...expected, pid: invalid }), false);
  }
});

test('startup compares ten native samples using the larger of ten percent and one hundred milliseconds', () => {
  assert.equal(startupComparison(Array(9).fill(2000), Array(10).fill(2000)).status, 'incomplete');
  assert.equal(startupComparison(Array(10).fill(2000), Array(10).fill(2200)).status, 'passed');
  assert.equal(startupComparison(Array(10).fill(2000), Array(10).fill(2201)).status, 'failed');
  assert.equal(startupComparison(Array(10).fill(500), Array(10).fill(600)).status, 'passed');
  assert.equal(startupComparison(Array(10).fill(500), Array(10).fill(601)).status, 'failed');
  assert.equal(startupComparison(Array(10).fill(NaN), Array(10).fill(1)).status, 'invalid');
});

test('background coverage requires native task overlap, matching process and every real UI category', () => {
  const records = Object.entries({ check: 'check_now', download: 'apply_resource_download', update: 'apply_resource_update_stage' }).flatMap(([kind, taskAction]) => ['search', 'filter', 'tab', 'document'].map(category => ({ kind, taskAction, taskId: `${kind}-observed-native`, beforeStatus: 'running', afterStatus: 'running', beforeObservedAtMs: 100, afterObservedAtMs: 300, sample: { category, pid: 42, condition: 'native-ui-input-to-painted-result', durationMs: 120, startedAtUtcMs: 150, finishedAtUtcMs: 270 } })));
  assert.equal(backgroundLoadVerdict(records, 42).update.status, 'passed');
  assert.equal(backgroundLoadVerdict(records, 43).update.status, 'incomplete');
  assert.equal(backgroundLoadVerdict(records.map(record => ({ ...record, beforeStatus: 'succeeded', afterStatus: 'succeeded' })), 42).download.status, 'incomplete');
  assert.equal(backgroundLoadVerdict(records.filter(record => record.sample.category !== 'document'), 42).check.status, 'incomplete');
  assert.equal(backgroundLoadVerdict(records.map(record => ({ ...record, afterStatus: 'succeeded', taskFinishedAt: new Date(140).toISOString() })), 42).update.status, 'incomplete');
  const slow = records.map(record => ({ ...record, sample: { ...record.sample, durationMs: 201 } }));
  assert.equal(backgroundLoadVerdict(slow, 42).download.status, 'failed');
  assert.equal(backgroundLoadVerdict(slow, 42).download.overLimitInputs, 4);
  const missingTiming = records.map(record => ({ ...record, sample: { ...record.sample, durationMs: undefined } }));
  assert.equal(backgroundLoadVerdict(missingTiming, 42).update.status, 'invalid');
  const negativeTiming = records.map(record => ({ ...record, sample: { ...record.sample, durationMs: -1 } }));
  assert.equal(backgroundLoadVerdict(negativeTiming, 42).check.status, 'invalid');
});

test('interaction P95 requires one hundred actual input-to-painted samples for every critical category', () => {
  const samples = ['search', 'filter', 'tab', 'document'].flatMap(category => Array.from({ length: 100 }, (_, index) => ({ category, condition: 'native-ui-input-to-painted-result', durationMs: index < 94 ? 20 : 201 })));
  const verdict = localInteractionVerdict(samples);
  assert(Object.values(verdict).every(value => value.status === 'failed' && value.p95Ms === 201));
  assert.equal(localInteractionVerdict(samples.slice(1)).search.status, 'incomplete');
  assert.equal(localInteractionVerdict(samples.map(value => ({ ...value, condition: 'task-finished' }))).tab.status, 'incomplete', 'task timing cannot substitute for UI input and paint');
  assert.equal(percentile([100, 0, 20, 30], .5), 20);
});

const cache = { bytes: 1000, limitBytes: policy.contentCacheLimitBytes };
const idle = Array.from({ length: 11 }, (_, index) => ({ privateBytes: 100 * 1048576 + (index % 2) * 1024, idleCpuPercent: .1 }));
const bounds = freezeConvergenceBounds(idle);
const stable = () => Array.from({ length: 61 }, (_, index) => ({ elapsedMs: index * 30000, privateBytes: 120 * 1048576 + (index % 2) * 1024, idleCpuPercent: .1, cache }));

test('stability requires the predetermined warmup, thirty-minute series and native cache observations', () => {
  assert.equal(stabilityVerdict(stable(), bounds, 5).status, 'passed');
  assert.equal(stabilityVerdict(stable(), bounds, 4).status, 'incomplete');
  assert.equal(stabilityVerdict(stable().slice(0, 60), bounds, 5).status, 'incomplete');
  assert.equal(stabilityVerdict(stable().map(value => ({ ...value, cache: null })), bounds, 5).status, 'incomplete');
  assert.equal(stabilityVerdict(stable(), null, 5).status, 'incomplete');
  assert.throws(() => freezeConvergenceBounds(idle.slice(1)), /Idle calibration/);
  const missing = stable(); missing[30].elapsedMs += 16000;
  assert.equal(stabilityVerdict(missing, bounds, 5).status, 'incomplete');
});

test('continuing growth, idle busy loops and content-cache overflow fail rather than loosening limits after measurement', () => {
  const growing = stable().map((sample, index) => ({ ...sample, privateBytes: sample.privateBytes + index * 1048576 }));
  assert.equal(stabilityVerdict(growing, bounds, 5).status, 'failed');
  const busy = stable().map(sample => ({ ...sample, idleCpuPercent: bounds.idleCpuLimitPercent + 1 }));
  assert.equal(stabilityVerdict(busy, bounds, 5).status, 'failed');
  const overflowing = stable(); overflowing[3] = { ...overflowing[3], cache: { ...cache, bytes: policy.contentCacheLimitBytes + 1 } };
  assert.equal(stabilityVerdict(overflowing, bounds, 5).status, 'failed');
  const highTotalMemory = stable().map(sample => ({ ...sample, privateBytes: 900 * 1048576 }));
  assert.equal(stabilityVerdict(highTotalMemory, bounds, 5).status, 'passed', '64 MiB bounds content reuse, not the entire native application');
});


test('native accessibility timing is selected explicitly and never mixes input methods', () => {
  const accessible = Array.from({length:100},()=>({category:'search',condition:'native-accessibility-input-to-painted-result',durationMs:150}));
  assert.equal(localInteractionVerdict(accessible).search.count,0);
  assert.equal(localInteractionVerdict(accessible,'native-accessibility-input-to-painted-result').search.status,'passed');
  assert.equal(localInteractionVerdict(accessible.slice(0,99),'native-accessibility-input-to-painted-result').search.status,'incomplete');
  assert.equal(localInteractionVerdict(accessible.map(x=>({...x,durationMs:201})),'native-accessibility-input-to-painted-result').search.status,'failed');
  assert.throws(()=>localInteractionVerdict(accessible,'backend-only'));
});

const nativeSamples = values => values.map(durationMs => ({ category: 'search', condition: 'native-ui-input-to-painted-result', durationMs }));

test('limited delay tolerance preserves the strict target and requires one hundred samples per category', () => {
  const smallDelays = nativeSamples([...Array(94).fill(120), ...Array(6).fill(450)]);
  const verdict = localInteractionVerdict(smallDelays);
  assert.equal(verdict.search.status, 'failed', 'the original 200 ms target remains separately visible');
  assert.equal(verdict.search.limitedTolerance.status, 'passed');
  assert.equal(verdict.search.limitedTolerance.p95Ms, 450);
  assert.equal(verdict.search.limitedTolerance.maximumObservedMs, 450);
  assert.equal(verdict.search.limitedTolerance.aboveTargetFraction, .06);
  assert.equal(verdict.search.limitedTolerance.aboveToleranceFraction, 0);
  assert.equal(verdict.document.limitedTolerance.status, 'incomplete');
  const short = localInteractionVerdict(smallDelays.slice(1)).search.limitedTolerance;
  assert.equal(short.status, 'incomplete');
  assert.equal(short.p95Ms, null, 'a short series does not claim the required P95');
  assert.equal(short.count, 99);
  assert.equal(short.minimumSamples, 100);
  const wrongMethod = smallDelays.map(sample => ({ ...sample, condition: 'native-accessibility-input-to-painted-result' }));
  assert.equal(localInteractionVerdict(wrongMethod).search.limitedTolerance.status, 'incomplete');
  assert.equal(localInteractionVerdict(wrongMethod, 'native-accessibility-input-to-painted-result').search.limitedTolerance.status, 'passed');
});

test('limited delay tolerance enforces the 500 ms P95 and five-percent slow-input boundary', () => {
  assert.equal(localInteractionVerdict(nativeSamples(Array(100).fill(500))).search.limitedTolerance.status, 'passed');
  assert.equal(localInteractionVerdict(nativeSamples(Array(100).fill(501))).search.limitedTolerance.status, 'failed');
  const acceptedTail = localInteractionVerdict(nativeSamples([...Array(95).fill(500), ...Array(5).fill(999)])).search.limitedTolerance;
  assert.equal(acceptedTail.status, 'passed');
  assert.equal(acceptedTail.p95Ms, 500);
  assert.equal(acceptedTail.aboveToleranceFraction, .05);
  const frequentTail = localInteractionVerdict(nativeSamples([...Array(94).fill(500), ...Array(6).fill(501)])).search.limitedTolerance;
  assert.equal(frequentTail.status, 'failed');
  assert.equal(frequentTail.aboveToleranceFraction, .06);
});

test('one-second blocking and two-second delay fail even when hidden by a fast P95 or short series', () => {
  for (const durationMs of [1000, 2000]) {
    const verdict = localInteractionVerdict(nativeSamples([...Array(99).fill(120), durationMs])).search;
    assert.equal(verdict.status, 'passed', 'the historical P95 target result is not silently rewritten');
    assert.equal(verdict.limitedTolerance.status, 'failed');
    assert.equal(verdict.limitedTolerance.maximumObservedMs, durationMs);
    assert.equal(localInteractionVerdict(nativeSamples([durationMs])).search.limitedTolerance.status, 'failed', 'an observed long block must not be hidden by insufficient samples');
  }
  for (const durationMs of [NaN, -1]) {
    assert.equal(localInteractionVerdict(nativeSamples([...Array(99).fill(120), durationMs])).search.limitedTolerance.status, 'invalid');
  }
});

test('background tolerance keeps overlap and complete-category evidence separate from statistical acceptance', () => {
  const record = (category, durationMs) => ({ kind: 'download', taskAction: 'apply_resource_download', taskId: 'actual-native-download', beforeStatus: 'running', afterStatus: 'running', beforeObservedAtMs: 100, afterObservedAtMs: 1000, sample: { category, pid: 42, condition: 'native-ui-input-to-painted-result', durationMs, startedAtUtcMs: 150, finishedAtUtcMs: 150 + durationMs } });
  const smoke = ['search', 'filter', 'tab', 'document'].map(category => record(category, 450));
  const smokeVerdict = backgroundLoadVerdict(smoke, 42).download;
  assert.equal(smokeVerdict.status, 'failed');
  assert.equal(smokeVerdict.limitedTolerance.status, 'incomplete');
  assert.equal(smokeVerdict.limitedTolerance.categories.document.p95Ms, null);
  const complete = smoke.flatMap(value => Array.from({ length: 100 }, () => value));
  assert.equal(backgroundLoadVerdict(complete, 42).download.limitedTolerance.status, 'passed');
  assert.equal(backgroundLoadVerdict(complete, 43).download.limitedTolerance.status, 'incomplete');
  assert.equal(backgroundLoadVerdict(complete.filter(value => value.sample.category !== 'document'), 42).download.limitedTolerance.status, 'incomplete');
  assert.equal(backgroundLoadVerdict(complete.map(value => ({ ...value, afterStatus: 'succeeded', taskFinishedAt: new Date(140).toISOString() })), 42).download.limitedTolerance.status, 'incomplete');
  const blocked = record('document', 2000); blocked.afterObservedAtMs = 3000;
  assert.equal(backgroundLoadVerdict([...smoke, blocked], 42).download.limitedTolerance.status, 'failed');
});

const strictIdentity = { pid: 42, windowHandle: 42_001, creationFileTime: '134399999999999999' };
const strictCondition = 'native-ui-input-to-painted-result';
const sampledRecord = (category, index, durationMs = 120) => {
  const start = 1_790_000_000_000 + 2000 * index, finish = start + durationMs;
  return { kind: 'update', taskId: 'native-stage-1', taskAction: 'apply_resource_update_stage',
    beforeStatus: 'running', afterStatus: 'running', taskStartedAt: new Date(1_789_999_999_000).toISOString(),
    beforeObservedAtMs: start - 1, afterObservedAtMs: finish + 1,
    sample: { ...strictIdentity, category, condition: strictCondition, durationMs, foregroundBefore: true, foregroundAfter: true,
      startedAtUtcMs: start, finishedAtUtcMs: finish } };
};
const sampledScore = records => backgroundLoadVerdict(records, strictIdentity.pid, strictCondition, strictIdentity).update.sampledOverlap;

test('mixed-load P95 needs 100 distinct owned observations per category and keeps original and tolerance outcomes separate', () => {
  const categories = ['search', 'filter', 'tab', 'document'];
  const records = categories.flatMap((category, group) => Array.from({ length: 100 }, (_, index) =>
    sampledRecord(category, group * 100 + index, category === 'document' ? 220 : 120)));
  const complete = sampledScore(records);
  assert.equal(complete.acceptedInputs, 400);
  assert.equal(complete.status, 'failed');
  assert.equal(complete.categories.search.status, 'passed');
  assert.equal(complete.categories.search.p95Ms, 120);
  assert.equal(complete.categories.document.p95Ms, 220);
  assert.equal(complete.categories.document.limitedTolerance.status, 'passed');
  const copies = sampledScore(Array(100).fill(records[0]));
  assert.equal(copies.status, 'incomplete');
  assert.equal(copies.acceptedInputs, 1);
  assert.equal(copies.rejected['duplicate-or-unordered-input'], 99);
  assert.equal(copies.categories.search.p95Ms, null);
  assert.equal(sampledScore([sampledRecord('document', 0, 1000)]).categories.document.limitedTolerance.status, 'failed');
});

test('mixed-load samples require a started task enclosing paint, exact owned foreground, and non-overlapping inputs', () => {
  const entry = sampledRecord('search', 0);
  const end = entry.sample.finishedAtUtcMs, start = entry.sample.startedAtUtcMs;
  const duringFinish = { ...entry, afterStatus: 'succeeded', taskFinishedAt: new Date(end).toISOString() };
  assert.equal(sampledScore([duringFinish]).acceptedInputs, 1);
  const bestEffort = [
    { ...entry, beforeStatus: 'queued' },
    { ...entry, taskStartedAt: new Date(start + 1).toISOString() },
    { ...entry, taskStartedAt: '2026-09-01T00:00:00' },
    { ...duringFinish, taskFinishedAt: new Date(end - 1).toISOString() },
    { ...duringFinish, taskFinishedAt: new Date(end + 2).toISOString() },
    { ...entry, taskId: '' },
    { ...entry, afterStatus: 'running', taskFinishedAt: new Date(end).toISOString() },
    { ...entry, sample: { ...entry.sample, foregroundAfter: false } },
    { ...entry, sample: { ...entry.sample, pid: 43 } },
    { ...entry, sample: { ...entry.sample, windowHandle: 2 } },
    { ...entry, sample: { ...entry.sample, creationFileTime: '2' } },
    { ...entry, sample: { ...entry.sample, finishedAtUtcMs: start - 1 } },
    { ...entry, sample: { ...entry.sample, finishedAtUtcMs: NaN } },
  ];
  assert.equal(sampledScore(bestEffort).acceptedInputs, 0);
  const overlap = { ...entry, sample: { ...entry.sample, category: 'filter', startedAtUtcMs: start + 1, finishedAtUtcMs: end + 1 } };
  assert.equal(sampledScore([entry, overlap]).acceptedInputs, 1);
  assert.equal(sampledScore([entry, overlap]).rejected['duplicate-or-unordered-input'], 1);
  assert.equal(sampledScore([sampledRecord('tab', 3), entry]).rejected['duplicate-or-unordered-input'], 1);
  const invalid = { ...entry, sample: { ...entry.sample, durationMs: NaN } };
  assert.equal(sampledScore([invalid]).categories.search.limitedTolerance.status, 'invalid');
});
