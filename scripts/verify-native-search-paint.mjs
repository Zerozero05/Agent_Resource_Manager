import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertNoUserManager } from './native-uia-client.mjs';
import { VisualSession, inside, requiredStates, validateReferences, visualObserverSource } from './verify-native-visual-stability.mjs';

const source = '2d194880f48bbef0fe9613f3d2a5afffc3b2ce15';
const candidateRun = '44898573141';
const validation = 'D:/03_github_projects/Agent_Management/Agent_Resource_Manager/validation/manager-data';
const branch = 'codex/hosted-search-observer-pair-2d19488-20261121';
const statePair = ['search-0001', 'search-0002'];
const observers = ['pixels', 'uia'];
const perDirection = 6;
const measuredTrials = statePair.length * observers.length * perDirection;
const maxCheckAttempts = 40;
const expectedSchedulingKeys = 2002;
const execute = promisify(execFile);
const shaPattern = /^[a-f0-9]{64}$/;
const samePath = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = async path => hash(await readFile(path));
const serialized = value => JSON.stringify(value, null, 2) + '\n';

async function pinnedFile(path, expected) {
    assert.match(expected, shaPattern, 'Missing pinned SHA-256.');
    const stat = await lstat(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
    assert.ok(samePath(await realpath(path), path), 'Unexpected linked path.');
    const bytes = await readFile(path);
    assert.equal(hash(bytes), expected, 'Pinned digest changed: ' + basename(path));
    return bytes;
}

function protectedData(dataset) {
    const db = new DatabaseSync(dataset.dbPath, { readOnly: true });
    try {
        const { settings, sources, connections, localRoots, ignoredLocalPaths, checkMode, skills } =
            JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id = 1').get().payload);
        const fields = ['id', 'name', 'displayName', 'localPath', 'version', 'favorite', 'categoryId', 'runtimeFiles'];
        return {
            settings, sources, connections, localRoots, ignoredLocalPaths, checkMode,
            skills: skills.map(skill => Object.fromEntries(fields.map(key => [key, skill[key]]))),
            resources: db.prepare('SELECT id, revision, payload FROM resource_catalog ORDER BY id').all(),
        };
    } finally {
        db.close();
    }
}

export function validatePaintInterval(value, expectedText) {
    assert.equal(value.typed, expectedText);
    assert.equal(value.foreground, true);
    assert.ok(Number.isInteger(value.lastInputTick) && value.lastInputTick >= 0 && value.lastInputTick <= 0xffffffff);
    assert.ok(Number.isInteger(value.observations) && value.observations >= 2 && value.observations <= 160);
    const ticks = value => {
        assert.equal(typeof value, 'string');
        assert.match(value, /^[1-9]\d*$/);
        return BigInt(value);
    };
    const readRange = ({ startQpc, endQpc }) => {
        const start = ticks(startQpc);
        const end = ticks(endQpc);
        assert.ok(start <= end, 'Capture clock moved backwards.');
        return { start, end };
    };
    const frequency = ticks(value.qpcFrequency);
    const initial = readRange(value.initial);
    const sent = ticks(value.inputStartedQpc);
    const returned = ticks(value.inputReturnedQpc);
    const hit = readRange(value.firstHit);
    const confirmation = readRange(value.confirmation);
    const miss = value.lastMiss === null ? null : readRange(value.lastMiss);
    assert.ok(initial.end <= sent && sent <= returned && returned <= hit.start && hit.end <= confirmation.start);
    assert.ok(!miss || (returned <= miss.start && miss.end <= hit.start));
    const ms = delta => Number(delta) * 1000 / Number(frequency);
    const lowerBoundMs = miss ? ms(miss.start - sent) : 0;
    const upperBoundMs = ms(hit.end - sent);
    assert.ok(Number.isFinite(upperBoundMs) && upperBoundMs > 0 && upperBoundMs <= 4100);
    assert.ok(Math.abs(value.lowerBoundMs - lowerBoundMs) < .01);
    assert.ok(Math.abs(value.upperBoundMs - upperBoundMs) < .01);
    return { lowerBoundMs, upperBoundMs };
}

export function validateObserver(value, expectedText, observer) {
    assert.equal(value.typed, expectedText);
    assert.equal(value.observer, observer);
    assert.equal(value.inputMethod, 'ValuePattern.SetValue');
    assert.equal(value.foreground, true);
    const ticks = field => {
        assert.equal(typeof field, 'string');
        assert.match(field, /^[1-9]\d*$/);
        return BigInt(field);
    };
    const frequency = ticks(value.qpcFrequency);
    const initialEnd = ticks(value.initial.endQpc);
    const start = ticks(value.inputStartedQpc), invoked = ticks(value.setValueStartedQpc);
    const returned = ticks(value.inputReturnedQpc);
    const confirmationStart = ticks(value.confirmation.startQpc), confirmationEnd = ticks(value.confirmation.endQpc);
    assert.ok(ticks(value.initial.startQpc) <= initialEnd && initialEnd <= start && start <= invoked && invoked <= returned);
    assert.ok(returned <= confirmationStart && confirmationStart <= confirmationEnd);
    const asMs = delta => Number(delta) * 1000 / Number(frequency);
    const dispatch = {
        lookupAndInputMs: asMs(returned - start),
        setValueMs: asMs(returned - invoked),
        observationConfirmedMs: asMs(confirmationEnd - start),
    };
    assert.ok(dispatch.observationConfirmedMs <= 4100);
    if (observer === 'pixels') return { ...dispatch, ...validatePaintInterval(value, expectedText) };
    const ready = ticks(value.uiaFirstReadyQpc);
    assert.ok(returned <= ready && ready <= confirmationStart);
    assert.ok(Math.abs(value.durationMs - dispatch.observationConfirmedMs) < .01);
    return { ...dispatch, uiaReadyMs: asMs(ready - start) };
}

function chooseObserver(previous, samples) {
    const preferred = previous === statePair[0] ? observers : [...observers].reverse();
    const count = observer => samples.filter(sample => sample.previous === previous && sample.observer === observer).length;
    return count(preferred[0]) <= count(preferred[1]) ? preferred[0] : preferred[1];
}

async function startSearchObserver(identity, executable, descriptor, environment, frame) {
    const spec = Buffer.from(JSON.stringify({
        pid: identity.pid, creationFileTime: identity.creationFileTime, executable, root: descriptor.root,
        frame: [frame.left, frame.top, frame.width, frame.height],
    })).toString('base64');
    const helper = fileURLToPath(new URL('native-visual-input.ps1', import.meta.url));
    const child = spawn('pwsh.exe', ['-NoProfile', '-NonInteractive', '-MTA', '-File', helper, '-Spec', spec, '-AccessibilitySearchPilot'],
        { env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const session = new VisualSession(child);
    const timer = setTimeout(() => {
        session.readyReject(new Error('Native search observer readiness exceeded thirty seconds.'));
        child.stdin.end();
    }, 30000);
    try {
        await session.ready;
        return session;
    } finally {
        clearTimeout(timer);
    }
}

export function taskObserverSource(verifiedSource) {
    const boundary = "if($Mode -eq 'compile')";
    assert.equal(verifiedSource.split(boundary).length, 2);
    return verifiedSource.slice(0, verifiedSource.indexOf(boundary)) + [
        'function ClockSample {',
        '  $before = [Diagnostics.Stopwatch]::GetTimestamp()',
        '  $utcMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
        '  $after = [Diagnostics.Stopwatch]::GetTimestamp()',
        '  @{before=$before.ToString(); after=$after.ToString(); utcMs=$utcMs}',
        '}',
        "@{event='ready'; identity=@{ready=$true}} | ConvertTo-Json -Compress",
        'while ($line = [Console]::ReadLine()) {',
        '  $request = $line | ConvertFrom-Json',
        '  try {',
        "    if ($request.op -ceq 'finish') { @{id=$request.id; ok=$true; value=$null} | ConvertTo-Json -Compress; break }",
        "    if ($request.op -cne 'tasks') { throw 'Unsupported observation.' }",
        '    $before = ClockSample',
        "    $response = ([IdleMemoryRead]::Read($Spec,'task_list') | ConvertFrom-Json).value",
        '    $after = ClockSample',
        '    @{id=$request.id; ok=$true; value=@{before=$before; after=$after; frequency=[Diagnostics.Stopwatch]::Frequency.ToString(); tasks=@($response.tasks); lastInputTick=[IdleMemoryRead]::InputTick()}} | ConvertTo-Json -Depth 8 -Compress',
        '  } catch { @{id=$request.id; ok=$false; error=$_.Exception.GetBaseException().GetType().Name} | ConvertTo-Json -Compress }',
        '}',
        '',
    ].join('\n');
}

async function startTaskObserver(verifiedSource, root, identity, executable, dataset, env) {
    const path = join(root, 'search-paint-task-observer.ps1');
    await writeFile(path, taskObserverSource(verifiedSource), { flag: 'wx' });
    const spec = Buffer.from(JSON.stringify({ ...identity, executable, dataDir: dataset.dataDir })).toString('base64');
    const child = spawn('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path, '-Mode', 'status', '-Spec', spec], {
        env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const observer = new VisualSession(child);
    const timeout = setTimeout(() => {
        observer.readyReject(new Error('Task observer readiness exceeded ten seconds.'));
        child.stdin.end();
    }, 10000);
    try {
        await observer.ready;
        return observer;
    } finally {
        clearTimeout(timeout);
    }
}

const active = status => status === 'queued' || status === 'running';

function durableCheck(dataset, task) {
    const db = new DatabaseSync(dataset.dbPath, { readOnly: true });
    try {
        const row = db.prepare('SELECT payload FROM task_history WHERE id = ?').get(task.id);
        if (!row) return null;
        const stored = JSON.parse(row.payload);
        if (stored.status !== task.status || stored.finishedAt !== task.finishedAt) return null;
        assert.equal(stored.id, task.id);
        assert.equal(stored.action, 'check_now');
        assert.equal(stored.startedAt, task.startedAt);
        assert.equal(stored.status, 'succeeded', 'The expected global check did not finish successfully.');
        assert.ok(Array.isArray(stored.resources) && new Set(stored.resources).size === expectedSchedulingKeys &&
            stored.resources.length === expectedSchedulingKeys, 'The durable global check scope changed.');
        return { id: stored.id, action: stored.action, status: stored.status, startedAt: stored.startedAt,
            finishedAt: stored.finishedAt, schedulingKeys: stored.resources.length,
            schedulingKeysSha256: hash(JSON.stringify([...stored.resources].sort())) };
    } finally {
        db.close();
    }
}

async function waitForDurableCheck(observer, dataset, id) {
    const deadline = performance.now() + 20000;
    while (performance.now() < deadline) {
        const observation = await observer.call('tasks');
        const task = observation.tasks.find(item => item.id === id);
        assert.ok(task && task.action === 'check_now', 'The observed check disappeared.');
        if (!active(task.status)) {
            const durable = durableCheck(dataset, task);
            if (durable) return durable;
        }
        await sleep(30);
    }
    throw new Error('No durable successful global check was observed by its deadline.');
}

export function provenCheckOverlap(before, after, raw, taskBefore, taskAfter, durable) {
    assert.equal(taskBefore.id, taskAfter.id);
    assert.equal(taskBefore.id, durable.id);
    assert.equal(taskBefore.action, 'check_now');
    assert.equal(taskAfter.action, 'check_now');
    assert.equal(before.frequency, raw.qpcFrequency);
    assert.equal(after.frequency, raw.qpcFrequency);
    assert.equal(taskBefore.startedAt, durable.startedAt);
    assert.equal(taskAfter.startedAt, durable.startedAt);
    if (taskBefore.status !== 'running') return { accepted: false, reason: 'no-running-before-input' };
    const endBefore = BigInt(before.after.after);
    const startAfter = BigInt(after.before.before);
    const inputStarted = BigInt(raw.inputStartedQpc);
    const confirmationEnd = BigInt(raw.confirmation.endQpc);
    assert.ok(endBefore <= inputStarted && inputStarted <= confirmationEnd && confirmationEnd <= startAfter,
        'IPC task observations did not bracket the native paint observation.');
    assert.equal(after.lastInputTick, raw.lastInputTick, 'Input changed during the post-measurement owner check.');
    if (taskAfter.status === 'running') return { accepted: true, basis: 'same-task-running-on-both-qpc-sides' };
    assert.equal(taskAfter.status, durable.status);
    assert.equal(taskAfter.finishedAt, durable.finishedAt);
    const scale = 1000 / Number(raw.qpcFrequency);
    const beforeClock = before.after;
    const afterClock = after.before;
    const wallElapsed = afterClock.utcMs - beforeClock.utcMs;
    const monotonicElapsed = Number(startAfter - endBefore) * scale;
    const clockWidthMs = Math.max(Number(endBefore - BigInt(beforeClock.before)),
        Number(BigInt(afterClock.after) - startAfter)) * scale;
    if (!Number.isFinite(wallElapsed) || Math.abs(wallElapsed - monotonicElapsed) > 4 || clockWidthMs > 1)
        return { accepted: false, reason: 'utc-clock-bracket-not-consistent' };
    // The floor from the Windows millisecond clock and the allowed observed clock
    // error are both on the conservative side when checking durable completion.
    const latestConfirmationUtcMs = afterClock.utcMs - Number(startAfter - confirmationEnd) * scale + 5;
    const finishedUtcMs = Date.parse(durable.finishedAt);
    if (!Number.isFinite(finishedUtcMs) || finishedUtcMs <= latestConfirmationUtcMs)
        return { accepted: false, reason: 'durable-check-end-does-not-prove-full-paint-interval', latestConfirmationUtcMs };
    return { accepted: true, basis: 'durable-utc-completion-after-full-qpc-paint-interval', latestConfirmationUtcMs };
}

async function main(args) {
    assert.equal(process.platform, 'win32');
    assert.equal(process.env.GITHUB_ACTIONS, 'true');
    assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
    assert.equal(process.env.GITHUB_REPOSITORY, 'Zerozero05/Agent_Resource_Manager');
    assert.equal(process.env.GITHUB_REF_NAME, branch);
    assert.equal(args.length, 6);
    const [command, descriptorPath, executable, buildPath, reportPath, arm] = args;
    assert.equal(command, '--run');
    assert.equal(arm, 'paired-observers');
    const { CANDIDATE_SHA256, CANDIDATE_BUILD_INFO_SHA256, REFERENCE_SHA256, APPROVAL_SHA256, RUNNER_TEMP } = process.env;
    assert.match(CANDIDATE_BUILD_INFO_SHA256, shaPattern);
    assert.ok(RUNNER_TEMP && inside(reportPath, RUNNER_TEMP) && basename(reportPath) === 'search-observer-pair.json');
    const candidateDir = join(RUNNER_TEMP, 'arm-native-performance');
    assert.ok(samePath(executable, join(candidateDir, 'agent-resource-manager.exe')));
    assert.ok(samePath(buildPath, join(candidateDir, 'BUILD_INFO.native-validation.json')));
    const root = dirname(descriptorPath);
    assert.ok(samePath(dirname(root), validation) && /^native-visual-[A-Za-z0-9]+$/.test(basename(root)));
    assert.equal(basename(descriptorPath), 'visual-dataset.json');
    const descriptorBytes = await readFile(descriptorPath);
    const descriptor = JSON.parse(descriptorBytes);
    const { dataset } = descriptor;
    assert.ok(samePath(descriptor.root, root));
    assert.equal(descriptor.candidateSha256, CANDIDATE_SHA256);
    assert.equal(descriptor.transportSha256, CANDIDATE_SHA256);
    assert.ok(dataset.syntheticOnly && dataset.skillCount === 1000 && dataset.toolCount === 100);
    assert.ok(samePath(dataset.dataDir, join(root, 'fixture', 'data')));
    assert.ok(samePath(dataset.dbPath, join(dataset.dataDir, 'manager.sqlite3')));
    assert.deepEqual(JSON.parse(await readFile(join(root, 'fixture', 'dataset.json'))), dataset);
    const build = JSON.parse(await pinnedFile(buildPath, descriptor.buildInfoSha256));
    assert.equal(build.sourceCommit, source);
    assert.equal(String(build.workflowRunId), candidateRun);
    assert.equal(String(build.workflowRunAttempt), '1');
    assert.equal(build.repository, process.env.GITHUB_REPOSITORY);
    assert.equal(build.executableSha256, CANDIDATE_SHA256);
    assert.equal(build.originalBuildInfoSha256, CANDIDATE_BUILD_INFO_SHA256);
    assert.equal(build.buildMode, 'release');
    await pinnedFile(executable, CANDIDATE_SHA256);

    const referencePath = join(root, 'visual-references.json');
    const approvalPath = join(root, 'visual-approval.json');
    const reference = JSON.parse(await pinnedFile(referencePath, REFERENCE_SHA256));
    const approval = JSON.parse(await pinnedFile(approvalPath, APPROVAL_SHA256));
    validateReferences(reference, descriptor);
    assert.equal(reference.frame.dpi, 96, 'The frozen search content crops require 96 DPI.');
    assert.equal(approval.reviewedBy, 'root');
    assert.equal(approval.referenceSha256, REFERENCE_SHA256);
    assert.equal(approval.visualReviewConfirmed, true);
    assert.deepEqual(approval.reviewedStates, requiredStates);
    assert.deepEqual(reference.sources, descriptor.sources);
    for (const name of statePair) {
        const rois = reference.states[name].rois;
        assert.deepEqual(rois.map(roi => roi.role), ['result-title', 'result-table', 'result-count']);
        for (const [index, roi] of rois.entries()) {
            assert.ok(samePath(roi.path, join(root, 'references', name + '-' + index + '.png')));
            await pinnedFile(roi.path, roi.sha256);
        }
    }
    assert.notEqual(reference.states[statePair[0]].rois[0].sha256, reference.states[statePair[1]].rois[0].sha256);

    const observerSource = visualObserverSource();
    assert.ok(samePath(descriptor.observer, join(root, 'memory-observer.ps1')));
    assert.equal(hash(observerSource), descriptor.observerSha256);
    await pinnedFile(descriptor.observer, descriptor.observerSha256);
    const temporary = join(root, 'temp');
    await mkdir(temporary);
    const env = { ...process.env, TEMP: temporary, TMP: temporary };
    for (const key of Object.keys(env))
        if (/^(SKILL_MANAGER_DATA_DIR|WEBVIEW2_(USER_DATA_FOLDER|ADDITIONAL_BROWSER_ARGUMENTS|WAIT_FOR_SCRIPT_DEBUGGER|PIPE_FOR_SCRIPT_DEBUGGER))$/i.test(key))
            delete env[key];
    const report = {
        format: 'agent-resource-manager-native-search-observer-pair-v1',
        arm, source, candidateRun, executableSha256: CANDIDATE_SHA256,
        referenceSha256: REFERENCE_SHA256, approvalSha256: APPROVAL_SHA256,
        fixtureSha256: dataset.dataFingerprint, statePair, plannedTrials: measuredTrials, maxCheckAttempts, expectedSchedulingKeys,
        status: 'running', startedAt: new Date().toISOString(), attempts: [], samples: [], normalExit: false,
        limitations: [
            'Both arms use the same owned ValuePattern.SetValue dispatch. Subsequent pixel or UI Automation observations are mutually exclusive.',
            'Exact RGB compares fixed content rectangles inside the approved title and table ROIs, with the full approved result count. The icon-only strips are excluded from this diagnostic.',
            'Pixel capture starts after SetValue returns. If its first frame matches, the interval cannot locate presentation inside dispatch.',
            'Finite QPC intervals bracket an observed result, not the exact presentation time or any transient between samples.',
            'One fixed synthetic pair and a bounded sample set. This does not replace the 1200-input benchmark or its original 200 ms gate.',
        ],
    };
    const save = () => writeFile(reportPath, serialized(report));
    await writeFile(reportPath, serialized(report), { flag: 'wx' });
    let child, exit, identity, visual, taskObserver, baseline;
    try {
        const ownership = await assertNoUserManager({ transportSha256: CANDIDATE_SHA256 });
        assert.equal(ownership.managers.length, 0, 'Expected a fresh isolated runner with no manager processes.');
        child = spawn(executable, ['--data-dir', dataset.dataDir], { env, cwd: dirname(executable), stdio: 'ignore' });
        child.on('exit', (code, signal) => { exit = { code, signal }; });
        await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); });

        const readinessDeadline = performance.now() + 30000;
        while (!exit && performance.now() < readinessDeadline) {
            const spec = Buffer.from(JSON.stringify({ pid: child.pid, executable, dataDir: dataset.dataDir })).toString('base64');
            const observation = execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', descriptor.observer, '-Mode', 'status', '-Spec', spec], {
                env, windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024,
            });
            observation.child.stdin.end();
            const { stdout } = await observation;
            const status = JSON.parse(stdout.trim());
            if (status.ok) {
                assert.equal(status.identity.pid, child.pid);
                assert.match(status.identity.creationFileTime, /^[1-9]\d*$/);
                assert.ok(status.ready && samePath(status.dataDir, dataset.dataDir));
                identity = status.identity;
                break;
            }
            assert.equal(status.errorType, 'TimeoutException', 'Owner-checked backend readiness failed.');
            await sleep(100);
        }
        assert.ok(identity, 'Owner-checked backend readiness expired.');
        taskObserver = await startTaskObserver(observerSource, root, identity, executable, dataset, env);
        visual = await startSearchObserver(identity, executable, descriptor, env, reference.frame);
        const owned = await visual.call('prepareForeground');
        assert.equal(owned.pid, identity.pid);
        assert.equal(owned.creationFileTime, identity.creationFileTime);
        assert.equal(owned.foreground, true);
        assert.ok(Number.isSafeInteger(owned.windowHandle) && owned.windowHandle > 0);
        for (const key of ['left', 'top', 'width', 'height', 'dpi', 'captureBounds'])
            assert.deepEqual(owned[key], reference.frame[key], 'Unexpected frozen window geometry: ' + key);
        report.identity = owned;
        baseline = protectedData(dataset);

        // Prime the fixed left state without including the positioning or scroll time in the measurement.
        await visual.call('scrollLibrary', { ...reference.controls.search, up: true });
        await visual.call('click', reference.controls.search);
        const initialQuery = 'perf-skill-' + statePair[0].slice(-4);
        assert.equal((await visual.call('text', { value: initialQuery })).typed, initialQuery);
        const firstState = reference.states[statePair[0]];
        const primeDeadline = performance.now() + 15000;
        let primed = false;
        while (!primed && performance.now() < primeDeadline) {
            primed = true;
            for (const roi of firstState.rois) {
                if (!(await visual.call('match', roi, 2500)).matched) {
                    primed = false;
                    break;
                }
            }
            if (!primed) await sleep(50);
        }
        assert.ok(primed, 'The fixed initial search state did not match; no measurement input was sent.');

        const filteredBounds = reference.firstSearchPreflight.filteredSearchBounds.split(',').map(Number);
        assert.ok(filteredBounds.length === 4 && filteredBounds.every(Number.isInteger));
        const [sx, sy, sw, sh] = filteredBounds;
        const filteredSearch = { x: sx + Math.floor(sw / 2) - reference.frame.left,
            y: sy + Math.floor(sh / 2) - reference.frame.top };
        let previous = statePair[0];
        let schedulingKeysSha256 = null;
        const complete = () => statePair.every(previous => observers.every(observer =>
            report.samples.filter(sample => sample.previous === previous && sample.observer === observer).length >= perDirection));
        for (let index = 0; index < maxCheckAttempts && !complete(); index++) {
            const existing = await taskObserver.call('tasks');
            assert.ok(existing.tasks.every(task => !active(task.status)), 'Another active backend operation would contaminate the check workload.');
            const known = new Set(existing.tasks.map(task => task.id));
            await visual.call('click', reference.controls.check);
            const focus = await visual.call('click', filteredSearch);
            const observer = chooseObserver(previous, report.samples);
            const attempt = { index, previous, observer };
            report.attempts.push(attempt);
            let before, taskBefore;
            const runningDeadline = performance.now() + 1000;
            do {
                before = await taskObserver.call('tasks');
                const added = before.tasks.filter(task => !known.has(task.id));
                assert.ok(added.length <= 1 && added.every(task => task.action === 'check_now'),
                    'The single check click was accompanied by an unexpected task.');
                taskBefore = added[0];
                if (taskBefore && taskBefore.status !== 'queued') break;
                await sleep(15);
            } while (performance.now() < runningDeadline);
            assert.ok(taskBefore, 'One click could not be tied to its exact global check; no measurement was sent.');
            attempt.before = { ...before, tasks: [taskBefore] };
            if (taskBefore.status !== 'running') {
                attempt.durable = await waitForDurableCheck(taskObserver, dataset, taskBefore.id);
                attempt.overlap = { accepted: false, reason: 'no-running-before-input' };
                await save();
                continue;
            }
            assert.equal(before.lastInputTick, focus.lastInputTick, 'Unexpected input before the measured search.');
            const target = statePair.find(state => state !== previous);
            const value = 'perf-skill-' + target.slice(-4);
            const fields = { value, observer, previousRois: reference.states[previous].rois, targetRois: reference.states[target].rois };
            attempt.target = target;
            attempt.raw = await visual.call('searchObserver', fields, 15000);
            attempt.measurement = validateObserver(attempt.raw, value, observer);
            previous = target;
            const after = await taskObserver.call('tasks');
            const taskAfter = after.tasks.find(item => item.id === taskBefore.id);
            assert.ok(taskAfter, 'The exact running task disappeared during the measured search.');
            attempt.after = { ...after, tasks: [taskAfter] };
            attempt.durable = await waitForDurableCheck(taskObserver, dataset, taskBefore.id);
            attempt.overlap = provenCheckOverlap(before, after, attempt.raw, taskBefore, taskAfter, attempt.durable);
            schedulingKeysSha256 ??= attempt.durable.schedulingKeysSha256;
            assert.equal(attempt.durable.schedulingKeysSha256, schedulingKeysSha256, 'Global checks did not share one fixed scope.');
            if (attempt.overlap.accepted) {
                const admitted = report.samples.filter(sample => sample.previous === attempt.previous && sample.observer === observer).length;
                attempt.inPilotGroup = admitted < perDirection;
                if (attempt.inPilotGroup) report.samples.push(attempt);
            }
            await save();
            await sleep(150);
        }
        report.status = complete() ? 'paired-trials-complete' : 'paired-incomplete';
    } catch (error) {
        report.status = 'paired-incomplete';
        report.error = error.message;
    } finally {
        if (taskObserver)
            await taskObserver.finish().catch(error => { report.taskObserverExitError = error.message; });
        if (visual)
            await visual.finish().catch(error => { report.driverExitError = error.message; });
        if (identity && !exit) {
            await save();
            console.log(JSON.stringify({
                phase: 'ready-for-owned-normal-quit', arm, pid: child.pid,
                creationFileTime: identity.creationFileTime, executable, reportPath, waitMs: 120000,
            }));
            const deadline = performance.now() + 120000;
            while (!exit && performance.now() < deadline) await sleep(100);
            report.normalExit = exit?.code === 0 && exit?.signal === null;
        }
        report.exit = exit ?? null;
        if (child && !exit) child.unref();
        try {
            if (baseline && report.normalExit) {
                assert.deepEqual(protectedData(dataset), baseline);
                report.managementDataPreserved = true;
            }
            await pinnedFile(executable, CANDIDATE_SHA256);
            await pinnedFile(referencePath, REFERENCE_SHA256);
            await pinnedFile(approvalPath, APPROVAL_SHA256);
            for (const file of descriptor.runtimeFiles) await pinnedFile(file.path, file.sha256);
            report.runtimeFilesPreserved = true;
        } catch (error) {
            report.integrityError = error.message;
        }
        const success = report.status === 'paired-trials-complete' && report.samples.length === measuredTrials &&
            report.normalExit && report.managementDataPreserved && report.runtimeFilesPreserved && !report.driverExitError && !report.taskObserverExitError;
        report.status = success ? 'paired-observers-observed' : 'paired-incomplete';
        report.finishedAt = new Date().toISOString();
        await save();
        console.log(JSON.stringify({ phase: 'search-paint-result', arm, status: report.status, trials: report.samples.length, reportPath }));
        if (!success) process.exitCode = 1;
    }
}

if (import.meta.main) main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
