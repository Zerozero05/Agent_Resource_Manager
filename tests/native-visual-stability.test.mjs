import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { options, inside, validBox, validateReferences, requiredStates, requiredRegions, visualPolicy, cycleActions, visualObserverSource, VisualSession } from '../scripts/verify-native-visual-stability.mjs';
import { IDLE_OBSERVER } from '../scripts/diagnose-native-idle-memory.mjs';
const validation = 'D:/03_github_projects/Agent_Management/Agent_Resource_Manager/validation/manager-data';
const root = validation + '/native-visual-pure';
const descriptor = { root, dataset: { dataFingerprint: 'fixed' } };
for (const [label, file, argumentName] of [
    ['frame', 'verify-native-frame.mjs', 'options'],
    ['maintenance', 'verify-native-maintenance.mjs', 'args'],
]) {
    test(`${label} transport CLI rejects malformed identity before fixture or candidate access`, async () => {
        const script = fileURLToPath(new URL(`../scripts/${file}`, import.meta.url));
        const execute = promisify(execFile);
        for (const args of [
            ['--transport-file-sha256'], ['--transport-file-sha256', ''],
            ['--transport-file-sha256', 'invalid'], ['--transport-file-sha256', 'a'.repeat(63)],
            ['--transport-file-sha256', 'a'.repeat(65)], ['--transport-file-sha256', 'g'.repeat(64)],
            ['--transport-file-sha256', '--phase', 'prepare'], ['--phase', 'prepare', '--transport-file-sha256'],
        ]) {
            await assert.rejects(execute(process.execPath, [script, ...args], { windowsHide: true, timeout: 5000 }), error => {
                assert.equal(error.code, 1); assert.equal(error.stdout, '');
                assert.match(error.stderr, /transport-file-sha256 requires one exact SHA256 digest/);
                return true;
            });
        }
        const runner = await readFile(script, 'utf8');
        const check = runner.indexOf(`Object.hasOwn(${argumentName}, 'transport-file-sha256')`);
        assert.ok(check >= 0 && check < runner.indexOf('async function prepare('));
        assert.ok(check < runner.indexOf('await writeFile('));
    });

    test(`${label} transport CLI preserves candidate identity and forwards the distinct stdio hash`, async () => {
        const script = fileURLToPath(new URL(`../scripts/${file}`, import.meta.url));
        const execute = promisify(execFile);
        for (const args of [['--help'], ['--help', '--transport-file-sha256', 'A'.repeat(64)]]) {
            const result = await execute(process.execPath, [script, ...args], { windowsHide: true, timeout: 5000 });
            assert.match(result.stdout, /transport-file-sha256 <64hex>/);
            assert.doesNotMatch(result.stdout, /prepared-not-run/);
        }
        const runner = await readFile(script, 'utf8');
        const start = runner.indexOf(`if (Object.hasOwn(${argumentName}, 'transport-file-sha256')`);
        const end = runner.indexOf('\n', runner.indexOf('const requestedTransportSha256 = ', start));
        assert.ok(start >= 0 && end > start);
        const validate = new Function(argumentName, runner.slice(start, end) + '; return requestedTransportSha256;');
        assert.equal(validate({}), undefined);
        assert.equal(validate({ 'transport-file-sha256': 'A'.repeat(64) }), 'a'.repeat(64));
        for (const digest of [undefined, null, true, false, 1, {}, [], 'a'.repeat(63), 'a'.repeat(65)]) {
            assert.throws(() => validate({ 'transport-file-sha256': digest }), /requires one exact SHA256 digest/);
        }
        assert.match(runner, /const transportSha256 = requestedTransportSha256 \|\| info\.sha256;/);
        assert.match(runner, /candidate: info, transportFileSha256: transportSha256/);
        const launches = runner.match(/NativeUiaSession\.launch\(\{[^\n]+\}\)/g);
        assert.equal(launches?.length, 1);
        assert.match(launches[0], /sha256: info\.sha256/);
        assert.match(launches[0], /\btransportSha256\b/);
    });
}
test('native tools reject a missing, invalid or duplicate transport digest before preparing fixtures', async () => {
    const script = fileURLToPath(new URL('../scripts/verify-native-tools.mjs', import.meta.url));
    const execute = promisify(execFile);
    const flag = '--transport-file-sha256';
    for (const args of [[flag], [flag, ''], [flag, 'g'.repeat(64)], [flag, 'a'.repeat(63)], [flag, 'a'.repeat(64), flag, 'b'.repeat(64)]]) {
        await assert.rejects(execute(process.execPath, [script, '--prepare', ...args], { windowsHide: true, timeout: 5000 }), error => {
            assert.equal(error.code, 1); assert.equal(error.stdout, '');
            assert.match(error.stderr, /transport-file-sha256 requires one exact SHA256 digest/);
            return true;
        });
    }
    const runner = await readFile(script, 'utf8');
    const validation = runner.indexOf('transportFlags > 1');
    assert.ok(validation >= 0 && validation < runner.indexOf('await mkdir(approved'));
});

test('native tools keep the candidate digest separate from an explicitly supplied transport digest', async () => {
    const script = fileURLToPath(new URL('../scripts/verify-native-tools.mjs', import.meta.url));
    const execute = promisify(execFile);
    for (const args of [['--help'], ['--help', '--transport-file-sha256', 'A'.repeat(64)]]) {
        const result = await execute(process.execPath, [script, ...args], { windowsHide: true, timeout: 5000 });
        assert.match(result.stdout, /transport-file-sha256 <64hex>/);
    }
    const runner = await readFile(script, 'utf8');
    assert.match(runner, /const requestedTransportSha256 = transportInput\?\.toLowerCase\(\);/);
    assert.match(runner, /const transportSha256 = requestedTransportSha256 \|\| report\.candidate\.sha256;/);
    assert.match(runner, /report\.transportFileSha256 = transportSha256;/);
    const launches = runner.match(/NativeUiaSession\.launch\(\{[^\n]+\}\)/g);
    assert.equal(launches?.length, 1);
    assert.match(launches[0], /sha256: report\.candidate\.sha256, transportSha256,/);
});

test('appearance transport CLI rejects missing or malformed digests before preparation or candidate reads', async () => {
    const script = fileURLToPath(new URL('../scripts/verify-native-appearance-copy.mjs', import.meta.url));
    const execute = promisify(execFile);
    for (const args of [
        ['--transport-file-sha256'],
        ['--transport-file-sha256', ''],
        ['--transport-file-sha256', 'invalid'],
        ['--transport-file-sha256', 'a'.repeat(63)],
        ['--transport-file-sha256', 'a'.repeat(65)],
        ['--transport-file-sha256', 'g'.repeat(64)],
        ['--transport-file-sha256', '--phase', 'prepare'],
        ['--phase', 'prepare', '--transport-file-sha256'],
    ]) {
        await assert.rejects(execute(process.execPath, [script, ...args], { windowsHide: true, timeout: 5000 }), error => {
            assert.equal(error.code, 1);
            assert.equal(error.stdout, '');
            assert.match(error.stderr, /transport-file-sha256 requires one exact SHA256 digest/);
            return true;
        });
    }
    const runner = await readFile(script, 'utf8');
    assert.ok(runner.indexOf("Object.hasOwn(options, 'transport-file-sha256')") < runner.indexOf('async function prepare()'));
    assert.ok(runner.indexOf("Object.hasOwn(options, 'transport-file-sha256')") < runner.indexOf('await writeFile('));
});

test('appearance transport CLI retains the default and wires distinct transport identity to both native launches', async () => {
    const script = fileURLToPath(new URL('../scripts/verify-native-appearance-copy.mjs', import.meta.url));
    const execute = promisify(execFile);
    for (const args of [['--help'], ['--help', '--transport-file-sha256', 'A'.repeat(64)]]) {
        const result = await execute(process.execPath, [script, ...args], { windowsHide: true, timeout: 5000 });
        assert.match(result.stdout, /transport-file-sha256 <64hex>/);
    }
    const runner = await readFile(script, 'utf8');
    assert.match(runner, /const requestedTransportSha256 = options\['transport-file-sha256'\]\?\.toLowerCase\(\);/);
    assert.match(runner, /const transportSha256 = requestedTransportSha256 \|\| info\.sha256;/);
    assert.match(runner, /candidate: info, transportFileSha256: transportSha256, fixture: descriptorPath/);
    assert.equal([...runner.matchAll(/NativeUiaSession\.launch\(\{[^\n]+sha256: info\.sha256, transportSha256, accessibilityInput: true \}\)/g)].length, 2);
});

test('visual requests use one JSON line for the PowerShell ReadLine protocol', async () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let requestLine;
    child.stdin = { write(line) { requestLine = line; }, end() {} };
    const session = new VisualSession(child);
    const fields = { path: 'D:\\fixture\\a.png', names: ['first\nsecond', '中文'] };
    const result = session.call('sheet', fields);
    assert.ok(requestLine.endsWith('\n'));
    assert.equal(requestLine.indexOf('\n'), requestLine.length - 1);
    assert.deepEqual(JSON.parse(requestLine), { id: 1, op: 'sheet', ...fields });
    child.stdout.write(JSON.stringify({ id: 1, ok: true, value: { saved: true } }) + '\n');
    assert.deepEqual(await result, { saved: true });
    child.stdout.end();
    child.stderr.end();
});
function reference() {
    const boxes = { 'result-table': [100, 140, 600, 400], 'result-count': [100, 70, 440, 56], 'result-title': [110, 170, 160, 30], 'closed-tab-slot': [160, 15, 100, 30], 'active-document-tab': [160, 15, 100, 30] };
    return { format: 'agent-resource-manager-native-visual-stability-v1', root, datasetFingerprint: 'fixed', candidateSha256: '9436a75a4cf40316f80702e43c7b4da35067ec9e16a0ce592846599433e9b1aa', semanticReferencePhaseCompleted: true, capture: 'foreground-owned-CopyFromScreen', frame: { left: 60, top: 60, width: 1296, height: 889, dpi: 96 }, policy: visualPolicy,
        documentReading: { point: { x: 125, y: 85 }, descriptionBox: [100, 70, 50, 30], initialBox: [100, 940, 50, 30],
            steps: [{ wheelDelta: -120, paragraphBox: [100, 820, 50, 30] }, { wheelDelta: -120, paragraphBox: [100, 140, 50, 30] }],
            returnedBox: [100, 140, 50, 30] },
        controls: Object.fromEntries(['search', 'clear', 'github', 'allFiltered', 'openDocument', 'homeTab', 'documentTab', 'closeDocument', 'check'].map(name => [name, { x: 30, y: 30 }])),
        states: Object.fromEntries(requiredStates.map(name => [name, { semanticConfirmedByNativeDriver: true, rois: requiredRegions(name).map(region => ({ ...region, box: [...(boxes[region.role] || [100, 140, 50, 30])], path: root + '/references/' + name + '-' + region.role + '.png', sha256: 'a'.repeat(64) })) }])) };
}
test('visual modes are explicit and reject implicit or extra arguments', () => {
    for (const mode of ['--prepare', '--help'])
        assert.equal(options([mode]).mode, mode);
    for (const mode of ['--references', '--pilot', '--run'])
        assert.equal(options([mode, 'fixed']).path, 'fixed');
    for (const args of [[], ['--run'], ['--references'], ['--pilot'], ['--prepare', 'extra'], ['--unknown'], ['--run', 'fixed', 'extra']])
        assert.throws(() => options(args));
});
test('all 66 distinct searches and six shared states are mandatory', () => {
    assert.equal(requiredStates.length, 72);
    assert.equal(new Set(requiredStates).size, 72);
    assert.equal(requiredStates[0], 'search-0000');
    assert.equal(requiredStates[65], 'search-0065');
    assert.equal(validateReferences(reference(), descriptor), true);
    const missing = reference();
    delete missing.states['search-0017'];
    assert.throws(() => validateReferences(missing, descriptor));
});
test('every state has exactly its original ordered ROI roles and semantic source keys', () => {
    const value = reference();
    assert.equal(Object.values(value.states).reduce((total, state) => total + state.rois.length, 0), 210);
    for (const name of requiredStates) {
        const expected = name.startsWith('search-') ? 3 : ['all', 'homeDocument', 'document', 'documentTab'].includes(name) ? 2 : name === 'closed' ? 3 : 1;
        assert.equal(value.states[name].rois.length, expected);
        for (const index of value.states[name].rois.keys()) {
            const missing = reference();
            missing.states[name].rois.splice(index, 1);
            assert.throws(() => validateReferences(missing, descriptor), /Missing, replaced or reordered/);
        }
    }
    assert.throws(() => requiredRegions('search-0066'), /Unknown visual reference state/);
});
test('result counters and titles cannot lose or replace their source names, roles or frozen geometry', () => {
    for (const change of [
        r => { r.controls.all = r.controls.allFiltered; delete r.controls.allFiltered; },
        r => { delete r.states['search-0017'].rois[0].role; },
        r => { delete r.states['search-0017'].rois[0].source.name; },
        r => { r.states['search-0017'].rois[0].source.name = 'Perf Skill 0018'; },
        r => { r.states['search-0017'].rois[0].source.scope = '来源筛选'; },
        r => { r.states['search-0017'].rois[0].box = [20, 20, 160, 30]; },
        r => { r.states['search-0017'].rois[2] = r.states['search-0017'].rois[1]; },
        r => { delete r.states.all.rois[1].source; },
        r => { delete r.states.all.rois[1].source.name; },
        r => { r.states.all.rois[1].source.name = '搜索 Skill'; },
        r => { r.states.all.rois[1].source.topOffset = -10; },
        r => { r.states.all.rois[1].box[1] += 1; },
        r => { r.states.all.rois.reverse(); },
        r => { r.states.document.rois.push(r.states.document.rois[0]); },
        r => { r.states.document.rois[0].source.name = 'Perf Skill 0001'; },
        r => { delete r.states.document.rois[0].source.scope; },
        r => { r.states.documentTab.rois[0].source.selected = false; },
    ]) {
        const value = reference();
        change(value);
        assert.throws(() => validateReferences(value, descriptor));
    }
});
test('document references bind the exact selected workspace title and the loaded paragraph', async () => {
    for (const name of ['document', 'documentTab']) {
        const regions = requiredRegions(name);
        assert.deepEqual(regions.map(region => region.role), ['active-document-tab', 'document-paragraph']);
        assert.deepEqual(regions[0].source, { kind: 'native-element', name: 'Perf Skill 0000', scope: '工作区标签', type: 'ControlType.TabItem', selected: true });
        assert.equal(regions[1].source.name, '仅用于隔离的本地性能验收，不调用外部程序，不连接远端。');
    }
    const source = await readFile(new URL('../scripts/verify-native-visual-stability.mjs', import.meta.url), 'utf8');
    const document = source.slice(source.indexOf('async function docRois()'), source.indexOf('async function semanticList('));
    assert.match(document, /element\('Perf Skill 0000', '工作区标签', 'ControlType.TabItem', true\)/);
    assert.match(document, /activeDocument\.selected, true/);
    assert.match(document, /relativeBox\(activeDocument\.bounds, ref\.frame\)/);
    assert.match(document, /documentPosition\(performance\.now\(\) \+ visualPolicy\.matchTimeoutMs\)/);
    assert.match(document, /paragraphVisible\(paragraph,/);
});
test('the owned document wheel path and restored reading position must bind to both paragraph crops', () => {
    assert.equal(validateReferences(reference(), descriptor), true);
    for (const change of [
        value => { delete value.documentReading; },
        value => { value.documentReading.point.y++; },
        value => { value.documentReading.steps[0].wheelDelta = 120; },
        value => { value.documentReading.steps[0].paragraphBox[1] = 950; },
        value => { value.documentReading.steps.pop(); },
        value => { value.documentReading.returnedBox[1]++; },
        value => { value.states.documentTab.rois[1].box[1]++; },
    ]) {
        const value = reference();
        change(value);
        assert.throws(() => validateReferences(value, descriptor));
    }
});
test('image matching is exact and rejects modified policies, missing review semantics and escaped ROIs', () => {
    for (const change of [r => { r.policy = { ...visualPolicy, match: 'tolerant' }; }, r => { r.semanticReferencePhaseCompleted = false; }, r => { r.states.all.semanticConfirmedByNativeDriver = false; }, r => { r.states.all.rois[0].box = [0, 0, 2000, 100]; }, r => { r.states.all.rois[0].path = 'D:/outside.png'; }, r => { r.states.all.rois[0].sha256 = 'bad'; }, r => { r.controls.search.x = -1; }, r => { r.datasetFingerprint = 'other'; }]) {
        const value = reference();
        change(value);
        assert.throws(() => validateReferences(value, descriptor));
    }
});
test('ROI guards reject fractional, oversized, empty and out-of-window boxes', () => {
    const frame = { width: 1296, height: 889 };
    assert.equal(validBox([0, 0, 1296, 889], frame), true);
    for (const box of [null, [], [-1, 0, 2, 2], [0, 0, 0, 10], [1.5, 1, 2, 2], [1295, 1, 2, 2], [1, 888, 2, 2]])
        assert.equal(validBox(box, frame), false);
    assert.equal(inside(root + '/references/a.png', root), true);
    assert.equal(inside(root + '-sibling/a.png', root), false);
});
test('native cycles preserve search, clear, both filters, document and both tabs in original order', () => {
    assert.deepEqual(cycleActions(65), [['search', 65], ['clear'], ['filter', true], ['filter', false], ['search', 0], ['document'], ['tab', true], ['tab', false], ['close'], ['clear']]);
    for (const value of [-1, 66, 1.5, null])
        assert.throws(() => cycleActions(value));
});
test('the existing idle observer remains unchanged and the derived task mode is fixed read-only', () => {
    const before = IDLE_OBSERVER, value = visualObserverSource();
    assert.equal(IDLE_OBSERVER, before);
    assert.match(value, /ValidateSet\('status','sample','compile','tasks'\)/);
    assert.match(value, /Read\(\$Spec,'task_list'\)/);
    assert.doesNotMatch(value, /Windows\.Automation|UIAutomationClient|PrintWindow/);
});
test('the runtime driver uses screen copies and retains native process, input, window and file protections', async () => {
    const ps = await readFile(new URL('../scripts/native-visual-input.ps1', import.meta.url), 'utf8');
    for (const marker of ['QueryFullProcessImageName', 'creation', 'GetWindowThreadProcessId', 'GetLastInputInfo', 'GetDpiForWindow', 'GetForegroundWindow', 'WindowFromPoint', 'CopyFromScreen', 'GetAsyncKeyState', 'FileMode.CreateNew', 'SHA256.HashData', 'differingBytes=differences', 'differences==0', 'Unobscured(box);', 'DwmGetWindowAttribute', 'Its baseline was not reset.'])
        assert.ok(ps.includes(marker), marker);
    assert.doesNotMatch(ps, /UIAutomation|Windows\.Automation|PrintWindow|Kill\(|TerminateProcess|GC\.Collect/);
    assert.equal((ps.match(/SetForegroundWindow\(window\)/g) || []).length, 1);
    const activation = ps.slice(ps.indexOf('public object PrepareForeground()'), ps.indexOf('public object Identity()'));
    assert.match(activation, /Guard\(false\)/);
    assert.match(activation, /if\(foregroundPrepared\)throw/);
});
test('reference generation alone imports AX; run needs explicit root visual approval and a passed pilot', async () => {
    const source = await readFile(new URL('../scripts/verify-native-visual-stability.mjs', import.meta.url), 'utf8');
    const references = source.slice(source.indexOf('async function references('), source.indexOf('async function run('));
    const run = source.slice(source.indexOf('async function run('));
    assert.match(references, /await import\('\.\/native-uia-client\.mjs'\)/);
    assert.doesNotMatch(run, /import\(|NativeUiaSession/);
    assert.doesNotMatch(references, /app\.call\('(search|clear|filter|openDocument|tab|closeDocument|click|type)'/);
    assert.match(references, /await visual\.call\('text'/);
    assert.match(references, /await visual\.call\('click'/);
    assert.match(run, /approval\.referenceSha256, hash\(refBytes\)/);
    assert.match(run, /approval\.visualReviewConfirmed, true/);
    assert.match(run, /approval\.reviewedStates, requiredStates/);
    assert.match(run, /result\.status, 'pilot-passed'/);
    assert.match(run, /result\.normalExit, true/);
    assert.match(run, /stabilityVerdict\(report\.samples, report\.bounds, PERFORMANCE_POLICY\.warmupCycles\)/);
    assert.match(run, /task\.action === 'check_now'/);
    assert.match(run, /added\.length <= 1/);
    assert.match(run, /index % 2 === 0/);
    assert.match(run, /protectedData\(descriptor\.dataset\), baseline/);
});
test('foreground preparation uses one guarded temporary queue attachment and detaches on every failure', { skip: process.platform !== 'win32' }, async () => {
    const helper = await readFile(new URL('../scripts/native-visual-input.ps1', import.meta.url), 'utf8');
    const method = helper.slice(helper.indexOf('  public object PrepareForeground()'), helper.indexOf('  public object Identity()'));
    assert.ok(method.includes('finally {') && method.includes('AttachThreadInput(currentThread,foregroundThread,false)'));
    assert.doesNotMatch(method, /SendInput|inputTick\s*=|SetFocus|BringWindowToTop|Automation/);
    const temporary = await mkdtemp(validation + '/native-visual-pure-');
    const path = join(temporary, 'foreground-contract.ps1');
    const program = `Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
// Only the pure fake substitutes the clock. The actual helper retains Stopwatch and its 15-second limit.
public sealed class Stopwatch {
  long elapsed;
  public static Stopwatch StartNew(){return new Stopwatch();}
  public long ElapsedMilliseconds {get {elapsed+=1000;return elapsed;}}
}
public sealed class FakeForegroundPreparation {
  struct MSG {}
  readonly IntPtr window=new IntPtr(1);
  IntPtr foreground=new IntPtr(2);
  bool foregroundPrepared,inputChanged,ownerChanged,activationRequested;
  int afterActivationReads;
  public string Scenario;
  public readonly List<string> Trace=new List<string>();
  void Guard(bool required=true) {
    if(ownerChanged||Scenario=="owner-before")throw new InvalidOperationException("owner guard");
    if(inputChanged)throw new InvalidOperationException("input guard");
    if(required&&foreground!=window)throw new InvalidOperationException("foreground guard");
  }
  uint GetCurrentThreadId(){return 1;}
  uint GetWindowThreadProcessId(IntPtr handle,out uint pid){pid=2;return 2;}
  IntPtr GetForegroundWindow(){
    if(Scenario=="false-then-owned"&&activationRequested&&++afterActivationReads>=2)foreground=window;
    return foreground;
  }
  IntPtr GetAncestor(IntPtr handle,uint flags){return handle;}
  bool PeekMessageW(out MSG value,IntPtr handle,uint first,uint last,uint remove) {
    value=new MSG();Trace.Add("queue");
    if(Scenario=="input-at-queue")inputChanged=true;
    if(Scenario=="focus-at-queue")foreground=new IntPtr(3);
    return false;
  }
  bool AttachThreadInput(uint from,uint to,bool attach) {
    Trace.Add(attach?"attach":"detach");
    if(attach&&Scenario=="attach-fail")return false;
    if(attach&&Scenario=="input-after-attach")inputChanged=true;
    if(attach&&Scenario=="owner-after-attach")ownerChanged=true;
    if(attach&&Scenario=="focus-after-attach")foreground=new IntPtr(3);
    return attach||Scenario!="detach-fail";
  }
  bool SetForegroundWindow(IntPtr handle) {
    Trace.Add("activate");
    if(Scenario=="activation-fail")return false;
    if(Scenario=="false-then-owned"){activationRequested=true;return false;}
    foreground=handle;
    if(Scenario=="owner-after-activation")ownerChanged=true;
    return true;
  }
  object Identity(){return new{ready=true};}
${method}
  public static object Check(string scenario) {
    var value=new FakeForegroundPreparation{Scenario=scenario};
    if(scenario=="already")value.foreground=value.window;
    bool failed=false;string error=null;
    try {value.PrepareForeground();if(scenario=="repeat")value.PrepareForeground();}
    catch(Exception failure){failed=true;error=failure.Message;}
    return new{scenario=scenario,failed=failed,error=error,trace=value.Trace};
  }
}
'@
@('already','success','false-then-owned','owner-before','input-at-queue','focus-at-queue','attach-fail','input-after-attach','owner-after-attach','focus-after-attach','activation-fail','owner-after-activation','detach-fail','repeat') | ForEach-Object { [FakeForegroundPreparation]::Check($_) } | ConvertTo-Json -Depth 5 -Compress
`;
    await writeFile(path, program, { flag: 'wx' });
    const result = await promisify(execFile)('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path], { env: { ...process.env, TEMP: temporary, TMP: temporary }, windowsHide: true, timeout: 60000 });
    const cases = new Map(JSON.parse(result.stdout).map(value => [value.scenario, value]));
    assert.equal(cases.get('already').failed, false);
    assert.deepEqual(cases.get('already').trace, []);
    assert.equal(cases.get('success').failed, false);
    assert.deepEqual(cases.get('success').trace, ['queue', 'attach', 'activate', 'detach']);
    assert.equal(cases.get('false-then-owned').failed, false);
    assert.deepEqual(cases.get('false-then-owned').trace, ['queue', 'attach', 'activate', 'detach']);
    assert.match(cases.get('activation-fail').error, /did not become foreground after one prepared activation attempt/);
    assert.match(method, /wait\.ElapsedMilliseconds>=15000/);
    for (const name of ['owner-before', 'input-at-queue', 'focus-at-queue', 'attach-fail']) {
        assert.equal(cases.get(name).failed, true, name);
        assert.equal(cases.get(name).trace.includes('activate'), false, name);
    }
    for (const name of ['input-after-attach', 'owner-after-attach', 'focus-after-attach', 'activation-fail', 'owner-after-activation', 'detach-fail', 'repeat']) {
        assert.equal(cases.get(name).failed, true, name);
        assert.equal(cases.get(name).trace.filter(value => value === 'attach').length, 1, name);
        assert.equal(cases.get(name).trace.filter(value => value === 'detach').length, 1, name);
    }
    assert.equal(cases.get('repeat').trace.filter(value => value === 'activate').length, 1);
});
test('Windows helper and read-only observer compile without opening or observing any target window', { skip: process.platform !== 'win32' }, async () => {
    const temporary = await mkdtemp(validation + '/native-visual-pure-');
    const env = { ...process.env, TEMP: temporary, TMP: temporary };
    const execute = promisify(execFile);
    const helper = fileURLToPath(new URL('../scripts/native-visual-input.ps1', import.meta.url));
    const driver = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', helper, '-CompileOnly'], { env, windowsHide: true, timeout: 60000 });
    const result = JSON.parse(driver.stdout);
    assert.equal(result.compiled, true);
    assert.equal(result.windowOperationsPerformed, false);
    assert.equal(result.pixelComparatorCases, 3);
    const observer = join(temporary, 'observer.ps1');
    await writeFile(observer, visualObserverSource(), { flag: 'wx' });
    const compilation = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', observer, '-Mode', 'compile'], { env, windowsHide: true, timeout: 60000 });
    const observed = JSON.parse(compilation.stdout);
    assert.equal(observed.compiled, true);
    assert.equal(observed.observationInvoked, false);
});
