import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createPerformanceFixture } from './performance-fixture.mjs';
import { PERFORMANCE_POLICY, freezeConvergenceBounds, stabilityVerdict } from './performance-policy.mjs';
import { IDLE_OBSERVER, idleObservation } from './diagnose-native-idle-memory.mjs';
import { assertNoUserManager } from './native-uia-client.mjs';
const approved = 'D:/03_github_projects/Agent_Management/Agent_Resource_Manager/validation/manager-data';
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const executable = join(sourceRoot, 'outputs/v1-validation/detached-workspace-restore-retry-20261118/agent-resource-manager.exe');
const buildInfo = join(dirname(executable), 'candidate-build-info.json');
const candidateSha256 = '9436a75a4cf40316f80702e43c7b4da35067ec9e16a0ce592846599433e9b1aa';
const buildInfoSha256 = '0bdcc16ff13fffa08045b791abcb93897b24c91153675127c6fddd8dbc1c0028';
const transportSha256 = 'f9dfe387f6900925808cdd16b9785f29b96e90c40b554b828b17557f99bd846f';
const hostedReferenceFrame = null;
const hostedFirstSearchReceipt = null;
const hostedRetentionReference = null;
const shortRetentionPolicy = Object.freeze({ cycles: 12, intervalMs: 12000, cooldownMs: 20000 });
const helper = fileURLToPath(new URL('native-visual-input.ps1', import.meta.url));
const sourceFiles = ['verify-native-visual-stability.mjs', 'native-visual-input.ps1', 'performance-policy.mjs', 'performance-fixture.mjs', 'diagnose-native-idle-memory.mjs', 'native-uia-client.mjs', 'verify-native-uia.ps1'].map(name => fileURLToPath(new URL(name, import.meta.url)));
const format = 'agent-resource-manager-native-visual-stability-v1';
const execute = promisify(execFile), json = value => JSON.stringify(value, null, 2) + '\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = async (path) => hash(await readFile(path));
const same = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
const sleep = milliseconds => new Promise(done => setTimeout(done, Math.max(0, milliseconds)));
const sources = async () => Promise.all(sourceFiles.map(async (path) => ({ path, sha256: await digest(path) })));
const requiredControls = ['search', 'clear', 'github', 'allFiltered', 'openDocument', 'homeTab', 'documentTab', 'closeDocument', 'check'];
export const requiredStates = Object.freeze([...Array.from({ length: 66 }, (_, index) => `search-${String(index).padStart(4, '0')}`), 'all', 'github', 'document', 'homeDocument', 'documentTab', 'closed']);
export const visualPolicy = Object.freeze({ match: 'exact-normalized-BGRA', matchTimeoutMs: 15000, stableObservations: 2, observationGapMs: 50, referenceSettleMs: 250, preparationIdleMs: 120000, normalQuitWaitMs: 180000 });
const tableName = '可横向滚动的 Skill 列表';
const documentParagraph = '仅用于隔离的本地性能验收，不调用外部程序，不连接远端。';
const documentWheelDelta = -120;
const maximumDocumentWheelSteps = 12;
const boxCenter = ([x, y, width, height]) => ({ x: x + Math.floor(width / 2), y: y + Math.floor(height / 2) });
export function requiredRegions(state) {
    assert.ok(requiredStates.includes(state), 'Unknown visual reference state.');
    const table = { role: 'result-table', source: { kind: 'native-element', name: tableName } };
    const counter = { role: 'result-count', source: { kind: 'relative-to-native-element', name: tableName, topOffset: -70, widthLimit: 440, height: 56 } };
    const paragraph = { role: 'document-paragraph', source: { kind: 'native-element', name: documentParagraph, type: 'ControlType.Text' } };
    if (state.startsWith('search-')) {
        return [{ role: 'result-title', source: { kind: 'native-element', name: `Perf Skill ${state.slice(7)}`, scope: tableName, type: 'ControlType.Button' } }, table, counter];
    }
    if (state === 'all' || state === 'homeDocument') return [table, counter];
    if (state === 'github') return [{ role: 'empty-filter-title', source: { kind: 'native-element', name: '当前筛选无结果' } }];
    if (state === 'document' || state === 'documentTab') {
        return [{ role: 'active-document-tab', source: { kind: 'native-element', name: 'Perf Skill 0000', scope: '工作区标签', type: 'ControlType.TabItem', selected: true } }, paragraph];
    }
    return [table, counter, { role: 'closed-tab-slot', source: { kind: 'native-element-before-close', name: 'Perf Skill 0000', scope: '工作区标签', type: 'ControlType.TabItem' } }];
}
export function visualObserverSource() {
    const modes = "[ValidateSet('status','sample','compile')]", branch = "  if($Mode -eq 'status') {";
    assert.equal(IDLE_OBSERVER.split(modes).length, 2);
    assert.equal(IDLE_OBSERVER.split(branch).length, 2);
    return IDLE_OBSERVER.replace(modes, "[ValidateSet('status','sample','compile','tasks')]").replace(branch, "  if($Mode -eq 'tasks') { $tasks=([IdleMemoryRead]::Read($Spec,'task_list')|ConvertFrom-Json).value; [pscustomobject]@{ok=$true;identity=@{pid=$status.pid;creationFileTime=$status.creationFileTime};tasks=@($tasks.tasks)}|ConvertTo-Json -Depth 8 -Compress; exit 0 }\n" + branch);
}
export function options(args) {
    assert.ok(['--prepare', '--references', '--pilot', '--run', '--short-retention', '--help'].includes(args[0]));
    assert.equal(args.length, ['--prepare', '--help'].includes(args[0]) ? 1 : 2);
    return { mode: args[0], path: args[1] };
}
export function inside(path, root) { const part = relative(resolve(root), resolve(path)); return part === '' || !isAbsolute(part) && part !== '..' && !part.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')); }
async function ordinary(path) {
    let current = resolve(path);
    while (current !== dirname(current)) {
        const stat = await lstat(current);
        assert.equal(stat.isSymbolicLink(), false, 'A visual input is a reparse/symbolic path.');
        if (stat.isFile())
            assert.equal(stat.nlink, 1, 'Visual inputs must be ordinary single-link files.');
        assert.ok(same(await realpath(current), current));
        current = dirname(current);
    }
}
export function validBox(box, frame) {
    return Array.isArray(box) && box.length === 4 && box.every(Number.isSafeInteger) && box[0] >= 0 && box[1] >= 0 && box[2] >= 2 && box[3] >= 2 && box[0] + box[2] <= frame.width && box[1] + box[3] <= frame.height && box[2] * box[3] <= 2000000;
}
function fitsCapture(box, frame) {
    if (!validBox(box, frame) || !validBox(frame.captureBounds, frame)) return false;
    const [left, top, width, height] = frame.captureBounds;
    return box[0] >= left && box[1] >= top && box[0] + box[2] <= left + width && box[1] + box[3] <= top + height;
}
export function validateReferences(ref, descriptor, retentionReference = null) {
    assert.equal(ref.format, format);
    assert.equal(ref.candidateSha256, retentionReference?.candidateSha256 ?? candidateSha256);
    assert.equal(ref.semanticReferencePhaseCompleted, true);
    assert.ok(same(ref.root, retentionReference?.root ?? descriptor.root));
    assert.equal(ref.datasetFingerprint, descriptor.dataset.dataFingerprint);
    if (hostedFirstSearchReceipt) assert.deepEqual(ref.firstSearchPreflight, hostedFirstSearchReceipt);
    assert.ok(Number.isSafeInteger(ref.frame.left) && Number.isSafeInteger(ref.frame.top));
    assert.ok(Number.isSafeInteger(ref.frame.width) && ref.frame.width >= 600 && Number.isSafeInteger(ref.frame.height) && ref.frame.height >= 400 && Number.isSafeInteger(ref.frame.dpi) && ref.frame.dpi > 0);
    assert.ok(validBox(ref.frame.captureBounds, ref.frame), 'The frozen visible client geometry is missing or invalid.');
    assert.deepEqual(Object.keys(ref.states).sort(), [...requiredStates].sort());
    assert.deepEqual(Object.keys(ref.controls).sort(), [...requiredControls].sort());
    for (const point of Object.values(ref.controls))
        assert.ok(Number.isSafeInteger(point.x) && Number.isSafeInteger(point.y) && point.x >= 0 && point.y >= 0 && point.x < ref.frame.width && point.y < ref.frame.height);
    for (const [name, state] of Object.entries(ref.states)) {
        assert.equal(state.semanticConfirmedByNativeDriver, true, name);
        assert.ok(Array.isArray(state.rois));
        assert.deepEqual(state.rois.map(({ role, source }) => ({ role, source })), requiredRegions(name), `Missing, replaced or reordered reference ROI in ${name}.`);
        for (const roi of state.rois) {
            assert.ok(fitsCapture(roi.box, ref.frame), `A frozen ROI leaves the visible client area in ${name}.`);
            assert.ok(inside(roi.path, ref.root) && roi.path.endsWith('.png'));
            assert.match(roi.sha256, /^[a-f0-9]{64}$/);
        }
        const table = state.rois.find(roi => roi.role === 'result-table');
        const counter = state.rois.find(roi => roi.role === 'result-count');
        if (counter) {
            assert.deepEqual(counter.box, [table.box[0], Math.max(0, table.box[1] - 70), Math.min(440, table.box[2]), 56], `Result count lost its frozen table-relative geometry in ${name}.`);
        }
        const title = state.rois.find(roi => roi.role === 'result-title');
        if (title) {
            assert.ok(title.box[0] >= table.box[0] && title.box[1] >= table.box[1] &&
                title.box[0] + title.box[2] <= table.box[0] + table.box[2] &&
                title.box[1] + title.box[3] <= table.box[1] + table.box[3], `Result title escaped its confirmed table in ${name}.`);
        }
    }
    const { point, descriptionBox, initialBox, steps, returnedBox } = ref.documentReading;
    assert.ok(fitsCapture(descriptionBox, ref.frame));
    assert.deepEqual(point, boxCenter(descriptionBox), 'The native document wheel must target the observed description tab.');
    const canRecordBounds = box => Array.isArray(box) && box.length === 4 && box.every(Number.isSafeInteger) && box[2] >= 2 && box[3] >= 2;
    assert.ok(canRecordBounds(initialBox));
    assert.ok(Array.isArray(steps) && steps.length <= maximumDocumentWheelSteps);
    let previousBox = initialBox;
    for (const step of steps) {
        assert.equal(step.wheelDelta, documentWheelDelta);
        assert.ok(canRecordBounds(step.paragraphBox) && step.paragraphBox[1] < previousBox[1], 'Each frozen wheel event must move the exact paragraph upward.');
        previousBox = step.paragraphBox;
    }
    assert.deepEqual(ref.states.document.rois[1].box, previousBox, 'The document ROI must bind to the actual final wheel state.');
    assert.deepEqual(returnedBox, previousBox, 'The document moved during the tab round trip.');
    assert.deepEqual(ref.states.documentTab.rois[1].box, returnedBox, 'The returned document ROI must bind to the retained position.');
    assert.deepEqual(ref.policy, visualPolicy);
    assert.equal(ref.capture, 'foreground-owned-CopyFromScreen');
    return true;
}
export function cycleActions(index) {
    assert.ok(Number.isSafeInteger(index) && index >= 0 && index <= 65);
    return [['search', index], ['clear'], ['filter', true], ['filter', false], ['search', 0], ['document'], ['tab', true], ['tab', false], ['close'], ['clear']];
}
async function runtimeFiles(dataset) {
    const records = [];
    for (const [root, count, prefix, digits, filename] of [[dataset.skillsRoot, 1000, 'perf-skill-', 4, 'SKILL.md'], [dataset.toolsRoot, 100, 'perf-tool-', 3, 'README.md']]) {
        for (let index = 0; index < count; index++) {
            const path = join(root, prefix + String(index).padStart(digits, '0'), filename);
            await ordinary(path);
            records.push({ path, sha256: await digest(path) });
        }
    }
    return records;
}
function protectedData(dataset) {
    const db = new DatabaseSync(dataset.dbPath, { readOnly: true });
    try {
        const state = JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload);
        return { settings: state.settings, sources: state.sources, connections: state.connections, localRoots: state.localRoots, ignoredLocalPaths: state.ignoredLocalPaths, checkMode: state.checkMode,
            skills: state.skills.map(skill => Object.fromEntries(['id', 'name', 'displayName', 'localPath', 'version', 'favorite', 'categoryId', 'runtimeFiles'].map(key => [key, skill[key]]))),
            resources: db.prepare('SELECT id,revision,payload FROM resource_catalog ORDER BY id').all() };
    }
    finally {
        db.close();
    }
}
async function candidate() { const bytes = await readFile(buildInfo); assert.equal(hash(bytes), buildInfoSha256); const info = JSON.parse(bytes.toString('utf8')); assert.equal(info.buildMode, 'release'); assert.equal(info.executableSha256, candidateSha256); assert.equal(info.diagnosticOnly === true, false); assert.equal(await digest(executable), candidateSha256); }
async function prepare() {
    await candidate();
    await ordinary(approved);
    const root = await mkdtemp(join(approved, 'native-visual-'));
    const dataset = await createPerformanceFixture(root, 'fixture', 100), observer = join(root, 'memory-observer.ps1');
    const observerSource = visualObserverSource();
    await writeFile(observer, observerSource, { flag: 'wx' });
    const descriptor = { format, root, dataset, candidateSha256, transportSha256, buildInfoSha256: await digest(buildInfo), observer, observerSha256: hash(observerSource), sources: await sources(), runtimeFiles: await runtimeFiles(dataset), createdAt: new Date().toISOString() };
    const path = join(root, 'visual-dataset.json');
    await writeFile(path, json(descriptor), { flag: 'wx' });
    console.log(json({ status: 'prepared-no-gui-run', descriptor: path, referencesRequired: true, visualReviewAndPilotRequired: true }));
}
async function descriptorAt(path) {
    path = resolve(path);
    await ordinary(path);
    const descriptor = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(descriptor.format, format);
    assert.equal(descriptor.candidateSha256, candidateSha256);
    assert.equal(descriptor.transportSha256, transportSha256);
    assert.ok(inside(descriptor.root, approved) && basename(descriptor.root).startsWith('native-visual-') && same(path, join(descriptor.root, 'visual-dataset.json')));
    assert.equal(descriptor.dataset.skillCount, 1000);
    assert.equal(descriptor.dataset.toolCount, 100);
    for (const [field, suffix] of [['root', ''], ['dataDir', 'data'], ['dbPath', 'data/manager.sqlite3'], ['skillsRoot', 'skills'], ['toolsRoot', 'tools']]) {
        assert.ok(same(descriptor.dataset[field], join(descriptor.root, 'fixture', suffix)), 'A fixture path escaped its generated directory.');
        await ordinary(descriptor.dataset[field]);
    }
    assert.deepEqual(JSON.parse(await readFile(join(descriptor.dataset.root, 'dataset.json'), 'utf8')), descriptor.dataset);
    assert.equal(await digest(buildInfo), descriptor.buildInfoSha256);
    await candidate();
    assert.deepEqual(await sources(), descriptor.sources);
    assert.deepEqual(await runtimeFiles(descriptor.dataset), descriptor.runtimeFiles);
    assert.ok(same(descriptor.observer, join(descriptor.root, 'memory-observer.ps1')));
    assert.equal(await digest(descriptor.observer), descriptor.observerSha256);
    return descriptor;
}
export class VisualSession {
    constructor(child) {
        this.child = child;
        this.pending = new Map();
        this.nextId = 1;
        this.error = '';
        this.ready = new Promise((done, reject) => { this.readyResolve = done; this.readyReject = reject; });
        this.closed = new Promise(done => child.once('exit', (code, signal) => { this.exited = true; this.readyReject(new Error('Visual driver exited before readiness.')); for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.reject(new Error('Visual driver exited.'));
        } this.pending.clear(); done({ code, signal }); }));
        createInterface({ input: child.stdout }).on('line', line => { let value; try {
            value = JSON.parse(line);
        }
        catch {
            return;
        } if (value.event === 'ready') {
            this.identity = value.identity;
            this.readyResolve(value.identity);
        }
        else {
            const request = this.pending.get(value.id);
            if (request) {
                this.pending.delete(value.id);
                clearTimeout(request.timer);
                value.ok ? request.resolve(value.value) : request.reject(new Error(value.error));
            }
        } });
        child.stderr.on('data', chunk => { this.error = (this.error + chunk).slice(-2000); });
        child.once('error', error => this.readyReject(error));
    }
    static async attach(identity, descriptor, environment, frame) {
        const spec = Buffer.from(JSON.stringify({ pid: identity.pid, creationFileTime: identity.creationFileTime, executable, root: descriptor.root,
            ...(frame ? { frame: [frame.left, frame.top, frame.width, frame.height] } : {}) })).toString('base64');
        const child = spawn('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', helper, '-Spec', spec], { env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        const session = new VisualSession(child), deadline = setTimeout(() => { session.readyReject(new Error('Visual driver readiness exceeded thirty seconds.')); child.stdin.end(); }, 30000);
        try {
            await session.ready;
            return session;
        }
        finally {
            clearTimeout(deadline);
        }
    }
    call(op, fields = {}, timeoutMs = 20000) {
        assert.ok(!this.exited, 'Visual driver has exited.');
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('Visual operation timed out. No input was replayed.'));
                this.child.stdin.end();
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.child.stdin.write(JSON.stringify({ id, op, ...fields }) + '\n');
        });
    }
    async finish() { if (!this.exited) {
        try {
            await this.call('finish');
        }
        finally {
            this.child.stdin.end();
        }
    } const result = await this.closed; assert.equal(result.code, 0, this.error); }
}
function environment(root) {
    const env = { ...process.env, TEMP: join(root, 'temp'), TMP: join(root, 'temp') };
    for (const key of Object.keys(env))
        if (/^(SKILL_MANAGER_DATA_DIR|WEBVIEW2_(USER_DATA_FOLDER|ADDITIONAL_BROWSER_ARGUMENTS|WAIT_FOR_SCRIPT_DEBUGGER|PIPE_FOR_SCRIPT_DEBUGGER))$/i.test(key))
            delete env[key];
    return env;
}
async function observe(descriptor, identity, env, mode) {
    const spec = Buffer.from(JSON.stringify({ ...identity, executable, dataDir: descriptor.dataset.dataDir })).toString('base64');
    const pending = execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', descriptor.observer, '-Mode', mode, '-Spec', spec], { env, windowsHide: true, timeout: 20000, maxBuffer: 256 * 1024 });
    pending.child.stdin.end();
    const { stdout } = await pending, result = JSON.parse(stdout.trim());
    if (!result.ok) {
        const error = new Error('Owner-checked observation failed: ' + result.errorType);
        error.observationType = result.errorType;
        throw error;
    }
    return result;
}
function unclippedNativeBox(text, frame) {
    const numbers = text.split(',').map(Number);
    assert.equal(numbers.length, 4);
    assert.ok(numbers.every(Number.isFinite));
    const left = Math.floor(numbers[0] - frame.left), top = Math.floor(numbers[1] - frame.top);
    return [left, top, Math.ceil(numbers[0] - frame.left + numbers[2]) - left, Math.ceil(numbers[1] - frame.top + numbers[3]) - top];
}
function relativeBox(text, frame) {
    const [x, y, width, height] = unclippedNativeBox(text, frame);
    const left = Math.max(0, x), top = Math.max(0, y);
    const right = Math.min(frame.width, x + width), bottom = Math.min(frame.height, y + height);
    const box = [left, top, right - left, bottom - top];
    assert.ok(validBox(box, frame));
    return box;
}
function visibleTableBox(bounds, frame) {
    const [x, y, width, height] = unclippedNativeBox(bounds, frame);
    const [left, top, clientWidth, clientHeight] = frame.captureBounds;
    const clipped = [Math.max(x, left), Math.max(y, top)];
    clipped.push(Math.min(x + width, left + clientWidth) - clipped[0], Math.min(y + height, top + clientHeight) - clipped[1]);
    assert.ok(fitsCapture(clipped, frame) && clipped[1] === y, 'The top of the result table must remain visible.');
    return clipped;
}
function completeCaptureBox(bounds, frame, name) {
    const box = unclippedNativeBox(bounds, frame);
    assert.ok(fitsCapture(box, frame), `${name} must fit entirely in the visible client area. Element=${box}; client=${frame.captureBounds}.`);
    return box;
}
async function waitForEmptyFilterToChange(visual, roi) {
    const deadline = performance.now() + visualPolicy.matchTimeoutMs;
    let lastDifferent;
    do {
        const remaining = Math.floor(deadline - performance.now());
        if (remaining < 1) break;
        const current = await visual.call('match', roi, remaining);
        if (performance.now() >= deadline) break;
        if (!current.matched && current.pixelSha256 === lastDifferent) return;
        lastDifferent = current.matched ? undefined : current.pixelSha256;
        await sleep(Math.min(visualPolicy.observationGapMs, deadline - performance.now()));
    } while (performance.now() < deadline);
    throw new Error('The empty filter state did not visibly change after the owned reset. No wheel was sent.');
}

export function referenceObservationRows(value) {
    // PowerShell's switch enumerates these collections before JSON serialization.
    const rows = value === null ? [] : Array.isArray(value) ? value : [value];
    assert.ok(rows.every(row => row && typeof row.name === 'string' && typeof row.type === 'string'), 'Invalid native reference observation.');
    return rows;
}
async function references(descriptor) {
    const { NativeUiaSession } = await import('./native-uia-client.mjs');
    await writeFile(join(descriptor.root, 'references-owner.json'), json({ startedAt: new Date().toISOString() }), { flag: 'wx' });
    await mkdir(join(descriptor.root, 'temp'), { recursive: true });
    await mkdir(join(descriptor.root, 'references'));
    const env = environment(descriptor.root);
    const savedTemp = process.env.TEMP, savedTmp = process.env.TMP;
    let app, visual, failure, lastRead, exitEvidence;
    let referencePhase = 'launch-reference-session', quitRequested = false;
    const ref = { format, root: descriptor.root, candidateSha256, datasetFingerprint: descriptor.dataset.dataFingerprint, policy: visualPolicy, sources: descriptor.sources, controls: {}, states: {}, semanticReferencePhaseCompleted: false, capture: 'foreground-owned-CopyFromScreen', limitations: ['Reference semantics are confirmed with the existing native driver. Runtime verification uses frozen visible ROIs, not hidden DOM/AX row counting.'] };
    async function closeReferenceApp() {
        if (!app || quitRequested) return;
        quitRequested = true;
        let receipt;
        try {
            ({ driverReport: receipt } = await app.quit());
        } finally {
            receipt ??= app.driverReport;
            const identity = app.identity;
            const normalExit = receipt?.closedNormally === true && receipt.pid === identity.pid
                && receipt.creationFileTime === identity.creationFileTime && receipt.windowHandle === identity.windowHandle
                && receipt.executableSha256 === candidateSha256 && typeof receipt.dataDirectory === 'string'
                && same(receipt.dataDirectory, descriptor.dataset.dataDir);
            exitEvidence = { normalExit, pid: identity.pid, creationFileTime: identity.creationFileTime, windowHandle: identity.windowHandle,
                driverStatus: receipt?.status, recoveryUsed: receipt?.recoveryExitUsedInvoke === true, closeError: receipt?.closeError,
                ownedProcessStillRunning: receipt?.ownedProcessStillRunning, inputStillPending: receipt?.inputStillPending };
        }
        assert.equal(exitEvidence.normalExit, true, 'The reference session did not prove exact owned normal exit.');
        app = null;
    }
    try {
        process.env.TEMP = env.TEMP;
        process.env.TMP = env.TMP;
        app = await NativeUiaSession.launch({ executable, sha256: candidateSha256, transportSha256, dataDir: descriptor.dataset.dataDir, reportPath: join(descriptor.root, 'reference-driver.json') });
        visual = await VisualSession.attach(app.identity, descriptor, env, hostedReferenceFrame);
        if (hostedReferenceFrame) assert.equal(visual.identity.dpi, hostedReferenceFrame.dpi, 'Hosted display DPI changed before reference input.');
        await visual.call('prepareForeground');
        ref.frame = visual.identity;
        assert.ok(validBox(ref.frame.captureBounds, ref.frame), 'Expected exact visible client geometry.');
        if (hostedFirstSearchReceipt) {
            assert.equal(descriptor.dataset.dataFingerprint, hostedFirstSearchReceipt.datasetFingerprint);
            ref.firstSearchPreflight = hostedFirstSearchReceipt;
        }
        const observeRows = async (op, fields, deadline = performance.now() + visualPolicy.matchTimeoutMs) => {
            lastRead = { op, name: fields?.name, scope: fields?.scope };
            if (!hostedReferenceFrame && op !== 'scopeNames') return referenceObservationRows(await app.call(op, fields));
            const remaining = Math.floor(deadline - performance.now());
            assert.ok(remaining > 0, 'The owned reference observation reached its original deadline.');
            const scoped = op === 'state' && fields?.scope ? { referenceAllowPendingScope: true } : {};
            return referenceObservationRows(await app.call(op, { ...fields, ...scoped, referenceReadBudgetMs: remaining }, remaining));
        };
        async function element(name, scope, type, selected, deadline = performance.now() + visualPolicy.matchTimeoutMs) {
            do {
                const rows = await observeRows('state', { name, ...(scope ? { scope } : {}) }, deadline);
                const matches = rows.filter(row => !row.offscreen && (!type || row.type === type));
                assert.ok(matches.length <= 1, `Ambiguous visible reference element ${name}.`);
                if (matches.length === 1 && matches[0].enabled && (selected === undefined || matches[0].selected === selected))
                    return matches[0];
                await sleep(50);
            } while (performance.now() < deadline);
            throw new Error(`Expected one ready visible reference element ${name}.`);
        }
        async function point(key, name, scope, type = 'ControlType.Button') { const box = relativeBox((await element(name, scope, type)).bounds, ref.frame); ref.controls[key] = { x: box[0] + Math.floor(box[2] / 2), y: box[1] + Math.floor(box[3] / 2), sourceName: name, sourceScope: scope, box }; return box; }
        async function tableRois() {
            const box = visibleTableBox((await element(tableName)).bounds, ref.frame);
            const counter = [box[0], Math.max(0, box[1] - 70), Math.min(440, box[2]), 56];
            assert.ok(fitsCapture(counter, ref.frame), `The result count must fit entirely in the visible client area. Count=${counter}; client=${ref.frame.captureBounds}.`);
            return [box, counter];
        }
        async function documentPosition(deadline, previousBox) {
            let stable;
            do {
                const rows = (await observeRows('state', { name: documentParagraph }, deadline)).filter(row => row.type === 'ControlType.Text');
                assert.ok(rows.length <= 1, 'The exact native document paragraph is ambiguous.');
                const row = rows[0];
                if (row?.enabled) {
                    const box = unclippedNativeBox(row.bounds, ref.frame);
                    if ((!previousBox || box[1] < previousBox[1]) && box[2] >= 2 && box[3] >= 2) {
                        if (stable?.bounds === row.bounds && stable.offscreen === row.offscreen) return { box, offscreen: row.offscreen };
                        stable = row;
                    } else stable = undefined;
                } else stable = undefined;
                await sleep(visualPolicy.observationGapMs);
            } while (performance.now() < deadline);
            throw new Error(previousBox ? 'The exact paragraph did not settle higher after one guarded wheel event.' : 'The exact native document paragraph was not observed.');
        }
        function paragraphVisible(paragraph, descriptionBox) {
            return !paragraph.offscreen && fitsCapture(paragraph.box, ref.frame) && paragraph.box[1] >= descriptionBox[1] + descriptionBox[3];
        }
        async function docRois() {
            const activeDocument = await element('Perf Skill 0000', '工作区标签', 'ControlType.TabItem', true);
            assert.equal(activeDocument.selected, true, 'The exact native document workspace tab must be selected.');
            const selected = await element('说明', 'Skill 详情', 'ControlType.TabItem', true);
            assert.equal(selected.selected, true, 'The native description tab must be selected.');
            const paragraph = await documentPosition(performance.now() + visualPolicy.matchTimeoutMs);
            assert.ok(paragraphVisible(paragraph, completeCaptureBox(selected.bounds, ref.frame, 'The description tab')), 'The exact native document paragraph is not fully visible below the selected description tab.');
            return [completeCaptureBox(activeDocument.bounds, ref.frame, 'The active document tab'), paragraph.box];
        }
        async function prepareDocumentReading() {
            const deadline = performance.now() + visualPolicy.matchTimeoutMs;
            await element('Perf Skill 0000', '工作区标签', 'ControlType.TabItem', true, deadline);
            let selected = await element('说明', 'Skill 详情', 'ControlType.TabItem', true, deadline);
            let descriptionBox = completeCaptureBox(selected.bounds, ref.frame, 'The selected description tab');
            const point = boxCenter(descriptionBox);
            let paragraph = await documentPosition(deadline);
            ref.documentReading = { point, descriptionBox, initialBox: paragraph.box, steps: [] };
            while (!paragraphVisible(paragraph, descriptionBox)) {
                assert.ok(paragraph.box[1] > descriptionBox[1] + descriptionBox[3], 'The paragraph passed the visible reading area. No corrective input was sent.');
                assert.ok(ref.documentReading.steps.length < maximumDocumentWheelSteps && performance.now() < deadline, 'The unchanged observation budget or wheel safety limit was reached.');
                const input = await visual.call('scrollDocument', point);
                assert.equal(input.wheelDelta, documentWheelDelta);
                await sleep(visualPolicy.referenceSettleMs);
                paragraph = await documentPosition(deadline, paragraph.box);
                ref.documentReading.steps.push({ wheelDelta: input.wheelDelta, paragraphBox: paragraph.box });
                selected = await element('说明', 'Skill 详情', 'ControlType.TabItem', true, deadline);
                descriptionBox = completeCaptureBox(selected.bounds, ref.frame, 'The selected description tab');
            }
        }
        async function semanticList(index) {
            const deadline = performance.now() + visualPolicy.matchTimeoutMs;
            do {
                const names = await observeRows('scopeNames', { scope: '可横向滚动的 Skill 列表' }, deadline);
                const titles = names.filter(row => row.type === 'ControlType.Button' && /^Perf Skill \d{4}$/.test(row.name));
                const edit = await observeRows('state', { name: '搜索 Skill' }, deadline);
                if (edit.some(row => row.enabled && !row.offscreen) && titles.length === (index === null ? 20 : 1) &&
                    (index === null || titles[0].name === `Perf Skill ${String(index).padStart(4, '0')}`))
                    return;
                await sleep(50);
            } while (performance.now() < deadline);
            throw new Error('The native reference list did not confirm its exact expected row count and title.');
        }
        async function nativeClick(key) { await visual.call('click', ref.controls[key]); }
        const scrollLibrary = up => visual.call('scrollLibrary', { ...ref.controls.search, up });
        async function confirmInitialSearchPosition() {
            const deadline = performance.now() + visualPolicy.matchTimeoutMs;
            do {
                const edit = await element('搜索 Skill', undefined, 'ControlType.Edit');
                if (edit.bounds === initialSearchBounds) return;
                await sleep(50);
            } while (performance.now() < deadline);
            throw new Error('Clearing the candidate list did not restore the initial search position.');
        }
        async function clearSearch() {
            const clear = await element('清空搜索', undefined, 'ControlType.Button');
            assert.deepEqual(relativeBox(clear.bounds, ref.frame), ref.controls.clear.box,
                'Clear moved away from its frozen filtered position.');
            await nativeClick('clear');
            await scrollLibrary(true);
            await semanticList(null);
            await confirmInitialSearchPosition();
        }
        async function nativeSearch(index) {
            await confirmInitialSearchPosition();
            await nativeClick('search');
            await visual.call('text', { value: `perf-skill-${String(index).padStart(4, '0')}` });
            await semanticList(index);
        }
        async function capture(name, boxes, semantic) {
            await sleep(visualPolicy.referenceSettleMs);
            const rois = [];
            for (const [index, box] of boxes.entries()) {
                assert.ok(fitsCapture(box, ref.frame), `A frozen ROI leaves the visible client area in ${name}.`);
                const path = join(descriptor.root, 'references', `${name}-${index}.png`);
                await visual.call('save', { path, box });
                const sha256 = await digest(path);
                for (let count = 0; count < 2; count++) {
                    await sleep(visualPolicy.observationGapMs);
                    assert.equal((await visual.call('match', { path, box, sha256 })).matched, true, 'Reference pixels were not stable. No adaptive reference was generated.');
                }
                const expected = requiredRegions(name)[index];
                assert.ok(expected, `Unexpected extra reference ROI in ${name}.`);
                rois.push({ ...expected, path, sha256, box });
            }
            ref.states[name] = { semanticConfirmedByNativeDriver: true, semantic, rois };
        }
        referencePhase = 'initial-library';
        const initialSearchBounds = (await element('搜索 Skill', undefined, 'ControlType.Edit')).bounds;
        await point('search', '搜索 Skill', undefined, 'ControlType.Edit');
        await point('github', 'GitHub', '来源筛选');
        await point('check', '检查本地与 GitHub 变化');
        await semanticList(null);
        await capture('all', await tableRois(), 'Native initial list readiness and fixed 1000-Skill fixture.');
        for (let index = 0; index < 66; index++) {
            referencePhase = 'search-' + String(index).padStart(4, '0');
            await nativeSearch(index);
            const title = `Perf Skill ${String(index).padStart(4, '0')}`;
            const result = await element(title, '可横向滚动的 Skill 列表', 'ControlType.Button');
            if (!index) {
                if (hostedFirstSearchReceipt) {
                    const edit = await element('搜索 Skill', undefined, 'ControlType.Edit');
                    assert.equal(edit.hasKeyboardFocus, true);
                    const value = await app.call('firstSearchValue', { referenceReadBudgetMs: 12000 }, 12000);
                    assert.equal(value.matchesExpected, true);
                    assert.equal(edit.bounds, hostedFirstSearchReceipt.filteredSearchBounds);
                    assert.equal(result.bounds, hostedFirstSearchReceipt.resultBounds);
                }
                await point('clear', '清空搜索');
                await point('openDocument', 'Perf Skill 0000', '可横向滚动的 Skill 列表');
            }
            const titleBox = completeCaptureBox(result.bounds, ref.frame, title);
            await capture(`search-${String(index).padStart(4, '0')}`, [titleBox, ...await tableRois()], `Native one-row result and exact title ${title} confirmed.`);
            referencePhase = 'clear-' + referencePhase;
            await clearSearch();
        }
        referencePhase = 'github-empty';
        await nativeClick('github');
        await scrollLibrary(false);
        const emptyTitle = completeCaptureBox((await element('当前筛选无结果')).bounds, ref.frame, 'The empty filter title');
        await capture('github', [emptyTitle], 'Native GitHub filter confirmed empty result.');
        if (hostedReferenceFrame) {
            const candidates = (await observeRows('state', { name: '清除筛选' }))
                .filter(row => row.type === 'ControlType.Button' && row.enabled && !row.offscreen)
                .map(row => unclippedNativeBox(row.bounds, ref.frame))
                .filter(box => validBox(box, ref.frame) && box[1] >= emptyTitle[1] + emptyTitle[3]);
            assert.equal(candidates.length, 1, 'Expected one visible reset below the confirmed empty heading.');
            ref.controls.allFiltered = { ...boxCenter(candidates[0]), sourceName: '清除筛选', box: candidates[0] };
        } else await point('allFiltered', '全部', '来源筛选');
        referencePhase = 'restore-all-after-github';
        await nativeClick('allFiltered');
        if (hostedReferenceFrame) await waitForEmptyFilterToChange(visual, ref.states.github.rois[0]);
        await scrollLibrary(true);
        await semanticList(null);
        referencePhase = 'search-0000-before-open';
        await nativeSearch(0);
        assert.deepEqual(relativeBox((await element('Perf Skill 0000', '可横向滚动的 Skill 列表', 'ControlType.Button')).bounds, ref.frame), ref.controls.openDocument.box);
        referencePhase = 'verify-visible-open-document';
        await nativeClick('openDocument');
        await prepareDocumentReading();
        referencePhase = 'locate-workbench-tab';
        const names = await observeRows('scopeNames', { scope: '工作区标签' });
        const homeNames = names.filter(row => row.type === 'ControlType.TabItem' && (row.name === '工作台' || row.name.startsWith('工作台 '))).map(row => row.name);
        assert.equal(homeNames.length, 1);
        await point('homeTab', homeNames[0], '工作区标签', 'ControlType.TabItem');
        const documentBox = await point('documentTab', 'Perf Skill 0000', '工作区标签', 'ControlType.TabItem');
        await point('closeDocument', '关闭 Perf Skill 0000');
        referencePhase = 'capture-document';
        await capture('document', await docRois(), 'Native document title, active description tab and fixture paragraph confirmed.');
        referencePhase = 'capture-home-with-document';
        await nativeClick('homeTab');
        await semanticList(0);
        assert.equal((await element(homeNames[0], '工作区标签', 'ControlType.TabItem', true)).selected, true);
        await capture('homeDocument', await tableRois(), 'Native home tab returned to search 0000.');
        referencePhase = 'capture-reactivated-document-tab';
        await nativeClick('documentTab');
        assert.equal((await element('Perf Skill 0000', '工作区标签', 'ControlType.TabItem', true)).selected, true);
        const returned = await docRois();
        const frozenParagraph = ref.states.document.rois[1];
        ref.documentReading.returnedBox = returned[1];
        assert.deepEqual(returned[1], frozenParagraph.box, 'The exact paragraph moved when returning to the already-open detail.');
        assert.equal((await visual.call('match', frozenParagraph)).matched, true, 'The original paragraph pixels were not retained when returning to the detail.');
        await capture('documentTab', returned, 'Native detail tab became active with the same document reading position and pixels.');
        referencePhase = 'capture-closed-document';
        await nativeClick('closeDocument');
        await semanticList(0);
        assert.equal((await observeRows('state', { name: '关闭 Perf Skill 0000' })).length, 0);
        await capture('closed', [...await tableRois(), documentBox], 'Native detail tab closure and home search confirmed.');
        await clearSearch();
        referencePhase = 'create-and-verify-review-sheets';
        ref.reviewSheets = [];
        const reviewCrops = Object.entries(ref.states).flatMap(([name, state]) => state.rois.map(roi => ({ name: `${name} ${roi.role}`, path: roi.path })));
        for (let index = 0; index < reviewCrops.length; index += 24) {
            const crops = reviewCrops.slice(index, index + 24);
            const path = join(descriptor.root, 'references', `review-${String(index / 24 + 1).padStart(2, '0')}.png`);
            await visual.call('sheet', { path, names: crops.map(crop => crop.name), paths: crops.map(crop => crop.path) });
            ref.reviewSheets.push({ path, sha256: await digest(path), crops });
        }
        await visual.finish();
        visual = null;
        await closeReferenceApp();
        ref.semanticReferencePhaseCompleted = true;
        validateReferences(ref, descriptor);
        await writeFile(join(descriptor.root, 'visual-references.json'), json(ref), { flag: 'wx' });
        console.log(json({ status: 'references-generated-review-required', path: join(descriptor.root, 'visual-references.json'), referenceCount: requiredStates.length, visualApprovalRequired: true, pilotRequired: true }));
    }
    catch (error) {
        failure = error;
        throw error;
    }
    finally {
        const cleanupErrors = [];
        if (visual)
            await visual.finish().catch(error => cleanupErrors.push(error.message));
        if (app)
            await closeReferenceApp().catch(error => cleanupErrors.push(error.message));
        if (savedTemp === undefined)
            delete process.env.TEMP;
        else
            process.env.TEMP = savedTemp;
        if (savedTmp === undefined)
            delete process.env.TMP;
        else
            process.env.TMP = savedTmp;
        if (failure)
            await writeFile(join(descriptor.root, 'reference-failure.json'), json({ status: 'failed-references', error: failure.message, referencePhase, lastRead, captureBounds: ref.frame?.captureBounds, documentReading: ref.documentReading, completedStates: Object.keys(ref.states), exitEvidence, cleanupErrors }), { flag: 'wx' });
    }
}
function retainedCheckHistory(dataset, checks) {
    const db = new DatabaseSync(dataset.dbPath, { readOnly: true });
    try {
        const get = db.prepare('SELECT payload FROM task_history WHERE id = ?');
        const keys = checks.map(({ taskId }) => {
            const row = JSON.parse(get.get(taskId)?.payload ?? 'null');
            assert.ok(row, 'One measured check was absent from durable history.');
            assert.equal(row.id, taskId);
            assert.equal(row.action, 'check_now');
            assert.equal(row.status, 'succeeded');
            assert.ok(Array.isArray(row.resources) && row.resources.length > 0);
            assert.ok(row.resources.every(key => typeof key === 'string'));
            return row.resources;
        });
        assert.equal(new Set(keys.map(row => hash(json(row)))).size, 1, 'The repeated fixture checks did not reach an identical ordered lock set.');
        assert.equal(keys[0].length, 2 * dataset.skillCount + 2, 'The global check did not lock every fixture Skill and its directory.');
        const fixtureRoot = dataset.root.replaceAll('/', '\\').toLowerCase();
        const normalized = keys[0].map(key => key.toLowerCase().replaceAll('/', '\\').replace(fixtureRoot, '<fixture>'));
        assert.equal(normalized.filter(key => key.startsWith('directory:<fixture>\\skills\\')).length, dataset.skillCount);
        assert.equal(normalized.filter(key => key.startsWith('skill:perf-skill-')).length, dataset.skillCount);
        return { jobs: keys.length, keysPerJob: keys[0].length, normalizedKeySha256: hash(json(normalized)) };
    }
    finally { db.close(); }
}

async function run(descriptor, pilot, shortRetention = false) {
    const root = descriptor.root, refPath = join(root, 'visual-references.json');
    await ordinary(refPath);
    await ordinary(join(root, 'visual-approval.json'));
    const approvalPath = join(root, 'visual-approval.json');
    const refBytes = await readFile(refPath), ref = JSON.parse(refBytes);
    if (shortRetention) {
        assert.equal(process.env.GITHUB_ACTIONS, 'true');
        assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
        assert.equal(process.env.GITHUB_REF_NAME, 'codex/hosted-short-history-pair-r2-930ec22-20261121');
        assert.ok(hostedRetentionReference);
        assert.equal(hash(refBytes), hostedRetentionReference.sha256);
    }
    validateReferences(ref, descriptor, shortRetention ? hostedRetentionReference : null);
    if (!shortRetention) assert.deepEqual(ref.sources, descriptor.sources);
    const approvalBytes = await readFile(approvalPath), approval = JSON.parse(approvalBytes);
    assert.equal(approval.referenceSha256, hash(refBytes));
    assert.equal(approval.reviewedBy, 'root');
    assert.equal(approval.visualReviewConfirmed, true);
    assert.deepEqual(approval.reviewedStates, requiredStates, 'Every frozen state must receive explicit visual review before any run.');
    if (!pilot && !shortRetention) {
        await ordinary(join(root, 'pilot-result.json'));
        const result = JSON.parse(await readFile(join(root, 'pilot-result.json'), 'utf8'));
        assert.equal(result.status, 'pilot-passed');
        assert.equal(result.normalExit, true);
        assert.equal(result.referenceSha256, hash(refBytes));
        assert.equal(result.runtimeAndSourcesPreserved, true);
    }
    for (const state of Object.values(ref.states))
        for (const roi of state.rois) {
            if (shortRetention)
                roi.path = join(root, relative(hostedRetentionReference.root, roi.path));
            await ordinary(roi.path);
            assert.equal(await digest(roi.path), roi.sha256);
        }
    const name = shortRetention ? 'retention-short' : pilot ? 'pilot' : 'stability', reportPath = join(root, name + '-result.json');
    await writeFile(join(root, name + '-owner.json'), json({ referenceSha256: hash(refBytes) }), { flag: 'wx' });
    await mkdir(join(root, 'temp'), { recursive: true });
    const env = environment(root);
    const report = { format, mode: name, status: 'running', startedAt: new Date().toISOString(), candidateSha256, transportSha256, descriptorPath: join(root, 'visual-dataset.json'), datasetFingerprint: descriptor.dataset.dataFingerprint, referenceSha256: hash(refBytes), approvalSha256: hash(approvalBytes), visualApproval: approval, policy: PERFORMANCE_POLICY, visualPolicy, measurementsUseAccessibility: false, capture: 'foreground-owned-CopyFromScreen', calibration: [], samples: [], cycles: [], checks: [], actions: [], normalExit: false, limitations: ['Visual state checks cover frozen visible ROIs, not hidden AX/DOM counts. Unicode search injection is not IME evidence. Previous UIA convergence failure remains retained. Normal Quit happens after sampling.'] };
    const save = () => writeFile(reportPath, json(report));
    let child, exit, identity, visual, baseline;
    try {
        const ownership = await assertNoUserManager({ transportSha256 });
        assert.ok(ownership.managers.every(process => process.role === 'mcpTransport'), 'Only verified formal MCP transports may already exist.');
        child = spawn(executable, ['--data-dir', descriptor.dataset.dataDir], { env, cwd: dirname(executable), stdio: 'ignore' });
        child.on('exit', (code, signal) => { exit = { code, signal }; });
        await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); });
        report.pid = child.pid;
        await save();
        for (const deadline = performance.now() + 30000; performance.now() < deadline;) {
            try {
                const value = await observe(descriptor, { pid: child.pid }, env, 'status');
                identity = value.identity;
                break;
            }
            catch (error) {
                if (exit || error.observationType !== 'TimeoutException')
                    throw error;
                await sleep(100);
            }
        }
        assert.ok(identity, 'Owner-checked backend readiness failed.');
        visual = await VisualSession.attach(identity, descriptor, env, ref.frame);
        for (const field of ['left', 'top', 'width', 'height', 'dpi'])
            assert.equal(visual.identity[field], ref.frame[field], `Frozen window ${field} changed.`);
        assert.deepEqual(visual.identity.captureBounds, ref.frame.captureBounds, 'The frozen visible client geometry changed.');
        await visual.call('prepareForeground');
        report.identity = visual.identity;
        baseline = protectedData(descriptor.dataset);
        async function waitState(name, role) {
            const rois = ref.states[name].rois.filter(roi => !role || roi.role === role);
            assert.ok(rois.length > 0, 'The pre-scroll readiness ROI must be present in the verified reference.');
            const deadline = performance.now() + visualPolicy.matchTimeoutMs;
            let consecutive = 0;
            while (performance.now() < deadline) {
                let allMatch = true;
                for (const roi of rois) {
                    const remaining = Math.floor(deadline - performance.now());
                    if (remaining < 1) throw new Error(`Frozen visible state ${name} exceeded its observation deadline.`);
                    if (!(await visual.call('match', roi, remaining)).matched) allMatch = false;
                }
                if (performance.now() >= deadline) break;
                consecutive = allMatch ? consecutive + 1 : 0;
                if (consecutive === visualPolicy.stableObservations) return;
                await sleep(Math.min(visualPolicy.observationGapMs, deadline - performance.now()));
            }
            throw new Error(`Frozen visible state ${name} did not match. References were not adapted.`);
        }
        async function click(key) { const result = await visual.call('click', ref.controls[key]); report.actions.push({ key, result }); }
        async function scrollLibrary(up) { const result = await visual.call('scrollLibrary', { ...ref.controls.search, up }); report.actions.push({ key: 'scrollLibrary', result }); }
        async function search(index) { await click('search'); await visual.call('text', { value: `perf-skill-${String(index).padStart(4, '0')}` }); await waitState(`search-${String(index).padStart(4, '0')}`); }
        async function cycle(index) { for (const [action, value] of cycleActions(index)) {
            if (action === 'search')
                await search(value);
            else if (action === 'clear') {
                await click('clear');
                await scrollLibrary(true);
                await waitState('all');
            }
            else if (action === 'filter') {
                await click(value ? 'github' : 'allFiltered');
                if (!value && hostedReferenceFrame) await waitForEmptyFilterToChange(visual, ref.states.github.rois[0]);
                await scrollLibrary(!value);
                await waitState(value ? 'github' : 'all');
            }
            else if (action === 'document') {
                await click('openDocument');
                await waitState('document', 'active-document-tab');
                for (const [index, step] of ref.documentReading.steps.entries()) {
                    const result = await visual.call('scrollDocument', ref.documentReading.point);
                    assert.equal(result.wheelDelta, step.wheelDelta);
                    report.actions.push({ key: 'scrollDocument', step: index + 1, result });
                    await sleep(visualPolicy.referenceSettleMs);
                }
                await waitState('document');
            }
            else if (action === 'tab') {
                await click(value ? 'homeTab' : 'documentTab');
                await waitState(value ? 'homeDocument' : 'documentTab');
            }
            else {
                await click('closeDocument');
                await waitState('closed');
            }
        } report.cycles.push({ index, completedAt: new Date().toISOString() }); }
        async function check() { const before = await observe(descriptor, identity, env, 'tasks'), known = new Set(before.tasks.map(task => task.id)); await click('check'); const deadline = performance.now() + 20000; for (;;) {
            const value = await observe(descriptor, identity, env, 'tasks'), added = value.tasks.filter(task => !known.has(task.id) && task.action === 'check_now');
            assert.ok(added.length <= 1, 'The check click created multiple matching tasks.');
            if (added.length === 1) {
                report.checks.push({ taskId: added[0].id, action: added[0].action, initialStatus: added[0].status, observedAt: new Date().toISOString() });
                return;
            }
            if (performance.now() >= deadline)
                throw new Error('The check task was not observed. The click was not replayed.');
            await sleep(30);
        } }
        async function sample(elapsedMs) { const deadline = performance.now() + 60000; for (;;) {
            const value = await observe(descriptor, identity, env, 'tasks');
            if (!value.tasks.some(task => ['running', 'queued'].includes(task.status)))
                break;
            assert.ok(performance.now() < deadline, 'Active tasks prevent an idle sample.');
            await sleep(50);
        } const raw = await observe(descriptor, identity, env, 'sample'), current = await visual.call('identity'); assert.equal(raw.inputTickBefore, current.lastInputTick); assert.equal(raw.lastInputTick, current.lastInputTick); return { ...idleObservation(raw, identity, cpus().length), elapsedMs, observedAt: new Date().toISOString() }; }
        await waitState('all');
        if (shortRetention) {
            report.shortRetentionPolicy = shortRetentionPolicy;
            report.limitations.push('Short same-host diagnostic only. No result from this mode can pass or replace the 61-point convergence gate.');
            await cycle(0);
            const start = performance.now();
            report.samples.push(await sample(0));
            for (let index = 1; index <= shortRetentionPolicy.cycles; index++) {
                await sleep(start + index * shortRetentionPolicy.intervalMs - performance.now());
                await check();
                await cycle(index);
                const value = await sample(0);
                value.elapsedMs = performance.now() - start;
                report.samples.push(value);
                await save();
                console.log(json({ phase: 'retention-short', sample: index, of: shortRetentionPolicy.cycles }).trim());
            }
            await sleep(shortRetentionPolicy.cooldownMs);
            const tail = await sample(0);
            tail.elapsedMs = performance.now() - start;
            report.samples.push(tail);
            assert.equal(new Set(report.checks.map(check => check.taskId)).size, shortRetentionPolicy.cycles);
            report.history = retainedCheckHistory(descriptor.dataset, report.checks);
            report.status = 'short-operations-completed';
        }
        else if (pilot) {
            for (let index = 0; index < 2; index++) {
                if (!index)
                    await check();
                await cycle(index);
            }
            report.pilotIdleSample = await sample(0);
            report.status = 'pilot-operations-completed';
        }
        else {
            for (let index = 0; index < PERFORMANCE_POLICY.warmupCycles; index++)
                await cycle(index);
            await sleep(visualPolicy.preparationIdleMs);
            const calibrationStart = performance.now();
            for (let index = 0; index < PERFORMANCE_POLICY.idleCalibrationSamples; index++) {
                await sleep(calibrationStart + index * PERFORMANCE_POLICY.sampleIntervalMs - performance.now());
                report.calibration.push(await sample(performance.now() - calibrationStart));
                await save();
                console.log(json({ phase: 'visual-calibration', sample: index + 1 }).trim());
            }
            report.bounds = freezeConvergenceBounds(report.calibration);
            await writeFile(join(root, 'visual-bounds-before-samples.json'), json(report.bounds), { flag: 'wx' });
            let start = performance.now();
            for (let index = 0; index <= PERFORMANCE_POLICY.stabilityDurationMs / PERFORMANCE_POLICY.sampleIntervalMs; index++) {
                await sleep(start + index * PERFORMANCE_POLICY.sampleIntervalMs - performance.now());
                if (index % 2 === 0)
                    await check();
                await cycle(index + PERFORMANCE_POLICY.warmupCycles);
                const value = await sample(0);
                value.elapsedMs = performance.now() - start;
                if (!index) {
                    start = performance.now();
                    value.elapsedMs = 0;
                }
                report.samples.push(value);
                await save();
                console.log(json({ phase: 'visual-stability', sample: index + 1, of: 61, privateMiB: value.privateBytes / 1048576 }).trim());
            }
            report.verdict = stabilityVerdict(report.samples, report.bounds, PERFORMANCE_POLICY.warmupCycles);
            report.status = report.verdict.status === 'passed' ? 'visual-stability-passed' : 'visual-stability-failed';
            if (report.verdict.status !== 'passed')
                process.exitCode = 1;
        }
    }
    catch (error) {
        report.status = 'failed-or-blocked';
        report.error = error.message;
        process.exitCode = 1;
    }
    finally {
        if (visual)
            await visual.finish().catch(error => { report.driverExitError = error.message; report.status = 'failed-or-blocked'; process.exitCode = 1; });
        if (child && !exit) {
            await save();
            console.log(json({ phase: 'ready-for-owned-normal-quit', pid: child.pid, creationFileTime: identity?.creationFileTime, executable, reportPath, waitMs: visualPolicy.normalQuitWaitMs }).trim());
            for (const deadline = performance.now() + visualPolicy.normalQuitWaitMs; !exit && performance.now() < deadline;)
                await sleep(100);
        }
        report.exit = exit || null;
        report.normalExit = exit?.code === 0;
        if (child && !exit)
            child.unref();
        if (!report.normalExit) {
            report.status = 'failed-or-blocked';
            process.exitCode = 1;
        }
        try {
            if (baseline) {
                assert.deepEqual(protectedData(descriptor.dataset), baseline);
                report.managementDataPreserved = true;
            }
            assert.deepEqual(await runtimeFiles(descriptor.dataset), descriptor.runtimeFiles);
            assert.deepEqual(await sources(), descriptor.sources);
            assert.equal(await digest(executable), candidateSha256);
            assert.equal(await digest(refPath), hash(refBytes));
            assert.equal(await digest(approvalPath), hash(approvalBytes));
            report.runtimeAndSourcesPreserved = true;
        }
        catch (error) {
            report.integrityError = error.message;
            report.status = 'failed-or-blocked';
            process.exitCode = 1;
        }
        if (pilot && report.status === 'pilot-operations-completed' && report.normalExit && report.runtimeAndSourcesPreserved)
            report.status = 'pilot-passed';
        if (shortRetention && report.status === 'short-operations-completed' && report.normalExit && report.runtimeAndSourcesPreserved && report.managementDataPreserved)
            report.status = 'retention-short-completed';
        report.finishedAt = new Date().toISOString();
        await save();
        console.log(json({ status: report.status, reportPath, normalExit: report.normalExit, previousFailureReplaced: false }));
    }
}
async function main() { const selected = options(process.argv.slice(2)); if (selected.mode === '--help') {
    console.log('Prepare --prepare. Generate actual AX-confirmed image references with --references <visual-dataset.json>. Root must visually review every ROI and author visual-approval.json bound to the reference SHA. Run --pilot <dataset>, normally quit after its sampling signal, then --run <dataset>. Sampling uses native input and exact visible image comparisons without AX. Original thirty-minute criteria are unchanged.');
    return;
} if (selected.mode === '--prepare')
    return prepare(); const descriptor = await descriptorAt(selected.path); if (selected.mode === '--references')
    return references(descriptor); return run(descriptor, selected.mode === '--pilot', selected.mode === '--short-retention'); }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
