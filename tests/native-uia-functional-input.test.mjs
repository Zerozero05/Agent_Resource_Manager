import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeUiaSession } from '../scripts/native-uia-client.mjs';

const harness = await readFile(new URL('../scripts/verify-native-uia.ps1', import.meta.url), 'utf8');

test('IME CLI rejects malformed transport identity before reading or launching a candidate', async () => {
  const script = fileURLToPath(new URL('../scripts/verify-native-ime.mjs', import.meta.url));
  for (const args of [['--transport-file-sha256'], ['--transport-file-sha256', 'invalid']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /transport-file-sha256 requires one exact SHA256 digest/);
    assert.equal(result.stdout, '');
  }
  const runner = await readFile(script, 'utf8');
  assert.match(runner, /assertNoUserManager\(\{ transportSha256,/);
  assert.match(runner, /NativeUiaSession\.launch\(\{ executable, sha256: executableSha256, transportSha256,/);
  assert.match(runner, /app\.identity\.executableSha256, executableSha256/);
});

function sourceSection(start, end) {
  const first = harness.indexOf(start);
  const last = harness.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `The native source section is present: ${start}`);
  return harness.slice(first, last);
}

const ime = sourceSection('  public object KeyboardIme(string name,bool prepareChineseIme)', '  public object KeyboardShortcut(');
const imeMode = sourceSection('  sealed class ImeModeState', '  public object KeyboardIme(string name,bool prepareChineseIme)');
const taskbarMode = sourceSection('  sealed class TaskbarImeModeState', '  void ToggleImeMode(');
const closedCombo = sourceSection('  public object KeyboardSelectClosedCombo(', '  public string LastComboSelectionMethod');
const popupCombo = sourceSection('  public object KeyboardSelectPopupCombo(', '  public object LastClosedComboSelection');

function session(options = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  const app = new NativeUiaSession(child, 'unused-functional-input-policy-report');
  Object.assign(app, { keyboardInput: true, accessibilityInput: true, privateUi: false }, options);
  const requests = [];
  child.stdin.on('data', data => {
    const request = JSON.parse(data.toString());
    requests.push(request);
    child.stdout.write(JSON.stringify({ id: request.id, ok: true, value: request }) + '\n');
  });
  return { app, requests };
}

test('physical IME accepts only the exact isolated search control', async () => {
  const { app, requests } = session();
  const result = await app.call('keyboardIme', { name: '搜索 Skill' });
  assert.equal(result.op, 'keyboardIme');
  assert.equal(result.name, '搜索 Skill');
  assert.equal(requests.length, 1);
  for (const name of ['搜索 Skill extra', '搜索工具', '发行版本']) {
    await assert.rejects(app.call('keyboardIme', { name }), /restricted to the isolated Skill search field/);
  }
  for (const name of ['', null, undefined, 1, 'a'.repeat(161)]) {
    await assert.rejects(app.call('keyboardIme', { name }), /one exact named input/);
  }
  assert.equal(requests.length, 1);
});

test('temporary Chinese mode preparation requires a real boolean and remains opt-in', async () => {
  const { app, requests } = session();
  for (const prepareChineseIme of ['true', 'false', null, 0, 1, {}]) {
    await assert.rejects(app.call('keyboardIme', { name: '搜索 Skill', prepareChineseIme }), /requires an explicit boolean/);
  }
  assert.equal(requests.length, 0);
  for (const prepareChineseIme of [false, true]) {
    const result = await app.call('keyboardIme', { name: '搜索 Skill', prepareChineseIme });
    assert.equal(result.prepareChineseIme, prepareChineseIme);
  }
  assert.equal(requests.length, 2);
  assert.match(harness, /public object KeyboardIme\(string name\) \{\s*return KeyboardIme\(name,false\);/);
});

test('Chinese mode observation is explicit, mutually exclusive with preparation and has only two fixed toggle keys', async () => {
  const { app, requests } = session();
  for (const observeChineseIme of ['true', 'false', null, 0, 1, {}]) {
    await assert.rejects(app.call('keyboardIme', { name: '搜索 Skill', observeChineseIme }), /requires an explicit boolean/);
  }
  await assert.rejects(app.call('keyboardIme', { name: '搜索 Skill', prepareChineseIme: true, observeChineseIme: true }), /cannot also request a mode switch/);
  for (const modeToggleKey of ['Ctrl', 'control', '', null, 17, true, {}, ['ctrl'], 'ctrl+space', 'shift\n']) {
    await assert.rejects(app.call('keyboardIme', { name: '搜索 Skill', modeToggleKey }), /only the explicit shift or ctrl key/);
  }
  assert.equal(requests.length, 0);
  for (const observeChineseIme of [false, true]) {
    const result = await app.call('keyboardIme', { name: '搜索 Skill', observeChineseIme });
    assert.equal(result.observeChineseIme, observeChineseIme);
  }
  for (const modeToggleKey of ['shift', 'ctrl']) {
    const result = await app.call('keyboardIme', { name: '搜索 Skill', prepareChineseIme: true, modeToggleKey });
    assert.equal(result.modeToggleKey, modeToggleKey);
  }
  assert.equal(requests.length, 4);
  assert.match(harness, /return KeyboardIme\(name,prepareChineseIme,observeChineseIme,"shift"\)/);
  assert.match(harness, /modeToggleKey!="shift"&&modeToggleKey!="ctrl"/);
  assert.match(harness, /\$request\.modeToggleKey -isnot \[string\] -or \$request\.modeToggleKey -cnotin @\('shift','ctrl'\)/);
});

test('IME CLI rejects malformed observation or toggle requests before candidate access', async () => {
  const script = fileURLToPath(new URL('../scripts/verify-native-ime.mjs', import.meta.url));
  const cases = [
    [['--observe-chinese-ime'], /observe-chinese-ime requires true or false/],
    [['--observe-chinese-ime', 'yes'], /observe-chinese-ime requires true or false/],
    [['--mode-toggle-key'], /mode-toggle-key supports only shift or ctrl/],
    [['--mode-toggle-key', 'ctrl+space'], /mode-toggle-key supports only shift or ctrl/],
    [['--prepare-chinese-ime', 'true', '--observe-chinese-ime', 'true'], /cannot also request a mode switch/],
  ];
  for (const [args, message] of cases) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    assert.equal(result.error, undefined); assert.notEqual(result.status, 0);
    assert.match(result.stderr, message); assert.equal(result.stdout, '');
  }
});

test('IME and closed-combo operations reject private or unapproved keyboard sessions before a request', async () => {
  for (const options of [{ privateUi: true }, { keyboardInput: false }, { keyboardInput: undefined }]) {
    const { app, requests } = session(options);
    await assert.rejects(app.call('keyboardIme', { name: '搜索 Skill' }), /explicitly enabled non-private/);
    await assert.rejects(app.call('keyboardSelectClosedCombo', { name: '发行版本', option: 'v1.6.0' }), /explicitly enabled non-private/);
    assert.equal(requests.length, 0);
  }
});

test('closed-combo keyboard input requires explicit accessibility mode', async () => {
  for (const accessibilityInput of [false, undefined, 'true']) {
    const { app, requests } = session({ accessibilityInput });
    await assert.rejects(app.call('keyboardSelectClosedCombo', { name: '发行版本', option: 'v1.6.0' }), /explicitly enabled non-private/);
    assert.equal(requests.length, 0);
  }
});

test('closed-combo keyboard input accepts only the two exact GitHub controls', async () => {
  const { app, requests } = session();
  for (const name of ['发行版本', '发行文件']) {
    const result = await app.call('keyboardSelectClosedCombo', { name, option: 'exact option' });
    assert.equal(result.op, 'keyboardSelectClosedCombo');
    assert.equal(result.name, name);
    assert.equal(result.option, 'exact option');
  }
  for (const name of ['发行版本 extra', '搜索 Skill', '', null, 1]) {
    await assert.rejects(app.call('keyboardSelectClosedCombo', { name, option: 'exact option' }), /restricted to the two GitHub release fields/);
  }
  assert.equal(requests.length, 2);
});

test('closed-combo option validation rejects invalid values and retains the exact bounded value', async () => {
  const { app, requests } = session();
  for (const option of ['', null, undefined, 1, 'line\nbreak', '\u0000', '\u007f', '\u009f', 'a'.repeat(513)]) {
    await assert.rejects(app.call('keyboardSelectClosedCombo', { name: '发行文件', option }), /exact bounded ordinary option name/);
  }
  assert.equal(requests.length, 0);
  const option = 'a'.repeat(512);
  assert.equal((await app.call('keyboardSelectClosedCombo', { name: '发行文件', option })).option, option);
  assert.equal(requests.length, 1);
});

test('closed-combo catalogue rejects missing, ambiguous and unbounded navigation targets before input', async () => {
  const { app, requests } = session();
  for (const catalogueOptions of [null, '', [], ['other'], ['target', 'target'], ['target', 1], ['target', '\n'], Array.from({ length: 101 }, (_, i) => i ? `v${i}` : 'target')]) {
    await assert.rejects(app.call('keyboardSelectClosedCombo', { name: '发行版本', option: 'target', catalogueOptions }), /catalogue requires/);
  }
  assert.equal(requests.length, 0);
  const catalogueOptions = ['请选择版本', 'other', 'target'];
  const result = await app.call('keyboardSelectClosedCombo', { name: '发行版本', option: 'target', catalogueOptions });
  assert.deepEqual(result.catalogueOptions, catalogueOptions);
  assert.equal(requests.length, 1);
});

test('IME uses only fixed physical letters and Space after the current owned Chinese-layout check', () => {
  assert.match(ime, /name!="搜索 Skill"/);
  assert.match(ime, /KeyboardTarget\(name\)/);
  assert.match(ime, /ControlType\.Edit/);
  assert.match(ime, /ValuePattern\.Pattern/);
  assert.match(ime, /Current\.IsReadOnly/);
  assert.match(ime, /GetWindowThreadProcessId\(window,out owner\)/);
  assert.match(ime, /owner!=\(uint\)Pid/);
  assert.match(ime, /GetKeyboardLayout\(thread\)/);
  const rejection = ime.indexOf('if(unchecked((ushort)layout)!=0x0804)');
  assert.ok(rejection >= 0 && rejection < ime.indexOf('ClickNative(target)') && rejection < ime.indexOf('Send(new[]'));
  assert.match(ime, /not-verified-current-layout-not-simplified-chinese";return diagnostic/);
  assert.match(ime, /if\(before!=""\)throw/);
  assert.match(ime, /KeyboardFocused\(target,"before-ime-physical-letters"\)/);
  assert.match(ime, /KeyboardFocused\(target,"before-ime-space-commit"\)/);
  assert.deepEqual([...ime.matchAll(/Key\((0x[0-9A-F]+)(?:,true)?\)/g)].map(value => value[1]), [
    '0x43', '0x43', '0x45', '0x45', '0x53', '0x53', '0x48', '0x48', '0x49', '0x49', '0x20', '0x20',
  ]);
  assert.doesNotMatch(ime, /\bText\(|SetValue\(|Clipboard|SetClipboard|ActivateKeyboardLayout|LoadKeyboardLayout|KEYEVENTF_UNICODE/);
});

test('IME records the observed committed value and cannot claim conversion before exact Chinese equality', () => {
  assert.match(ime, /beforeCommitValue/);
  assert.match(ime, /diagnostic\["afterValue"\]=KeyboardValue\(target\)/);
  assert.match(ime, /return \(string\)diagnostic\["afterValue"\]=="测试"/);
  assert.ok(ime.indexOf('diagnostic["imeCompositionVerified"]=true') > ime.indexOf('=="测试"'));
  assert.match(harness, /finally\{\$report.keyboardIme=\$session.LastKeyboardIme\}/);
});

test('temporary mode preparation separates safe unreadable IMM mode from focus and layout failures', () => {
  assert.match(imeMode, /KeyboardFocused\(target,phase\)/);
  assert.match(imeMode, /GetGUIThreadInfo\(0,ref info\)/);
  assert.match(imeMode, /GetAncestor\(info\.focus,2\)!=window/);
  assert.match(imeMode, /GetWindowThreadProcessId\(info\.focus,out owner\)/);
  assert.match(imeMode, /ImmGetContext\(info\.focus\)/);
  assert.match(imeMode, /ImmGetOpenStatus\(context\)/);
  assert.match(imeMode, /ImmGetConversionStatus\(context,out state\.Conversion,out state\.Sentence\)/);
  assert.match(imeMode, /finally \{\s*state\.ContextReleased=ImmReleaseContext\(info\.focus,context\)/);
  assert.match(imeMode, /ContextAvailable&&ConversionRead&&ContextReleased/);
  const availability = imeMode.slice(imeMode.indexOf('public bool ModeApiUnavailable'), imeMode.indexOf('public bool Native'));
  assert.match(availability, /FocusWindow!=0&&Thread!=0&&unchecked\(\(ushort\)Layout\)==0x0804/);
  assert.match(availability, /!ContextAvailable\|\|\(!ConversionRead&&ContextReleased\)/);
  assert.match(imeMode, /if\(!GetGUIThreadInfo\(0,ref info\)\)\{[^}]*return state;/);
  assert.match(imeMode, /if\(info\.focus==IntPtr\.Zero\|\|GetAncestor\(info\.focus,2\)!=window\)\{[^}]*return state;/);
  assert.match(imeMode, /if\(state\.Thread==0\)\{[^}]*return state;/);
  const preparation = ime.slice(ime.indexOf('if(prepareChineseIme)'), ime.indexOf('KeyboardFocused(target,"before-ime-physical-letters")'));
  const unreadableMode = preparation.slice(0, preparation.indexOf('\n        } else {'));
  assert.match(unreadableMode, /if\(!original\.Known\)/);
  assert.match(unreadableMode, /if\(!original\.ModeApiUnavailable\)\{diagnostic\["status"\]="not-verified-current-ime-mode-unavailable";return diagnostic;\}/);
  const unavailableRejection = unreadableMode.indexOf('if(!original.ModeApiUnavailable)');
  assert.ok(unavailableRejection >= 0 && unavailableRejection < unreadableMode.indexOf('naturalModeProbe=true'));
  assert.match(unreadableMode, /naturalModeProbe=true;diagnostic\["naturalModeProbe"\]=true/);
  assert.match(unreadableMode, /diagnostic\["modeRestorationVerified"\]=null/);
  const naturalProbe = unreadableMode.slice(unreadableMode.indexOf('naturalModeProbe=true'));
  assert.doesNotMatch(naturalProbe, /ToggleImeMode\(|Key\(/);
  assert.ok(unavailableRejection < unreadableMode.indexOf('ReadGuardedTaskbarMode('));
  assert.match(unreadableMode, /taskbarOriginal\.SameIndicator\(initialTaskbar\)&&taskbarOriginal\.Name==initialTaskbar\.Name&&taskbarOriginal\.Mode=="english"/);
  assert.match(unreadableMode, /ToggleImeMode\(target,"before-taskbar-ime-mode-toggle",modeToggleKey,\(\)=>\{diagnostic\["modeToggleSent"\]=true;diagnostic\["modeShiftSent"\]=modeToggleKey=="shift";\}\)/);
  assert.match(preparation, /if\(!original\.Native\)/);
  assert.match(preparation, /ToggleImeMode\(target,"before-ime-mode-toggle",modeToggleKey,/);
  assert.match(preparation, /state\.Known&&state\.FocusWindow==original\.FocusWindow&&state\.Layout==original\.Layout&&state\.Native/);
  assert.match(preparation, /not-verified-mode-toggle-did-not-enable-chinese/);
  assert.deepEqual([...imeMode.matchAll(/Key\((0x[0-9A-F]+)(?:,true)?\)/g)].map(value => value[1]), ['0x11', '0x11', '0x10', '0x10']);
  assert.doesNotMatch(imeMode, /ImmSet|ActivateKeyboardLayout|LoadKeyboardLayout|SetValue\(|Clipboard|KEYEVENTF_UNICODE/);
});

test('IME mode restoration survives conversion failure and verifies exact original mode before passing', async () => {
  const restoration = ime.slice(ime.indexOf('    } finally {'));
  assert.match(restoration, /if\(prepareChineseIme&&original\.Known\)/);
  assert.match(restoration, /ReadImeMode\(target,"before-ime-mode-restoration"\)/);
  assert.match(restoration, /!restorationRequired\|\|!current\.Known\|\|current\.FocusWindow!=original\.FocusWindow\|\|current\.Layout!=original\.Layout/);
  assert.match(restoration, /ToggleImeMode\(target,"restore-ime-mode-toggle",modeToggleKey,/);
  assert.match(restoration, /current=WaitImeMode\(target,state=>state\.Matches\(original\)/);
  assert.match(restoration, /diagnostic\["modeRestorationVerified"\]=current\.Matches\(original\)/);
  assert.match(restoration, /catch\(Exception error\)[\s\S]*modeRestorationError[\s\S]*modeRestorationVerified"\]=false/);
  assert.match(imeMode, /Open==other\.Open&&Conversion==other\.Conversion&&Sentence==other\.Sentence/);
  const runner = await readFile(new URL('../scripts/verify-native-ime.mjs', import.meta.url), 'utf8');
  assert.match(runner, /options\['prepare-chinese-ime'\] === 'true'/);
  assert.match(runner, /else if \(prepareChineseIme && report\.ime\.modeBefore\?\.known === true\) \{\s*assert\.equal\(report\.ime\.modeRestorationVerified, true/);
  assert.match(runner, /if \(prepareChineseIme && report\.ime\.naturalModeProbe !== true && report\.ime\.taskbarModePreparation !== true\) assert\.equal\(report\.ime\.modeRestorationVerified, true/);
  assert.match(runner, /assert\.equal\(report\.ime\.modeRestorationVerified, null\)/);
  assert.match(runner, /report\.status !== 'physical-ime-conversion-passed'/);
});

test('taskbar IME fallback reads one exact visible shell indicator without operating the taskbar', () => {
  assert.match(taskbarMode, /RootElement\.FindAll\(TreeScope\.Children[\s\S]*"Shell_TrayWnd"[\s\S]*IsOffscreenProperty,false/);
  assert.match(taskbarMode, /if\(bars\.Count!=1\)/);
  assert.match(taskbarMode, /GetWindowThreadProcessId\(new IntPtr\(state\.TaskbarWindow\),out owner\)/);
  assert.match(taskbarMode, /owner!=\(uint\)state\.OwnerPid/);
  assert.match(taskbarMode, /shell\.ProcessName,"explorer"[\s\S]*shell\.StartTime/);
  assert.match(taskbarMode, /bar\.FindAll\(TreeScope\.Descendants[\s\S]*ControlType\.Button[\s\S]*"SystemTray\.NormalButton"[\s\S]*IsOffscreenProperty,false/);
  assert.match(taskbarMode, /buttons\.Count>256/);
  assert.match(taskbarMode, /if\(count!=1\)/);
  assert.match(taskbarMode, /state\.IndicatorPid!=state\.OwnerPid/);
  assert.match(taskbarMode, /label=="任务栏输入指示 英语模式"/);
  assert.match(taskbarMode, /label=="任务栏输入指示 中文模式"/);
  assert.match(taskbarMode, /OwnerCreationFileTime!=other\.OwnerCreationFileTime/);
  assert.match(taskbarMode, /RuntimeId\[index\]!=other\.RuntimeId\[index\]/);
  assert.match(taskbarMode, /brandObserved=\(string\)null/);
  assert.doesNotMatch(taskbarMode, /SetFocus\(|ClickNative\(|\.Invoke\(|SetValue\(|\bSend\(|\bKey\(/);
});

test('taskbar IME fallback pins both focus observations and stops keys after unknown status', () => {
  const guardedObservation = ime.slice(ime.indexOf('TaskbarImeModeState ReadGuardedTaskbarMode('), ime.indexOf('TaskbarImeModeState WaitTaskbarMode('));
  const before = guardedObservation.indexOf('GuardImeContext(phase+"-before")');
  const read = guardedObservation.indexOf('ReadTaskbarImeMode()');
  const after = guardedObservation.indexOf('GuardImeContext(phase+"-after")');
  assert.ok(before >= 0 && read > before && after > read);
  assert.match(guardedObservation, /observed\.FocusBefore=beforeFocus;observed\.FocusAfter=diagnostic\["lastInputContext"\]/);
  assert.match(guardedObservation, /taskbarModePreparation&&!observed\.Known\)taskbarInputBlocked=true/);
  assert.match(ime, /Paint\(\);Thread\.Sleep\(100\);\s*taskbarOriginal=ReadGuardedTaskbarMode\("confirm-taskbar-original-mode"\)/);
  assert.match(ime, /modeToggleAttempted"\]=true;diagnostic\["modeShiftAttempted"\]=modeToggleKey=="shift";diagnostic\["modeRestorationRequired"\]=true;\s*ToggleImeMode\(target,"before-taskbar-ime-mode-toggle",modeToggleKey,/);
  assert.match(ime, /if\(taskbarModePreparation\)RequireTaskbarChinese\("before-taskbar-ime-physical-letters"\)/);
  assert.match(ime, /if\(taskbarModePreparation\)RequireTaskbarChinese\("before-taskbar-ime-space-commit"\)/);
  const cleanup = ime.slice(ime.indexOf('if(inputAttempted) {'), ime.indexOf('if(prepareChineseIme&&original.Known)'));
  assert.ok(cleanup.indexOf('if(taskbarInputBlocked)throw') < cleanup.indexOf('KeyboardShortcut(name,"Escape")'));
  const restoration = ime.slice(ime.indexOf('      if(taskbarModePreparation) {'));
  assert.ok(restoration.indexOf('if(taskbarInputBlocked)throw') < restoration.indexOf('ToggleImeMode('));
  assert.match(restoration, /if\(current\.Mode=="chinese"\) \{\s*if\(\(string\)diagnostic\["status"\]=="not-verified-taskbar-mode-not-prepared"\)throw/);
  assert.match(restoration, /WaitTaskbarMode\("english",true/);
  assert.match(restoration, /current\.SameIndicator\(taskbarOriginal\)&&current\.Mode=="english"&&current\.Name==taskbarOriginal\.Name/);
  assert.match(restoration, /taskbarModeRestorationVerified"\]=false/);
  assert.doesNotMatch(restoration, /diagnostic\["modeRestorationVerified"\]=true/);
});

test('activated taskbar IME failures latch a permanent stop before finally can send another key', () => {
  const inputCatch = ime.slice(ime.indexOf('    } catch(Exception error) {'), ime.indexOf('    } finally {'));
  assert.match(inputCatch, /if\(taskbarModePreparation\)taskbarInputBlocked=true;[\s\S]*inputError[\s\S]*throw;/);
  const cleanup = ime.slice(ime.indexOf('if(inputAttempted) {'), ime.indexOf('if(prepareChineseIme&&original.Known)'));
  assert.match(cleanup, /catch\(Exception error\) \{\s*if\(taskbarModePreparation\)taskbarInputBlocked=true;/);
  const restoration = ime.slice(ime.indexOf('      if(taskbarModePreparation) {'));
  assert.match(restoration, /catch\(Exception error\) \{\s*taskbarInputBlocked=true;[\s\S]*taskbarModeRestorationVerified"\]=false;[\s\S]*modeRestorationStatus"\]="unverified-taskbar-restoration"/);
  assert.equal([...ime.matchAll(/taskbarInputBlocked=false/g)].length, 1);
  assert.ok(cleanup.indexOf('if(taskbarInputBlocked)throw') < cleanup.indexOf('KeyboardShortcut(name,"Escape")'));
  assert.ok(restoration.indexOf('if(taskbarInputBlocked)throw') < restoration.indexOf('ToggleImeMode('));
  assert.match(restoration, /diagnostic\["taskbarInputStopped"\]=taskbarInputBlocked/);
});

test('fixed Ctrl or Shift dispatch is recorded immediately before a later paint or guard can fail', () => {
  const toggle = sourceSection('  void ToggleImeMode(', '  public object KeyboardIme(string name,bool prepareChineseIme)');
  const ctrl = toggle.indexOf('if(modeToggleKey=="ctrl")Send(new[]{Key(0x11),Key(0x11,true)})');
  const shift = toggle.indexOf('else Send(new[]{Key(0x10),Key(0x10,true)})');
  const record = toggle.indexOf('if(sent!=null)sent()');
  const settle = toggle.indexOf('KeyboardSettled(');
  assert.ok(ctrl >= 0 && shift > ctrl && record > shift && settle > record);
  assert.ok(toggle.indexOf('modeToggleKey!="shift"&&modeToggleKey!="ctrl"') < toggle.indexOf('KeyboardFocused('));
  assert.match(toggle, /Action sent=null/);
  for (const phase of ['before-taskbar-ime-mode-toggle', 'before-ime-mode-toggle']) {
    assert.ok(ime.includes(`ToggleImeMode(target,"${phase}",modeToggleKey,()=>{diagnostic["modeToggleSent"]=true;diagnostic["modeShiftSent"]=modeToggleKey=="shift";})`));
  }
  assert.match(ime, /ToggleImeMode\(target,"restore-taskbar-ime-mode-toggle",modeToggleKey,\(\)=>\{diagnostic\["modeRestorationToggleSent"\]=true;diagnostic\["taskbarRestoreToggleSent"\]=true;diagnostic\["taskbarRestoreShiftSent"\]=modeToggleKey=="shift";\}\)/);
  assert.match(ime, /ToggleImeMode\(target,"restore-ime-mode-toggle",modeToggleKey,\(\)=>diagnostic\["modeRestorationToggleSent"\]=true\)/);
});

test('IME rechecks complete focus and HKL identity before input and guarded field cleanup', () => {
  const firstInput = ime.indexOf('inputAttempted=true');
  const focusRejection = ime.indexOf('if(original.FocusWindow==0||original.Thread==0||original.Layout!=layout)throw');
  assert.ok(focusRejection >= 0 && focusRejection < ime.indexOf('if(prepareChineseIme)') && focusRejection < firstInput);
  const guard = ime.slice(ime.indexOf('void GuardImeContext('), ime.indexOf('    try {'));
  assert.match(guard, /GetKeyboardLayout\(thread\)\.ToInt64\(\)!=layout/);
  assert.match(guard, /current\.FocusWindow!=original\.FocusWindow\|\|current\.Thread!=original\.Thread\|\|current\.Layout!=layout/);
  assert.match(guard, /!current\.Known&&!current\.ModeApiUnavailable/);
  assert.match(guard, /throw new InvalidOperationException/);
  const lettersGuard = ime.indexOf('GuardImeContext("before-ime-physical-letters-context")');
  const spaceGuard = ime.indexOf('GuardImeContext("before-ime-space-commit-context")');
  assert.ok(lettersGuard >= 0 && lettersGuard < firstInput);
  assert.ok(spaceGuard >= 0 && spaceGuard < ime.indexOf('diagnostic["spaceAttempted"]=true'));
  const cleanup = ime.slice(ime.indexOf('if(inputAttempted) {'), ime.indexOf('if(prepareChineseIme&&original.Known)'));
  const cleanupGuard = cleanup.indexOf('GuardImeContext("before-ime-field-cleanup")');
  const clearGuard = cleanup.indexOf('GuardImeContext("before-ime-field-clear")');
  assert.ok(cleanupGuard >= 0 && cleanupGuard < cleanup.indexOf('KeyboardShortcut(name,"Escape")'));
  assert.ok(clearGuard >= 0 && clearGuard < cleanup.indexOf('KeyboardEdit(name,String.Empty)'));
  assert.match(cleanup, /GuardImeContext\("after-ime-field-cleanup"\)/);
  assert.match(cleanup, /diagnostic\["fieldCleared"\]=\(string\)diagnostic\["afterCleanupValue"\]==""/);
  assert.match(cleanup, /catch\(Exception error\)[\s\S]*fieldCleanupError[\s\S]*fieldCleared"\]=false[\s\S]*status"\]="failed-or-blocked"/);
});

test('Chinese-mode observation sends no switch key and requires stable owned evidence before physical composition', () => {
  const observation = ime.slice(ime.indexOf('if(observeChineseIme) {'), ime.indexOf('if(prepareChineseIme) {'));
  assert.match(observation, /original\.Known&&!original\.Native/);
  assert.match(observation, /!original\.Known&&!original\.ModeApiUnavailable/);
  assert.match(observation, /ReadGuardedTaskbarMode\("observe-existing-taskbar-chinese-mode"\)/);
  assert.match(observation, /Paint\(\);Thread\.Sleep\(100\);\s*taskbarOriginal=ReadGuardedTaskbarMode\("confirm-existing-taskbar-chinese-mode"\)/);
  const stable = observation.indexOf('!taskbarOriginal.SameIndicator(initialTaskbar)||taskbarOriginal.Name!=initialTaskbar.Name||taskbarOriginal.Mode!="chinese"');
  assert.ok(stable >= 0 && stable < observation.indexOf('taskbarChineseModeObservation=true'));
  assert.match(observation, /not-verified-existing-taskbar-not-chinese";return diagnostic/);
  assert.match(observation, /taskbar-chinese-observation-only/);
  assert.doesNotMatch(observation, /ToggleImeMode\(|Send\(|Key\(|SetFocus\(|ClickNative\(/);
  for (const [phase, input] of [
    ['before-observed-chinese-ime-physical-letters', 'inputAttempted=true'],
    ['before-observed-chinese-ime-space-commit', 'diagnostic["spaceAttempted"]=true'],
    ['before-observed-chinese-ime-field-cleanup', 'KeyboardShortcut(name,"Escape")'],
  ]) {
    const guard = ime.indexOf(`if(taskbarChineseModeObservation)RequireTaskbarChinese("${phase}")`);
    assert.ok(guard >= 0 && guard < ime.indexOf(input));
  }
  assert.match(ime, /if\(taskbarChineseModeObservation\)RequireTaskbarChinese\("after-observed-chinese-ime-commit"\)/);
  assert.match(ime, /taskbarChineseModeObservation&&current\.Name!=taskbarOriginal\.Name/);
  const final = ime.slice(ime.indexOf('      if(taskbarChineseModeObservation) {'), ime.indexOf('      if(taskbarModePreparation) {'));
  assert.ok(final.indexOf('if(taskbarInputBlocked)throw') < final.indexOf('ReadGuardedTaskbarMode('));
  assert.match(final, /current\.SameIndicator\(taskbarOriginal\)&&current\.Mode=="chinese"&&current\.Name==taskbarOriginal\.Name/);
  assert.match(final, /finalMode\.FocusWindow!=original\.FocusWindow\|\|finalMode\.Thread!=original\.Thread\|\|finalMode\.Layout!=layout/);
  assert.match(final, /finalMode\.Matches\(original\)/);
  assert.match(final, /original-taskbar-chinese-preserved-imm-flags-unknown/);
  assert.match(final, /catch\(Exception error\)[\s\S]*taskbarInputBlocked=true;[\s\S]*taskbarChineseModePreserved"\]=false;[\s\S]*status"\]="failed-or-blocked"/);
  assert.doesNotMatch(final, /ToggleImeMode\(|Send\(|Key\(|SetFocus\(|ClickNative\(/);
  assert.equal([...ime.matchAll(/taskbarInputBlocked=false/g)].length, 1);
});

function runnerValidator(runner, name, next) {
  const start = runner.indexOf(`function ${name}(`), end = runner.indexOf(next, start);
  assert.ok(start >= 0 && end > start);
  return new Function('assert', `return (${runner.slice(start, end).trim()});`)(assert);
}

function observedChineseResult(known = false) {
  const context = {
    focusWindowHandle: 101, focusThread: 12, focusPid: 34, hkl: '0x0000000008040804',
    known, modeApiUnavailable: !known, contextAvailable: known, conversionRead: known, contextReleased: known,
    open: known ? true : null, conversion: known ? 1 : null, sentence: known ? 0 : null, native: known ? true : null,
  };
  const chinese = {
    source: 'taskbar-input-mode-indicator', known: true, mode: 'chinese',
    name: '任务栏输入指示 中文模式\n单击右键以查看更多选项',
    taskbarWindowHandle: 202, ownerPid: 56, ownerCreationFileTime: '123456789', indicatorPid: 56,
    runtimeId: [42, 202, 7], focusBefore: { ...context }, focusAfter: { ...context },
  };
  return {
    status: 'physical-ime-conversion-verified', observeChineseImeRequested: true, prepareChineseImeRequested: false,
    modeToggleKey: 'shift', modeToggleAttempted: false, modeToggleSent: false, modeRestorationToggleSent: false,
    modeShiftAttempted: false, modeShiftSent: false, modeRestorationRequired: false, modeRestorationAttempted: false,
    taskbarRestoreToggleSent: false, taskbarRestoreShiftSent: false, taskbarModePreparation: false, naturalModeProbe: false,
    taskbarChineseModeObservation: true, taskbarChineseModePreserved: true, taskbarInputStopped: false,
    modeEvidenceSource: 'taskbar-chinese-observation-only', modeBefore: structuredClone(context), modeAfterObservation: structuredClone(context),
    taskbarModeInitialObservation: structuredClone(chinese), taskbarModeBefore: structuredClone(chinese), taskbarModeAfterObservation: structuredClone(chinese),
    modeRestorationVerified: known ? true : null,
    modeRestorationStatus: known ? 'original-taskbar-chinese-and-imm-unchanged' : 'original-taskbar-chinese-preserved-imm-flags-unknown',
    textKeysAttempted: true, spaceAttempted: true, textKeysSent: true, spaceSent: true,
    fieldCleanupAttempted: true, fieldCleared: true, afterCleanupValue: '',
    layoutPreserved: true, focusPreserved: true, languageId: 0x0804,
    beforeValue: '', afterValue: '测试', method: 'guarded-fixed-SendInput-VK-ceshi-Space',
    unicodeInputUsed: false, clipboardUsed: false, imeCompositionVerified: true,
  };
}

test('observed Chinese-mode validation rejects ambiguous modes, changed identities and unproved IMM restoration', async () => {
  const runner = await readFile(new URL('../scripts/verify-native-ime.mjs', import.meta.url), 'utf8');
  const validate = runnerValidator(runner, 'validateObservedChineseIme', '\nlet app;');
  const start = runner.indexOf('  if (report.ime.naturalModeProbe === true)'), end = runner.indexOf('\n} catch (error) { report.status', start);
  const composition = new Function('assert', 'report', 'prepareChineseIme', runner.slice(start, end));
  for (const known of [false, true]) {
    const ime = observedChineseResult(known);
    validate(ime);
    const report = { ime };
    composition(assert, report, false);
    assert.equal(report.status, 'physical-ime-conversion-passed');
  }
  const notChinese = observedChineseResult();
  Object.assign(notChinese, { status: 'not-verified-existing-taskbar-not-chinese', taskbarChineseModeObservation: false, taskbarChineseModePreserved: null, textKeysAttempted: false, spaceAttempted: false, textKeysSent: false, spaceSent: false, imeCompositionVerified: false });
  validate(notChinese);
  const notVerified = { ime: notChinese };
  composition(assert, notVerified, false);
  assert.equal(notVerified.status, 'not-verified-existing-taskbar-not-chinese');
  const invalid = [
    ['mode switch requested', value => { value.prepareChineseImeRequested = true; }],
    ['toggle attempted', value => { value.modeToggleAttempted = true; }],
    ['restoration attempted', value => { value.modeRestorationAttempted = true; }],
    ['natural probe substituted', value => { value.naturalModeProbe = true; }],
    ['Chinese observation absent', value => { value.taskbarChineseModeObservation = false; }],
    ['mode preservation failed', value => { value.taskbarChineseModePreserved = false; }],
    ['input stopped', value => { value.taskbarInputStopped = true; }],
    ['unknown initial mode', value => { value.taskbarModeInitialObservation.known = false; }],
    ['English initial mode', value => { value.taskbarModeInitialObservation.mode = 'english'; }],
    ['English final mode', value => { value.taskbarModeAfterObservation.mode = 'english'; }],
    ['changed full label', value => { value.taskbarModeAfterObservation.name += ' changed'; }],
    ['unknown label', value => { value.taskbarModeBefore.name = '切换到中文模式'; }],
    ['changed Explorer owner', value => { value.taskbarModeAfterObservation.ownerPid++; }],
    ['changed Explorer creation', value => { value.taskbarModeAfterObservation.ownerCreationFileTime = '987654321'; }],
    ['changed taskbar window', value => { value.taskbarModeAfterObservation.taskbarWindowHandle++; }],
    ['changed indicator owner', value => { value.taskbarModeAfterObservation.indicatorPid++; }],
    ['changed indicator identity', value => { value.taskbarModeAfterObservation.runtimeId[2]++; }],
    ['changed owned focus', value => { value.taskbarModeInitialObservation.focusAfter.focusWindowHandle++; }],
    ['changed focused thread', value => { value.modeAfterObservation.focusThread++; }],
    ['final IMM contradicts Chinese mode', value => { value.modeAfterObservation.known = true; value.modeAfterObservation.native = false; }],
    ['final mode is neither known nor API unavailable', value => { value.modeAfterObservation.modeApiUnavailable = false; }],
    ['changed full HKL', value => { value.taskbarModeAfterObservation.focusBefore.hkl = '0x00000000E0200804'; }],
    ['unsafe unreadable IMM state', value => { value.modeBefore.modeApiUnavailable = false; }],
    ['unreadable flags claimed restored', value => { value.modeRestorationVerified = true; }],
    ['forged unreadable flags', value => { value.modeBefore.conversion = 1; }],
  ];
  for (const [label, mutate] of invalid) {
    const value = observedChineseResult(); mutate(value);
    assert.throws(() => validate(value), assert.AssertionError, label);
  }
  const readable = observedChineseResult(true);
  readable.modeAfterObservation.sentence++;
  assert.throws(() => validate(readable), assert.AssertionError, 'Changed readable IMM flags cannot pass.');
  const unsafeEarlyExit = { ...notChinese, textKeysSent: true };
  assert.throws(() => validate(unsafeEarlyExit), assert.AssertionError, 'Unverified mode must stop before text input.');
});

test('mode-toggle report validation distinguishes physical Ctrl from Shift and rejects inconsistent dispatch flags', async () => {
  const runner = await readFile(new URL('../scripts/verify-native-ime.mjs', import.meta.url), 'utf8');
  const validate = runnerValidator(runner, 'validateImeModeToggle', '\nfunction validateObservedChineseIme(');
  for (const key of ['shift', 'ctrl']) {
    const ime = observedChineseResult(); ime.modeToggleKey = key;
    validate(ime, key);
    Object.assign(ime, { modeToggleAttempted: true, modeToggleSent: true, modeShiftAttempted: key === 'shift', modeShiftSent: key === 'shift', modeRestorationAttempted: true, modeRestorationToggleSent: true, taskbarRestoreToggleSent: true, taskbarRestoreShiftSent: key === 'shift' });
    validate(ime, key);
    assert.throws(() => validate(ime, key === 'shift' ? 'ctrl' : 'shift'), assert.AssertionError);
    for (const field of ['modeToggleAttempted', 'modeToggleSent', 'modeRestorationToggleSent', 'taskbarRestoreToggleSent']) {
      assert.throws(() => validate({ ...ime, [field]: 'true' }, key), assert.AssertionError);
    }
  }
  const ctrl = observedChineseResult();
  Object.assign(ctrl, { modeToggleKey: 'ctrl', modeToggleAttempted: true, modeToggleSent: true });
  assert.throws(() => validate({ ...ctrl, modeShiftSent: true }, 'ctrl'), assert.AssertionError);
  assert.throws(() => validate({ ...ctrl, modeToggleAttempted: false }, 'ctrl'), assert.AssertionError);
  assert.throws(() => validate({ ...ctrl, modeRestorationAttempted: true, modeRestorationToggleSent: false }, 'ctrl'), assert.AssertionError);
});

test('IME report validation distinguishes proven conversion, ASCII and failed preservation', async () => {
  const runner = await readFile(new URL('../scripts/verify-native-ime.mjs', import.meta.url), 'utf8');
  const start = runner.indexOf('  if (report.ime.naturalModeProbe === true)');
  const end = runner.indexOf('\n} catch (error) { report.status', start);
  assert.ok(start >= 0 && end > start);
  const validate = new Function('assert', 'report', 'prepareChineseIme', runner.slice(start, end));
  const converted = {
    status: 'physical-ime-conversion-verified', naturalModeProbe: true,
    modeBefore: { known: false, modeApiUnavailable: true },
    modeShiftAttempted: false, modeShiftSent: false,
    modeRestorationRequired: false, modeRestorationAttempted: false,
    modeRestorationVerified: null, modeRestorationStatus: 'not-required-no-mode-switch-api-unavailable',
    textKeysAttempted: true, spaceAttempted: true, textKeysSent: true, spaceSent: true,
    fieldCleanupAttempted: true, fieldCleared: true, afterCleanupValue: '',
    layoutPreserved: true, focusPreserved: true, languageId: 0x0804,
    beforeValue: '', afterValue: '测试', method: 'guarded-fixed-SendInput-VK-ceshi-Space',
    unicodeInputUsed: false, clipboardUsed: false, imeCompositionVerified: true,
  };
  const natural = { ime: { ...converted } };
  validate(assert, natural, true);
  assert.equal(natural.status, 'physical-ime-conversion-passed');
  const ascii = { ime: { ...converted, status: 'not-verified-existing-mode-did-not-convert', afterValue: 'ceshi ', imeCompositionVerified: false } };
  validate(assert, ascii, true);
  assert.equal(ascii.status, 'not-verified-existing-mode-did-not-convert');
  const known = { ...converted, naturalModeProbe: false, modeBefore: { known: true }, modeRestorationVerified: true };
  const readable = { ime: { ...known } };
  validate(assert, readable, true);
  assert.equal(readable.status, 'physical-ime-conversion-passed');
  const earlyExit = { ime: { status: 'not-verified-current-ime-mode-unavailable', naturalModeProbe: false, modeBefore: { known: false }, textKeysAttempted: false, spaceAttempted: false, textKeysSent: false, spaceSent: false } };
  validate(assert, earlyExit, true);
  assert.equal(earlyExit.status, 'not-verified-current-ime-mode-unavailable');
  const invalid = [
    ['probe without opt-in', converted, false],
    ['unsafe unreadable state', { ...converted, modeBefore: { known: false, modeApiUnavailable: false } }],
    ['Shift attempted in unknown mode', { ...converted, modeShiftAttempted: true }],
    ['Shift sent in unknown mode', { ...converted, modeShiftSent: true }],
    ['unknown mode claimed restored', { ...converted, modeRestorationVerified: true }],
    ['known mode restoration failed', { ...known, modeRestorationVerified: false }],
    ['field cleanup failed', { ...converted, fieldCleared: false }],
    ['field retains input', { ...converted, afterCleanupValue: '测试' }],
    ['layout changed', { ...converted, layoutPreserved: false }],
    ['focus changed', { ...converted, focusPreserved: false }],
    ['input batch incomplete', { ...converted, textKeysSent: false }],
    ['wrong committed Chinese text', { ...converted, afterValue: '其他' }],
    ['early exit after sending input', { ...converted, status: 'not-verified-current-ime-mode-unavailable' }],
    ['ASCII claimed converted', { ...ascii.ime, imeCompositionVerified: true }],
  ];
  for (const [label, imeResult, prepare = true] of invalid) {
    assert.throws(() => validate(assert, { ime: imeResult }, prepare), assert.AssertionError, label);
  }
});

test('taskbar IME validation requires exact conversion, pinned mode evidence and original English restoration', async () => {
  const runner = await readFile(new URL('../scripts/verify-native-ime.mjs', import.meta.url), 'utf8');
  const start = runner.indexOf('  if (report.ime.naturalModeProbe === true)');
  const end = runner.indexOf('\n} catch (error) { report.status', start);
  assert.ok(start >= 0 && end > start);
  const validate = new Function('assert', 'report', 'prepareChineseIme', runner.slice(start, end));
  const context = { focusWindowHandle: 101, focusThread: 12, focusPid: 34, hkl: '0x0000000008040804', known: false, modeApiUnavailable: true, conversion: null, sentence: null, native: null };
  const english = {
    source: 'taskbar-input-mode-indicator', known: true, mode: 'english',
    name: '任务栏输入指示 英语模式\n单击右键以查看更多选项',
    taskbarWindowHandle: 202, ownerPid: 56, ownerCreationFileTime: '123456789',
    indicatorPid: 56, runtimeId: [42, 202, 7], brandObserved: null,
    focusBefore: { ...context }, focusAfter: { ...context },
  };
  const chinese = { ...english, mode: 'chinese', name: '任务栏输入指示 中文模式\n单击右键以查看更多选项' };
  const result = {
    status: 'physical-ime-conversion-verified', naturalModeProbe: false,
    modeBefore: context, taskbarModePreparation: true, taskbarInputStopped: false,
    modeEvidenceSource: 'taskbar-input-mode-indicator',
    modeToggleKey: 'shift', modeToggleAttempted: true, modeToggleSent: true, modeRestorationToggleSent: true, taskbarRestoreToggleSent: true,
    modeShiftAttempted: true, modeShiftSent: true, modeRestorationRequired: true,
    modeRestorationAttempted: true, modeRestorationVerified: null, taskbarRestoreShiftSent: true,
    taskbarModeRestorationVerified: true, modeRestorationStatus: 'original-taskbar-english-verified-imm-flags-unknown',
    taskbarModeInitialObservation: structuredClone(english), taskbarModeBefore: structuredClone(english),
    taskbarModeAfterPreparation: structuredClone(chinese), taskbarModeBeforeRestoration: structuredClone(chinese), taskbarModeAfterRestoration: structuredClone(english),
    textKeysAttempted: true, spaceAttempted: true, textKeysSent: true, spaceSent: true,
    fieldCleanupAttempted: true, fieldCleared: true, afterCleanupValue: '',
    layoutPreserved: true, focusPreserved: true, languageId: 0x0804,
    beforeValue: '', afterValue: '测试', method: 'guarded-fixed-SendInput-VK-ceshi-Space',
    unicodeInputUsed: false, clipboardUsed: false, imeCompositionVerified: true,
  };
  const report = { ime: structuredClone(result) };
  validate(assert, report, true);
  assert.equal(report.status, 'physical-ime-conversion-passed');
  const unchanged = structuredClone(result);
  Object.assign(unchanged, {
    status: 'not-verified-taskbar-mode-not-prepared', taskbarModeAfterPreparation: english,
    taskbarModeBeforeRestoration: english, modeRestorationAttempted: false, modeRestorationToggleSent: false, taskbarRestoreToggleSent: false, taskbarRestoreShiftSent: false,
    textKeysAttempted: false, spaceAttempted: false, textKeysSent: false, spaceSent: false,
    fieldCleanupAttempted: false, fieldCleared: null, afterCleanupValue: null,
    layoutPreserved: false, focusPreserved: false, afterValue: null, imeCompositionVerified: false,
  });
  const stillEnglish = { ime: unchanged };
  validate(assert, stillEnglish, true);
  assert.equal(stillEnglish.status, 'not-verified-taskbar-mode-not-prepared');
  const ctrl = structuredClone(result);
  Object.assign(ctrl, { modeToggleKey: 'ctrl', modeShiftAttempted: false, modeShiftSent: false, taskbarRestoreShiftSent: false });
  const ctrlReport = { ime: ctrl };
  validate(assert, ctrlReport, true);
  assert.equal(ctrlReport.status, 'physical-ime-conversion-passed');
  const invalid = [
    ['IMM wrongly marked known', value => { value.modeBefore.known = true; }],
    ['unsafe IMM context', value => { value.modeBefore.modeApiUnavailable = false; }],
    ['forged conversion flags', value => { value.modeBefore.conversion = 1; }],
    ['forged full restoration', value => { value.modeRestorationVerified = true; }],
    ['natural probe with Shift', value => { value.naturalModeProbe = true; }],
    ['unknown observation source', value => { value.modeEvidenceSource = 'assumed'; }],
    ['stopped input', value => { value.taskbarInputStopped = true; }],
    ['failed mode restoration', value => { value.taskbarModeRestorationVerified = false; }],
    ['unrecognized action label', value => { value.taskbarModeAfterPreparation.name = '切换到中文模式'; }],
    ['ambiguous initial status', value => { value.taskbarModeInitialObservation.known = false; }],
    ['changed initial full label', value => { value.taskbarModeInitialObservation.name += ' changed'; }],
    ['changed shell owner', value => { value.taskbarModeAfterPreparation.ownerPid++; }],
    ['changed shell creation', value => { value.taskbarModeAfterPreparation.ownerCreationFileTime = '987654321'; }],
    ['changed native taskbar', value => { value.taskbarModeAfterPreparation.taskbarWindowHandle++; }],
    ['changed indicator identity', value => { value.taskbarModeAfterPreparation.runtimeId[2]++; }],
    ['wrong indicator owner', value => { value.taskbarModeAfterPreparation.indicatorPid++; }],
    ['changed focus', value => { value.taskbarModeAfterPreparation.focusAfter.focusWindowHandle++; }],
    ['changed full HKL', value => { value.taskbarModeAfterPreparation.focusBefore.hkl = '0x00000000E0200804'; }],
    ['changed original English suffix', value => { value.taskbarModeAfterRestoration.name += ' changed'; }],
    ['no Chinese preparation', value => { value.taskbarModeAfterPreparation.mode = 'english'; value.taskbarModeAfterPreparation.name = english.name; }],
    ['no recorded restoration key', value => { value.modeRestorationAttempted = false; }],
    ['restoration key sent flag absent', value => { value.taskbarRestoreShiftSent = false; }],
    ['generic restoration key absent', value => { value.taskbarRestoreToggleSent = false; }],
    ['Ctrl wrongly recorded as Shift', value => { value.modeToggleKey = 'ctrl'; }],
    ['wrong committed Chinese value', value => { value.afterValue = '其他'; }],
    ['field not cleared', value => { value.fieldCleared = false; }],
  ];
  assert.throws(() => validate(assert, { ime: structuredClone(result) }, false), assert.AssertionError);
  for (const [label, mutate] of invalid) {
    const altered = structuredClone(result);
    mutate(altered);
    assert.throws(() => validate(assert, { ime: altered }, true), assert.AssertionError, label);
  }
});

test('foreground preparation keeps the original baseline and does not delegate activation to provider focus', () => {
  const preparation = sourceSection('  public object PrepareKeyboardForeground()', '  public object KeyboardFieldState(');
  const activation = preparation.indexOf('SetForegroundWindow(window)');
  assert.ok(activation > preparation.lastIndexOf('Desktop input changed before owned-window activation'));
  assert.ok(activation < preparation.indexOf('Desktop input changed after owned-window activation'));
  assert.match(preparation.slice(0, activation), /Owned UIAutomation root identity changed before activation/);
  assert.match(preparation.slice(activation), /Identity\(false\)/);
  assert.match(preparation.slice(activation), /Owned UIAutomation root identity changed after activation/);
  assert.match(preparation, /\{"uiaFocusAttempted",false\}/);
  assert.match(preparation, /guarded-native-window-activation-without-provider-focus/);
  assert.match(preparation, /Desktop input changed during keyboard foreground preparation/);
  assert.match(preparation, /finally[\s\S]*AttachThreadInput\(currentThread,foregroundThread,false\)/);
  assert.doesNotMatch(preparation, /SetFocus\(\)|SendInput\(|Send\(|Key\(|Click\(|inputTick\s*=/);
});

test('actual foreground method stops on activity or identity changes and always releases a successful temporary attachment', { skip: process.platform !== 'win32' }, async () => {
  const method = sourceSection('  public object PrepareKeyboardForeground()', '  public object KeyboardFieldState(');
  const temporary = await mkdtemp('D:/03_github_projects/Agent_Management/Agent_Resource_Manager/validation/manager-data/native-keyboard-pure-');
  // Extract the actual method. These fakes replace only the OS/provider boundary;
  // no window is opened, focused or enumerated by this compiled contract test.
  const program = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public enum WindowVisualState { Normal, Minimized }
public sealed class WindowInformation { public WindowVisualState WindowVisualState; }
public sealed class RootInformation { public int ProcessId,NativeWindowHandle; }
public sealed class FakeProcess { public int Id=7; }
public sealed class WindowPattern {
  public static readonly object Pattern=new object();
  readonly FakeKeyboardForeground owner;
  public WindowPattern(FakeKeyboardForeground value){owner=value;}
  public WindowInformation Current {get{return new WindowInformation{WindowVisualState=owner.VisualState};}}
  public void SetWindowVisualState(WindowVisualState state){owner.RestoreWindow(state);}
}
public sealed class FakeRoot {
  readonly FakeKeyboardForeground owner;
  public FakeRoot(FakeKeyboardForeground value){owner=value;}
  public RootInformation Current {get{return new RootInformation{ProcessId=owner.RootPidChanged?8:7,NativeWindowHandle=owner.RootHandleChanged?9:1};}}
  public bool TryGetCurrentPattern(object pattern,out object value){value=new WindowPattern(owner);return true;}
}
public sealed class FakeKeyboardForeground {
  struct MSG {}
  readonly IntPtr window=new IntPtr(1);
  IntPtr foreground=new IntPtr(2);
  readonly FakeProcess process=new FakeProcess();
  readonly FakeRoot root;
  readonly uint inputTick=1000;
  bool keyboardInput=true,AccessibilityInput=true,inputChanged,ownerChanged,activationRequested;
  int afterActivationReads;
  public WindowVisualState VisualState=WindowVisualState.Normal;
  public bool RootPidChanged,RootHandleChanged;
  public string Scenario;
  public readonly List<string> Trace=new List<string>();
  public object LastKeyboardForegroundPreparation;
  public int Pid {get{return process.Id;}}
  public long Handle {get{return window.ToInt64();}}
  public FakeKeyboardForeground(){root=new FakeRoot(this);}
  void Identity(bool input){
    if(input)throw new InvalidOperationException("unexpected input authority");
    if(ownerChanged||Scenario=="owner-before")throw new InvalidOperationException("owner identity changed");
  }
  uint LastInputTick(){return inputChanged?1001u:1000u;}
  uint GetCurrentThreadId(){return 1;}
  uint GetWindowThreadProcessId(IntPtr handle,out uint pid){pid=20;return Scenario=="no-foreground-thread"?0u:Scenario=="same-thread"?1u:2u;}
  IntPtr GetForegroundWindow(){
    if(Scenario=="false-then-owned"&&activationRequested&&++afterActivationReads>=3)foreground=window;
    return foreground;
  }
  IntPtr GetAncestor(IntPtr handle,uint flags){return handle;}
  public void RestoreWindow(WindowVisualState state){
    Trace.Add("restore");VisualState=state;
    if(Scenario=="input-at-restore")inputChanged=true;
    if(Scenario=="restore-owned")foreground=window;
  }
  bool PeekMessage(out MSG message,IntPtr handle,uint first,uint last,uint remove){
    message=new MSG();Trace.Add("queue");
    if(Scenario=="input-at-queue")inputChanged=true;
    return false;
  }
  bool AttachThreadInput(uint from,uint to,bool attach){
    Trace.Add(attach?"attach":"detach");
    if(attach){
      if(Scenario=="input-after-attach")inputChanged=true;
      if(Scenario=="owner-after-attach")ownerChanged=true;
      return Scenario!="attach-fail"&&Scenario!="attach-and-activation-fail";
    }
    if(Scenario=="input-after-detach")inputChanged=true;
    return Scenario!="detach-fail";
  }
  bool SetForegroundWindow(IntPtr handle){
    Trace.Add("activate");activationRequested=true;
    if(Scenario=="activation-fail"||Scenario=="attach-and-activation-fail"||Scenario=="false-then-owned")return false;
    foreground=handle;
    if(Scenario=="input-after-activation")inputChanged=true;
    if(Scenario=="owner-after-activation")ownerChanged=true;
    if(Scenario=="root-pid-after")RootPidChanged=true;
    if(Scenario=="root-handle-after")RootHandleChanged=true;
    return true;
  }
  void Wait(Func<bool> expected,string phase){
    // Pure fake bounds observation attempts; the actual helper still uses its
    // unchanged Stopwatch/15-second deadline and actual DWM presentation.
    for(int i=0;i<4;i++)if(expected())return;
    throw new InvalidOperationException(phase);
  }
${method}
  public static object Check(string scenario){
    var value=new FakeKeyboardForeground{Scenario=scenario};
    if(scenario=="already")value.foreground=value.window;
    if(scenario=="input-before")value.inputChanged=true;
    if(scenario=="no-keyboard")value.keyboardInput=false;
    if(scenario=="no-accessibility")value.AccessibilityInput=false;
    if(scenario=="input-at-restore"||scenario=="restore-owned")value.VisualState=WindowVisualState.Minimized;
    if(scenario=="root-pid-before")value.RootPidChanged=true;
    if(scenario=="root-handle-before")value.RootHandleChanged=true;
    bool failed=false;string error=null;object result=null;
    try{result=value.PrepareKeyboardForeground();if(scenario=="repeat")value.PrepareKeyboardForeground();}
    catch(Exception failure){failed=true;error=failure.Message;}
    return new{scenario=scenario,failed=failed,error=error,trace=value.Trace,result=result,diagnostic=value.LastKeyboardForegroundPreparation,baseline=value.inputTick,observedTick=value.LastInputTick()};
  }
}
'@
@('already','success','same-thread','no-foreground-thread','false-then-owned','restore-owned','repeat','no-keyboard','no-accessibility','input-before','input-at-restore','input-at-queue','input-after-attach','input-after-activation','input-after-detach','owner-before','owner-after-attach','owner-after-activation','root-pid-before','root-handle-before','root-pid-after','root-handle-after','activation-fail','attach-fail','attach-and-activation-fail','detach-fail') | ForEach-Object {[FakeKeyboardForeground]::Check($_)} | ConvertTo-Json -Depth 8 -Compress
`;
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 256 * 1024,
    env: { ...process.env, TEMP: temporary, TMP: temporary }, cwd: join(temporary, '..'),
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const cases = new Map(JSON.parse(result.stdout).map(value => [value.scenario, value]));
  assert.equal(cases.size, 26);
  for (const value of cases.values()) {
    assert.equal(value.baseline, 1000, value.scenario);
    assert.ok(value.trace.filter(item => item === 'activate').length <= 1, value.scenario);
    if (value.diagnostic) {
      assert.equal(value.diagnostic.uiaFocusAttempted, false, value.scenario);
      assert.equal(value.diagnostic.uiaFocusReturned, false, value.scenario);
    }
  }
  for (const name of ['already', 'success', 'same-thread', 'no-foreground-thread', 'false-then-owned', 'restore-owned', 'repeat', 'attach-fail']) {
    const value = cases.get(name);
    assert.equal(value.failed, false, name);
    assert.equal(value.result.inputTickBefore, value.result.inputTickAfter, name);
    assert.equal(value.result.foregroundHandle, value.result.windowHandle, name);
    assert.equal(value.result.sentKeyboardOrMouseInput, false, name);
  }
  assert.deepEqual(cases.get('already').trace, []);
  assert.deepEqual(cases.get('restore-owned').trace, ['restore']);
  assert.deepEqual(cases.get('success').trace, ['queue', 'attach', 'activate', 'detach']);
  assert.deepEqual(cases.get('repeat').trace, cases.get('success').trace);
  for (const name of ['same-thread', 'no-foreground-thread']) assert.deepEqual(cases.get(name).trace, ['activate'], name);
  for (const name of ['no-keyboard', 'no-accessibility', 'input-before', 'input-at-restore', 'owner-before', 'root-pid-before', 'root-handle-before']) {
    assert.equal(cases.get(name).failed, true, name);
    assert.equal(cases.get(name).trace.includes('activate'), false, name);
    assert.equal(cases.get(name).trace.includes('attach'), false, name);
  }
  for (const name of ['input-at-queue', 'input-after-attach', 'owner-after-attach']) {
    const value = cases.get(name);
    assert.equal(value.failed, true, name);
    assert.deepEqual(value.trace, ['queue', 'attach', 'detach'], name);
  }
  for (const name of ['input-after-activation', 'input-after-detach', 'owner-after-activation', 'root-pid-after', 'root-handle-after', 'activation-fail', 'detach-fail']) {
    const value = cases.get(name);
    assert.equal(value.failed, true, name);
    assert.deepEqual(value.trace, ['queue', 'attach', 'activate', 'detach'], name);
  }
  assert.match(cases.get('activation-fail').error, /did not become foreground after one native activation attempt/);
  assert.match(cases.get('detach-fail').error, /could not detach its input queue/);
  assert.equal(cases.get('attach-fail').diagnostic.attachSucceeded, false);
  assert.deepEqual(cases.get('attach-fail').trace, ['queue', 'attach', 'activate']);
  assert.equal(cases.get('attach-and-activation-fail').failed, true);
  assert.deepEqual(cases.get('attach-and-activation-fail').trace, ['queue', 'attach', 'activate']);
  assert.match(cases.get('attach-and-activation-fail').error, /did not become foreground/);
  const wait = sourceSection('  void Wait(Func<bool>', '  public void Ready(');
  assert.match(wait, /ElapsedMilliseconds<15000/);
});

test('owned-focus diagnosis observes one guarded focus call without accepting a new input baseline', () => {
  const observation = sourceSection('  Dictionary<string,object> OwnedFocusObservation(', '  public object DiagnoseOwnedFocus()');
  const diagnostic = sourceSection('  public object DiagnoseOwnedFocus()', '  public object PrepareKeyboardForeground()');
  const identity = sourceSection('  void Identity(bool input)', '  uint LastInputTick()');
  const call = diagnostic.indexOf('ownedRoot.SetFocus()');
  assert.match(diagnostic, /!keyboardInput\|\|!AccessibilityInput/);
  assert.equal([...diagnostic.matchAll(/ownedRoot\.SetFocus\(\)/g)].length, 1);
  assert.ok(diagnostic.indexOf('Desktop input changed before the owned-focus diagnostic') < diagnostic.indexOf('FocusDiagnosticOnly=true'));
  assert.ok(diagnostic.indexOf('Owned UIAutomation root identity changed before the focus diagnostic') < diagnostic.indexOf('FocusDiagnosticOnly=true'));
  assert.ok(diagnostic.indexOf('FocusDiagnosticOnly=true') < call);
  assert.ok(diagnostic.indexOf('Desktop input changed immediately before the owned-focus diagnostic') < call);
  assert.ok(call < diagnostic.indexOf('Owned UIAutomation root identity changed after the focus diagnostic'));
  assert.match(diagnostic, /finally\s*\{\s*diagnostic\["focusCallReturnedQpc"\]=Stopwatch\.GetTimestamp\(\)/);
  assert.match(diagnostic, /samples\.Add\(OwnedFocusObservation\("focus-call-returned"\)\)/);
  assert.match(diagnostic, /index<29&&observation\.ElapsedMilliseconds<3000&&LastInputTick\(\)==inputTick/);
  assert.match(diagnostic, /finally\s*\{\s*samples\.Add\(OwnedFocusObservation\("end"\)\)/);
  assert.match(diagnostic, /"input-tick-changed-origin-unknown"/);
  assert.match(diagnostic, /\{"driverKeyboardOrMouseInputSent",false\}/);
  assert.match(diagnostic, /\{"performanceAcceptanceClaimed",false\}/);
  assert.match(diagnostic, /\{"inputOrigin","unknown"\}/);
  assert.doesNotMatch(diagnostic, /inputTick\s*=|SendInput\(|Send\(|Key\(|Click\(|SetForegroundWindow\(|AttachThreadInput\(|SetWindowVisualState\(/);
  assert.match(observation, /Identity\(false\)/);
  for (const field of ['qpcTimestamp', 'inputTick', 'foregroundHandle', 'ownedForeground', 'ownedPid', 'ownedWindowHandle']) assert.ok(observation.includes(`"${field}"`));
  assert.match(identity, /input&&FocusDiagnosticOnly/);
});

test('scoped functional fields select only one exact owned panel and refuse missing or ambiguous targets', { skip: process.platform !== 'win32' }, async () => {
  const method = sourceSection('  AutomationElement Unique(', '  void PresentControl(');
  const temporary = await mkdtemp('D:/03_github_projects/Agent_Management/Agent_Resource_Manager/validation/manager-data/native-field-scope-');
  const program = `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
public enum TreeScope { Descendants }
public enum ControlType { Group, Edit, Spinner }
public abstract class Condition { public abstract bool Matches(AutomationElement element); }
public sealed class PropertyCondition:Condition {
  readonly object property,value;
  public PropertyCondition(object property,object value){this.property=property;this.value=value;}
  public override bool Matches(AutomationElement element){return Object.Equals(property==AutomationElement.NameProperty?(object)element.Name:element.Type,value);}
}
public sealed class AndCondition:Condition {
  readonly Condition first,second;
  public AndCondition(Condition first,Condition second){this.first=first;this.second=second;}
  public override bool Matches(AutomationElement element){return first.Matches(element)&&second.Matches(element);}
}
public sealed class AutomationElementCollection:List<AutomationElement> {}
public sealed class AutomationElement {
  public static readonly object NameProperty=new object(),ControlTypeProperty=new object();
  public string Name,Key; public ControlType Type; public bool IsEnabled=true;
  public List<AutomationElement> Children=new List<AutomationElement>();
  public AutomationElement Current {get{return this;}}
  public AutomationElementCollection FindAll(TreeScope scope,Condition condition){
    var result=new AutomationElementCollection();
    foreach(var child in Children){if(condition.Matches(child))result.Add(child);result.AddRange(child.FindAll(scope,condition));}
    return result;
  }
}
public sealed class ScopedSelector {
  AutomationElement root=new AutomationElement();
  void Wait(Func<bool> expected,string message){for(int index=0;index<4;index++)if(expected())return;throw new InvalidOperationException(message);}
${method}
  public static object Check(string scenario){
    var selector=new ScopedSelector();
    var outside=new AutomationElement{Name="固定版本",Type=ControlType.Edit,Key="outside"};
    var panel=new AutomationElement{Name="更新 Perf Update Fixture",Type=ControlType.Group};
    var target=new AutomationElement{Name="固定版本",Type=ControlType.Edit,Key="inside"};
    selector.root.Children.Add(outside);selector.root.Children.Add(panel);panel.Children.Add(target);
    string scope="更新 Perf Update Fixture";
    if(scenario=="missing-scope")panel.Name="other panel";
    if(scenario=="prefix-scope")panel.Name+=" extra";
    if(scenario=="duplicate-scope")selector.root.Children.Add(new AutomationElement{Name=panel.Name,Type=ControlType.Group});
    if(scenario=="duplicate-field")panel.Children.Add(new AutomationElement{Name=target.Name,Type=ControlType.Edit,Key="duplicate"});
    if(scenario=="missing-field")target.Name="other field";
    if(scenario=="disabled-field")target.IsEnabled=false;
    if(scenario=="unscoped-unique"){selector.root.Children.Remove(panel);scope=null;}
    if(scenario=="unscoped-ambiguous")scope=null;
    try{return new{scenario,failed=false,selected=selector.Unique("固定版本",ControlType.Edit,scope).Key,error=(string)null};}
    catch(Exception error){return new{scenario,failed=true,selected=(string)null,error=error.Message};}
  }
}
'@
@('scoped','missing-scope','prefix-scope','duplicate-scope','duplicate-field','missing-field','disabled-field','unscoped-unique','unscoped-ambiguous') | ForEach-Object {[ScopedSelector]::Check($_)} | ConvertTo-Json -Depth 5 -Compress
`;
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 128 * 1024,
    env: { ...process.env, TEMP: temporary, TMP: temporary }, cwd: join(temporary, '..'),
  });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  const cases = new Map(JSON.parse(result.stdout).map(value => [value.scenario, value]));
  assert.equal(cases.size, 9);
  assert.equal(cases.get('scoped').selected, 'inside');
  assert.equal(cases.get('unscoped-unique').selected, 'outside');
  for (const name of ['missing-scope', 'prefix-scope', 'duplicate-scope', 'duplicate-field', 'missing-field', 'disabled-field', 'unscoped-ambiguous']) {
    assert.equal(cases.get(name).failed, true, name); assert.equal(cases.get(name).selected, null, name);
  }
  assert.match(cases.get('duplicate-scope').error, /Functional scope is ambiguous/);
  for (const name of ['duplicate-field', 'unscoped-ambiguous']) assert.match(cases.get(name).error, /Functional selector is ambiguous/, name);
});

test('actual field method prefers strict numeric ranges and never falls back after range refusal or incorrect readback', { skip: process.platform !== 'win32' }, async () => {
  const method = sourceSection('  public string SetField(', '  public void SelectTab(');
  assert.doesNotMatch(method, /SetFocus\(|SendInput\(|ClickNative\(|\bText\(|inputTick\s*=/);
  const temporary = await mkdtemp('D:/03_github_projects/Agent_Management/Agent_Resource_Manager/validation/manager-data/native-field-pure-');
  const program = `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
public enum ControlType { Spinner, Edit }
public sealed class RangeInformation { public bool IsReadOnly; public double Value,Minimum,Maximum; }
public sealed class ValueInformation { public bool IsReadOnly; public string Value; }
public sealed class RangeValuePattern {
  public static readonly object Pattern=new object();
  readonly FakeNativeField owner;
  public RangeValuePattern(FakeNativeField value){owner=value;}
  public RangeInformation Current {get{return new RangeInformation{IsReadOnly=owner.RangeReadOnly,Value=owner.Number,Minimum=0,Maximum=23};}}
  public void SetValue(double value){
    owner.RangeWrites++;
    if(owner.Scenario=="range-fault")throw new InvalidOperationException("range provider refusal");
    owner.Number=owner.Scenario=="range-wrong-readback"?value+1:value;
  }
}
public sealed class ValuePattern {
  public static readonly object Pattern=new object();
  readonly FakeNativeField owner;
  public ValuePattern(FakeNativeField value){owner=value;}
  public ValueInformation Current {get{return new ValueInformation{IsReadOnly=owner.ValueReadOnly,Value=owner.StringValue};}}
  public void SetValue(string value){
    owner.ValueWrites++;
    if(owner.Scenario!="ordinary-wrong-readback")owner.StringValue=value;
  }
}
public sealed class AutomationElement {
  readonly FakeNativeField owner;
  public AutomationElement(FakeNativeField value){owner=value;}
  public bool TryGetCurrentPattern(object pattern,out object value){
    if(pattern==RangeValuePattern.Pattern){owner.RangeQueries++;value=owner.HasRange?(object)new RangeValuePattern(owner):null;return owner.HasRange;}
    if(pattern==ValuePattern.Pattern){owner.ValueQueries++;value=owner.HasValue?(object)new ValuePattern(owner):null;return owner.HasValue;}
    throw new InvalidOperationException("unexpected provider pattern");
  }
}
public sealed class FakeNativeField {
  public string Scenario,StringValue="20 时";
  public double Number=9;
  public bool HasRange=true,HasValue=true,RangeReadOnly,ValueReadOnly;
  public int RangeQueries,ValueQueries,RangeWrites,ValueWrites,UniqueCalls,PresentCalls;
  public string SelectedType;
  AutomationElement Unique(string name,ControlType type,string scope=null){UniqueCalls++;SelectedType=type.ToString();return new AutomationElement(this);}
  void PresentControl(AutomationElement element){PresentCalls++;}
  void Wait(Func<bool> expected){
    // Wrong provider values must still fail. This fake does not replace the
    // actual helper's unchanged timeout or strict equality predicate.
    for(int index=0;index<4;index++)if(expected())return;
    throw new InvalidOperationException("actual field value mismatch");
  }
${method}
  public static object Check(string scenario){
    var field=new FakeNativeField{Scenario=scenario};string requested="20";bool numeric=true;
    if(scenario=="range-only")field.HasValue=false;
    if(scenario=="numeric-exponent")requested="2e1";
    if(scenario=="decimal")requested="0.1";
    if(scenario=="zero")requested="0";
    if(scenario=="maximum")requested="23";
    if(scenario=="no-range"||scenario=="no-range-readonly")field.HasRange=false;
    if(scenario=="range-readonly")field.RangeReadOnly=true;
    if(scenario=="too-low")requested="-1";
    if(scenario=="too-high")requested="24";
    if(scenario=="nan")requested="NaN";
    if(scenario=="infinity")requested="Infinity";
    if(scenario=="negative-infinity")requested="-Infinity";
    if(scenario=="overflow")requested="1e9999";
    if(scenario=="invalid-number")requested="20,5";
    if(scenario.StartsWith("ordinary-",StringComparison.Ordinal))numeric=false;
    if(scenario=="ordinary-text")requested="文字 NaN";
    if(scenario=="ordinary-number")requested="2e1";
    if(scenario=="ordinary-readonly"||scenario=="no-range-readonly")field.ValueReadOnly=true;
    if(scenario=="unsupported"){field.HasRange=false;field.HasValue=false;}
    if(scenario=="ordinary-no-value")field.HasValue=false;
    bool failed=false;string error=null,result=null;
    try{result=field.SetField("field",requested,numeric);}catch(Exception failure){failed=true;error=failure.Message;}
    return new{scenario=scenario,requested=requested,numeric=numeric,failed=failed,error=error,result=result,
      uniqueCalls=field.UniqueCalls,presentCalls=field.PresentCalls,type=field.SelectedType,
      rangeQueries=field.RangeQueries,valueQueries=field.ValueQueries,rangeWrites=field.RangeWrites,valueWrites=field.ValueWrites,
      number=field.Number,stringValue=field.StringValue};
  }
}
'@
@('both-localized','range-only','numeric-exponent','decimal','zero','maximum','no-range','range-readonly','too-low','too-high','range-fault','range-wrong-readback','nan','infinity','negative-infinity','overflow','invalid-number','ordinary-text','ordinary-number','ordinary-readonly','ordinary-wrong-readback','no-range-readonly','unsupported','ordinary-no-value') | ForEach-Object {[FakeNativeField]::Check($_)} | ConvertTo-Json -Depth 5 -Compress
`;
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 128 * 1024,
    env: { ...process.env, TEMP: temporary, TMP: temporary }, cwd: join(temporary, '..'),
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const cases = new Map(JSON.parse(result.stdout).map(value => [value.scenario, value]));
  assert.equal(cases.size, 24);
  for (const [name, expected] of [['both-localized', '20'], ['range-only', '20'], ['numeric-exponent', '20'], ['decimal', '0.1'], ['zero', '0'], ['maximum', '23']]) {
    const value = cases.get(name);
    assert.equal(value.failed, false, name);
    assert.equal(value.result, expected, name);
    assert.equal(value.type, 'Spinner', name);
    assert.equal(value.rangeQueries, 1, name);
    assert.equal(value.rangeWrites, 1, name);
    assert.equal(value.valueQueries, 0, name);
    assert.equal(value.valueWrites, 0, name);
  }
  assert.equal(cases.get('both-localized').stringValue, '20 时');
  const noRange = cases.get('no-range');
  assert.equal(noRange.failed, false);
  assert.equal(noRange.result, '20');
  assert.equal(noRange.rangeQueries, 1);
  assert.equal(noRange.rangeWrites, 0);
  assert.equal(noRange.valueWrites, 1);
  for (const name of ['range-readonly', 'too-low', 'too-high', 'range-fault', 'range-wrong-readback']) {
    const value = cases.get(name);
    assert.equal(value.failed, true, name);
    assert.equal(value.valueQueries, 0, name);
    assert.equal(value.valueWrites, 0, name);
  }
  assert.equal(cases.get('range-readonly').rangeWrites, 0);
  for (const name of ['too-low', 'too-high']) {
    assert.equal(cases.get(name).rangeWrites, 0, name);
    assert.match(cases.get(name).error, /outside its supported range/);
  }
  assert.match(cases.get('range-fault').error, /provider refusal/);
  assert.match(cases.get('range-wrong-readback').error, /actual field value mismatch/);
  for (const name of ['nan', 'infinity', 'negative-infinity', 'overflow', 'invalid-number']) {
    const value = cases.get(name);
    assert.equal(value.failed, true, name);
    assert.match(value.error, /requires a finite number/, name);
    assert.equal(value.uniqueCalls, 0, name);
    assert.equal(value.presentCalls, 0, name);
    assert.equal(value.rangeQueries + value.valueQueries + value.rangeWrites + value.valueWrites, 0, name);
  }
  for (const name of ['ordinary-text', 'ordinary-number', 'ordinary-readonly', 'ordinary-wrong-readback', 'ordinary-no-value']) {
    const value = cases.get(name);
    assert.equal(value.type, 'Edit', name);
    assert.equal(value.rangeQueries, 0, name);
    assert.equal(value.rangeWrites, 0, name);
  }
  assert.equal(cases.get('ordinary-text').result, '文字 NaN');
  assert.equal(cases.get('ordinary-number').result, '2e1');
  for (const name of ['ordinary-readonly', 'no-range-readonly']) {
    assert.equal(cases.get(name).failed, true, name);
    assert.equal(cases.get(name).valueWrites, 0, name);
    assert.match(cases.get(name).error, /read-only/, name);
  }
  assert.equal(cases.get('ordinary-wrong-readback').failed, true);
  assert.match(cases.get('ordinary-wrong-readback').error, /actual field value mismatch/);
  for (const name of ['unsupported', 'ordinary-no-value']) {
    assert.equal(cases.get(name).failed, true, name);
    assert.match(cases.get(name).error, /no supported value pattern/, name);
    assert.equal(cases.get(name).valueWrites + cases.get(name).rangeWrites, 0, name);
  }
});

test('owned-focus diagnosis seals every later business or input operation while retaining read-only evidence and normal quit', () => {
  const gate = /\$session\.FocusDiagnosticOnly -and \$request\.op -notin @\(([^)]+)\)/.exec(harness);
  assert.ok(gate);
  assert.deepEqual([...gate[1].matchAll(/'([^']+)'/g)].map(match => match[1]), ['memory', 'cache', 'tasks', 'task', 'windowIdentity', 'quit']);
  assert.ok(gate.index < harness.indexOf("$value=switch($request.op)"));
  assert.match(harness, /\$request\.op -eq 'diagnoseOwnedFocus' -and \(\$PrivateUi -or -not \$KeyboardInput -or -not \$AccessibilityInput\)/);
  assert.match(harness, /'diagnoseOwnedFocus'\s*\{\s*try\{\$session\.DiagnoseOwnedFocus\(\)\}\s*finally\{\$report\.ownedFocusDiagnostic=\$session\.LastOwnedFocusDiagnostic\}/);
  assert.match(harness, /\$report\.status=if\(\$session\.FocusDiagnosticOnly\)\{'owned-focus-diagnostic-only'\}/);
  const quit = sourceSection('  public bool Quit()', '  public void StartCheck()');
  assert.match(quit, /InvokePattern/);
  assert.doesNotMatch(quit, /SendInput\(|Send\(|Key\(|SetForegroundWindow\(|SetFocus\(/);
});

test('closed-combo native input preserves parent state, real focus and bounded exact-option checks', () => {
  assert.match(closedCombo, /!keyboardInput\|\|!AccessibilityInput/);
  assert.match(closedCombo, /name!="发行版本"&&name!="发行文件"/);
  assert.match(closedCombo, /KeyboardTarget\(name\)/);
  assert.match(closedCombo, /ControlType\.ComboBox/);
  assert.match(closedCombo, /!combo\.Current\.IsOffscreen&&combo\.Current\.IsEnabled/);
  assert.match(closedCombo, /!combo\.Current\.IsEnabled\|\|expansion\.Current\.ExpandCollapseState!=ExpandCollapseState\.Collapsed/);
  assert.match(closedCombo, /KeyboardFocusOwned\(combo\)/);
  assert.match(closedCombo, /KeyboardFocused\(combo,phase\)/);
  assert.match(closedCombo, /items\.Count>100/);
  assert.match(closedCombo, /matches>1/);
  assert.match(closedCombo, /items\.Count>0&&matches==1/);
  assert.match(closedCombo, /index<navigationCount&&!ComboMatches\(combo,option\)/);
  assert.match(closedCombo, /if\(catalogueOptions==null\)\{\s*Wait\(observe/);
  assert.match(closedCombo, /navigationCount=items\.Count/);
  assert.match(closedCombo, /navigationCount=catalogueOptions\.Length/);
  assert.match(closedCombo, /catalogueOptions\.Length>100/);
  assert.match(closedCombo, /targetMatches!=1/);
  assert.match(closedCombo, /focused\("before-closed-combo-down"\)/);
  assert.match(closedCombo, /focused\("verify-closed-combo-final-selection"\);return ComboMatches\(combo,option\)/);
  assert.match(closedCombo, /diagnostic\["observedSelection"\]=ComboState\(name\)/);
  assert.deepEqual([...closedCombo.matchAll(/Key\((\d+)(?:,true)?\)/g)].map(value => value[1]), ['36', '36', '40', '40']);
  assert.doesNotMatch(closedCombo, /\.Select\(|\.Invoke\(|\.Expand\(|\.Collapse\(|SetValue\(|ClickNative\(|\bText\(|RestoreOwnedForeground|SetForegroundWindow/);
});

test('closed-combo waits for actual retained Home and each changed Down value before another key', () => {
  assert.match(closedCombo, /ValuePattern\.Pattern[\s\S]*Current\.Value/);
  assert.match(closedCombo, /SelectionPattern\.Pattern[\s\S]*GetSelection\(\)[\s\S]*selected\.Length==1/);
  const observationStart = closedCombo.indexOf('string ObserveRetainedSelection(');
  const observationEnd = closedCombo.indexOf('    string beforeHome=', observationStart);
  assert.ok(observationStart >= 0 && observationEnd > observationStart);
  const observation = closedCombo.slice(observationStart, observationEnd);
  assert.match(observation, /focused\("observe-closed-combo-"\+key\)/);
  assert.match(observation, /Array\.IndexOf\(catalogueOptions,observed\)<0/);
  assert.match(observation, /expected!=null\?observed==expected:observed!=previous/);
  assert.match(observation, /if\(ready&&candidate==observed\)/);
  assert.match(observation, /Paint\(\);focused\("verify-closed-combo-"\+key\+"-retained"\)/);
  assert.match(observation, /if\(wait\.ElapsedMilliseconds>=2000\)break/);
  assert.match(observation, /if\(retained==observed&&wait\.ElapsedMilliseconds<2000\)\{step\["status"\]="retained";return retained;\}/);
  assert.match(observation, /wait\.ElapsedMilliseconds<2000/);
  assert.match(observation, /step\["status"\]="failed";step\["error"\]=error\.Message/);
  assert.match(observation, /finally \{step\["elapsedMs"\]=wait\.Elapsed\.TotalMilliseconds;/);
  const home = closedCombo.indexOf('ObserveRetainedSelection("Home",0,beforeHome,homeLabel)');
  const navigation = closedCombo.indexOf('for(int index=0;index<navigationCount');
  assert.ok(home >= 0 && navigation > home);
  assert.match(closedCombo, /homeLabel=name=="发行版本"\?"请选择版本":"请选择发行文件"/);
  const down = closedCombo.slice(navigation, closedCombo.indexOf('diagnostic["stage"]="verify-exact-retained-selection"'));
  const retainedCheck = down.indexOf('if(beforeDown!=retainedSelection)throw');
  const dispatch = down.indexOf('Send(new[]{Key(40),Key(40,true)})');
  const retainedWait = down.indexOf('retainedSelection=ObserveRetainedSelection("Down",index+1,beforeDown,null)');
  assert.ok(retainedCheck >= 0 && dispatch > retainedCheck && retainedWait > dispatch);
  assert.equal([...down.matchAll(/Send\(/g)].length, 1);
  assert.doesNotMatch(closedCombo, /Array\.IndexOf\(catalogueOptions,option\)|targetIndex|optionIndex/);
  assert.match(closedCombo, /diagnostic\["selectionSteps"\]=selectionSteps/);
});

test('raw option state remains evidence and failed input retains its native report', () => {
  assert.match(closedCombo, /enabled=item\.Current\.IsEnabled,offscreen=item\.Current\.IsOffscreen/);
  const enumeration = closedCombo.slice(closedCombo.indexOf('foreach(AutomationElement item in items)'), closedCombo.indexOf('diagnostic["options"]'));
  assert.doesNotMatch(enumeration, /if\([^\n]*(?:IsEnabled|IsOffscreen)|enabled=true|offscreen=false/);
  assert.match(harness, /finally\{\$report.closedComboSelection=\$session.LastClosedComboSelection\}/);
  assert.match(harness, /\$PrivateUi -or -not \$KeyboardInput -or -not \$AccessibilityInput/);
  const preparation = sourceSection('  public object PrepareKeyboardForeground()', '  public object KeyboardFieldState(');
  assert.match(preparation, /!keyboardInput\|\|!AccessibilityInput/);
  const guard = sourceSection('  void KeyboardGuard(', '  void KeyboardFocused(');
  assert.match(guard, /Identity\(true\)/);
  assert.match(guard, /currentTick!=inputTick/);
});

test('the default selectCombo request retains its existing route without keyboard opt-in', async () => {
  const { app, requests } = session({ keyboardInput: false });
  const fields = { name: 'existing exact combo', option: 'existing option' };
  await app.call('selectCombo', fields);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { ...fields, id: 1, op: 'selectCombo' });
  const original = sourceSection('  public string SelectCombo(', '  public bool SetToggle(');
  assert.match(original, /if\(AccessibilityInput&&!foreground\)/);
  assert.match(original, /target=ExactComboOption\(combo,option\)/);
  assert.match(original, /Exact enabled, visible combo option|exact enabled, visible combo option/);
  assert.match(original, /Wait\(\(\)=>ComboMatches\(combo,option\)/);
  assert.doesNotMatch(original, /KeyboardSelectClosedCombo\(|KeyboardIme\(/);
});

test('popup selection requires explicit non-private keyboard and accessibility approval before a request', async () => {
  for (const options of [{ privateUi: true }, { keyboardInput: false }, { keyboardInput: undefined }, { accessibilityInput: false }, { accessibilityInput: undefined }, { accessibilityInput: 'true' }]) {
    const { app, requests } = session(options);
    await assert.rejects(app.call('keyboardSelectPopupCombo', { name: '发行版本', option: 'target', catalogueOptions: ['请选择版本', 'target'] }), /explicitly enabled non-private/);
    assert.equal(requests.length, 0);
  }
  assert.match(popupCombo, /!keyboardInput\|\|!AccessibilityInput/);
  assert.match(harness, /\$request.op -eq 'keyboardSelectPopupCombo' -and \(\$PrivateUi -or -not \$KeyboardInput -or -not \$AccessibilityInput\)/);
});

test('popup selection requires the exact GitHub field and completed unique placeholder-first catalogue', async () => {
  const { app, requests } = session();
  for (const name of ['发行版本 extra', '搜索 Skill', '', null, 1]) {
    await assert.rejects(app.call('keyboardSelectPopupCombo', { name, option: 'target', catalogueOptions: ['请选择版本', 'target'] }), /restricted to the two GitHub release fields/);
  }
  for (const option of ['', null, undefined, 1, 'line\nbreak', '\u0000', '\u007f', '\u009f', 'a'.repeat(513)]) {
    await assert.rejects(app.call('keyboardSelectPopupCombo', { name: '发行版本', option, catalogueOptions: ['请选择版本', 'target'] }), /exact bounded ordinary option name/);
  }
  for (const catalogueOptions of [undefined, null, '', [], ['target'], ['请选择发行文件', 'target'], ['请选择版本', 'other'], ['请选择版本', 'target', 'target'], ['请选择版本', 'target', 1], ['请选择版本', 'target', '\n'], ['请选择版本', 'target', 'a'.repeat(513)], Array.from({ length: 101 }, (_, i) => i ? i === 1 ? 'target' : `v${i}` : '请选择版本')]) {
    await assert.rejects(app.call('keyboardSelectPopupCombo', { name: '发行版本', option: 'target', catalogueOptions }), /catalogue requires/);
  }
  assert.equal(requests.length, 0);
  for (const [name, placeholder] of [['发行版本', '请选择版本'], ['发行文件', '请选择发行文件']]) {
    const catalogueOptions = [placeholder, 'other', 'target'];
    const result = await app.call('keyboardSelectPopupCombo', { name, option: 'target', catalogueOptions });
    assert.equal(result.op, 'keyboardSelectPopupCombo');
    assert.equal(result.name, name);
    assert.deepEqual(result.catalogueOptions, catalogueOptions);
  }
  assert.equal(requests.length, 2);
  assert.match(popupCombo, /catalogueOptions==null\|\|catalogueOptions\.Length<1\|\|catalogueOptions\.Length>100/);
  assert.match(popupCombo, /if\(!unique\.Add\(label\)\)throw/);
  assert.match(popupCombo, /catalogueOptions\[0\]!=placeholder\|\|targetIndex<0/);
  assert.match(harness, /\$request.catalogueOptions -isnot \[array\][\s\S]*Where-Object \{\$_ -isnot \[string\]\}/);
});

test('each popup key requires bounded exact RawView ancestry and Win32 root-owner focus', () => {
  const guard = popupCombo.slice(popupCombo.indexOf('void GuardPopupFocus('), popupCombo.indexOf('void SendPopupKey('));
  assert.match(guard, /KeyboardGuard\(phase\)/);
  assert.match(guard, /combo\.Current\.IsOffscreen\|\|!combo\.Current\.IsEnabled/);
  assert.match(guard, /focused==null\|\|!focused\.Current\.HasKeyboardFocus\|\|focused\.Current\.IsOffscreen/);
  assert.match(guard, /ancestor!=null&&depth<32/);
  assert.match(guard, /TreeWalker\.RawViewWalker\.GetParent\(ancestor\)/);
  assert.match(guard, /if\(Automation\.Compare\(ancestor,combo\)\)\{exactFocus=true;break;\}/);
  assert.match(guard, /if\(!exactFocus\)throw/);
  assert.match(guard, /!GetGUIThreadInfo\(0,ref info\)\|\|info\.focus==IntPtr\.Zero/);
  assert.match(guard, /GetAncestor\(info\.focus,2\),focusOwner=GetAncestor\(info\.focus,3\)/);
  assert.match(guard, /if\(focusRoot!=window&&focusOwner!=window\)throw/);
  assert.ok(guard.indexOf('diagnostic["lastFocus"]=focusState') < guard.indexOf('KeyboardGuard(phase)'));
  assert.ok(guard.indexOf('focusState["rawViewOwned"]=exactFocus') < guard.indexOf('if(!exactFocus)throw'));
  assert.ok(guard.indexOf('focusState["win32Owned"]=focusRoot==window||focusOwner==window') < guard.indexOf('if(focusRoot!=window&&focusOwner!=window)throw'));
  assert.doesNotMatch(guard, /OwnedProcessFamily|\.ProcessId|GetWindowThreadProcessId|owned\.Contains/);
  const key = popupCombo.slice(popupCombo.indexOf('void SendPopupKey('), popupCombo.indexOf('diagnostic["stage"]="open-exact-popup"'));
  const focus = key.indexOf('GuardPopupFocus("before-popup-"+key,true)');
  const activity = key.indexOf('KeyboardGuard("dispatch-popup-"+key)');
  const send = key.indexOf('Send(new[]{Key(code),Key(code,true)})');
  assert.ok(focus >= 0 && activity > focus && send > activity);
  assert.match(key, /KeyboardSettled\("after-popup-"\+key\+"-paint"\)/);
  assert.doesNotMatch(popupCombo, /\.Select\(|\.Invoke\(|\.Expand\(|\.Collapse\(|SetValue\(|\bText\(|SetFocus\(|RestoreOwnedForeground|SetForegroundWindow/);
});

test('popup navigation uses one exact hit-tested click and commits bounded catalogue keys before exact retained validation', () => {
  assert.match(popupCombo, /KeyboardTarget\(name\)/);
  assert.match(popupCombo, /ControlType\.ComboBox/);
  assert.match(popupCombo, /expansion\.Current\.ExpandCollapseState!=ExpandCollapseState\.Collapsed/);
  assert.match(popupCombo, /ComboPointerState\("before-popup-pointer",combo,out hitsCombo\)/);
  const hitCheck = popupCombo.indexOf('if(!hitsCombo)throw');
  const pointer = popupCombo.indexOf('ClickNative(combo)');
  const expansion = popupCombo.indexOf('return expansion.Current.ExpandCollapseState==ExpandCollapseState.Expanded');
  const home = popupCombo.indexOf('SendPopupKey("Home",36)');
  const down = popupCombo.indexOf('for(int index=0;index<targetIndex;index++){SendPopupKey("Down",40)');
  const enter = popupCombo.indexOf('SendPopupKey("Enter",13)');
  const exact = popupCombo.indexOf('ExpandCollapseState.Collapsed&&ComboMatches(combo,option)');
  const finalFocus = popupCombo.indexOf('GuardPopupFocus("verify-popup-combo-retained-focus",false)');
  const selected = popupCombo.indexOf('diagnostic["selected"]=option');
  assert.ok(hitCheck >= 0 && pointer > hitCheck && expansion > pointer && home > expansion && down > home && enter > down && exact > enter && finalFocus > exact && selected > finalFocus);
  assert.equal([...popupCombo.matchAll(/ClickNative\(/g)].length, 1);
  assert.equal([...popupCombo.matchAll(/ComboMatches\(/g)].length, 1, 'Only the committed value is required while the popup is collapsed.');
  assert.match(popupCombo, /KeyboardGuard\("verify-popup-combo-committed-value"\)/);
  assert.match(popupCombo, /diagnostic\["expandedState"\]=ComboState\(name\)/);
  assert.match(popupCombo, /diagnostic\["observedSelection"\]=ComboState\(name\)/);
  assert.match(popupCombo, /\{"functionalOnly",true\}/);
  assert.match(popupCombo, /LastPopupComboSelection=null/);
  assert.match(popupCombo, /diagnostic\["error"\]=error.Message;diagnostic\["status"\]="failed-or-blocked"/);
  assert.match(harness, /finally\{\$report.popupComboSelection=\$session.LastPopupComboSelection\}/);
});

test('popup CLI is explicit loads-only and mutually exclusive before any native launch', async () => {
  const runner = await readFile(new URL('../scripts/verify-uia-performance.mjs', import.meta.url), 'utf8');
  const dependencyStart = runner.indexOf('function validateLoadSelection(options, suite) {');
  const dependencyEnd = runner.indexOf('if (options.help)', dependencyStart);
  const start = runner.indexOf("const suite = options.suite || 'all';");
  const end = runner.indexOf('const inputCondition', start);
  assert.ok(dependencyStart >= 0 && dependencyEnd > dependencyStart && dependencyEnd < start);
  assert.ok(start >= 0 && end > start);
  const validate = new Function('options', runner.slice(dependencyStart, dependencyEnd) + runner.slice(start, end) + ';return {popupSelection,closedSelection,foregroundSelection};');
  const loadFixtures = { 'download-spec': 'synthetic-download-spec.json', 'stage-fixture': 'synthetic-stage-fixture.json' };
  const permitted = { ...loadFixtures, suite: 'loads', 'accessibility-input': true, 'popup-select': 'true' };
  assert.deepEqual(validate(permitted), { popupSelection: true, closedSelection: false, foregroundSelection: false });
  assert.deepEqual(validate({}), { popupSelection: false, closedSelection: false, foregroundSelection: false });
  assert.equal(validate({ 'popup-select': 'false' }).popupSelection, false);
  assert.equal(validate({ ...loadFixtures, suite: 'loads', 'accessibility-input': true, 'closed-select': 'true' }).closedSelection, true);
  assert.equal(validate({ 'foreground-select': true }).foregroundSelection, true);
  for (const value of [true, false, '', 'TRUE', 1]) {
    assert.throws(() => validate({ ...permitted, 'popup-select': value }), /requires an explicit true or false/);
  }
  for (const options of [{ ...permitted, suite: 'all' }, { ...permitted, suite: 'interactive' }, { ...permitted, 'accessibility-input': undefined }, { ...permitted, 'closed-select': 'true' }, { ...permitted, 'foreground-select': 'true' }]) {
    assert.throws(() => validate(options), /popup-select requires/);
  }
  assert.ok(end < runner.indexOf('await mkdir('));
  assert.match(runner, /report\.popupSelectionRequested = popupSelection/);
  assert.match(runner, /\(foregroundSelection \|\| closedSelection \|\| popupSelection\)/);
  assert.match(runner, /app\.popupComboSelection = popupSelection/);
  assert.match(runner, /awaitForeground && \(closedSelection \|\| popupSelection\)/);
  assert.match(runner, /awaitForeground && !closedSelection && !popupSelection/);
  assert.match(runner, /This functional setup is excluded from measured P95 samples/);
});

test('loads route popup selection explicitly and stop on failure or mismatched exact functional result', async () => {
  const loads = await readFile(new URL('../scripts/native-uia-loads.mjs', import.meta.url), 'utf8');
  const start = loads.indexOf('async function select(');
  const end = loads.indexOf('async function actionTask(', start);
  assert.ok(start >= 0 && end > start);
  const select = new Function('fieldName', loads.slice(start, end) + ';return select;')(async (_app, prefix) => prefix);
  const catalogueOptions = ['请选择版本', 'target'];
  for (const [mode, operation] of [['popupComboSelection', 'keyboardSelectPopupCombo'], ['closedComboSelection', 'keyboardSelectClosedCombo'], ['foregroundSelection', 'selectCombo']]) {
    const calls = [];
    const app = { [mode]: true, accessibilityInput: true, async call(op, fields) { calls.push({ op, fields }); return { selected: fields.option, functionalOnly: true }; } };
    await select(app, '发行版本', 'target', true, catalogueOptions);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].op, operation);
    if (mode !== 'foregroundSelection') assert.deepEqual(calls[0].fields.catalogueOptions, catalogueOptions);
    assert.equal(app.functionalSelections.length, 1);
  }
  for (const result of [new Error('fixture focus stop'), { selected: 'other', functionalOnly: true }, { selected: 'target', functionalOnly: false }]) {
    const calls = [];
    const app = { popupComboSelection: true, async call(op) { calls.push(op); if (result instanceof Error) throw result; return result; } };
    await assert.rejects(select(app, '发行版本', 'target', true, catalogueOptions), /fixture focus stop|exact native dropdown selection/);
    assert.deepEqual(calls, ['keyboardSelectPopupCombo']);
    assert.equal(app.functionalSelections, undefined);
  }
  assert.match(loads, /const releaseLabels = \['请选择版本', \.\.\.query.result.releases.map/);
  assert.match(loads, /\['请选择发行文件', \.\.\.release.assets.map\(assetLabel\)\]/);
  assert.match(loads, /if \(!nativeDownloadPreviewMatches\(preview, specification\)\) throw/);
  const previewCheck = loads.slice(loads.indexOf('export function nativeDownloadPreviewMatches('), loads.indexOf('export async function beginUiaNativeDownload('));
  assert.match(previewCheck, /preview\?\.canApply === true && preview.alreadyComplete === false/);
  assert.match(previewCheck, /preview.releaseId === specification.releaseId && preview.assetId === specification.assetId/);
  assert.match(previewCheck, /preview.repository === `https:\/\/github.com\/\$\{specification.repository\}`/);
  assert.match(previewCheck, /typeof preview.targetPath === 'string' && within\(preview.targetPath, specification.directory\)/);
});
