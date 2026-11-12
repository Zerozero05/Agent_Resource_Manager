import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { NativeUiaSession } from './native-uia-client.mjs';

const execute = promisify(execFile);
const format = 'agent-resource-manager-native-appearance-copy-v1';
const settingsFormat = 'agent-resource-manager-native-settings-v1';
const driverFormat = 'agent-resource-manager-native-performance-v1';
const dataParent = 'D:\\03_github_projects\\Agent_Resource_Manager\\validation\\manager-data';
const resourceParent = 'D:\\03_github_projects\\Agent_Resource_Manager\\validation\\resources';
const options = Object.fromEntries(process.argv.slice(2).reduce((entries, flag, index, all) => flag.startsWith('--') ? [...entries, [flag.slice(2), all[index + 1]]] : entries, []));
if (Object.hasOwn(options, 'transport-file-sha256') && (typeof options['transport-file-sha256'] !== 'string' || !/^[a-f0-9]{64}$/i.test(options['transport-file-sha256']))) throw new Error('--transport-file-sha256 requires one exact SHA256 digest.');
const requestedTransportSha256 = options['transport-file-sha256']?.toLowerCase();
const targetAppearance = { uiTheme: 'eye', uiAccent: 'teal', uiDensity: 'compact', uiMotion: 'none', uiFontSize: 20 };
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = async path => hash(await readFile(path));
const normalized = path => resolve(path.replace(/^\\\\\?\\(?=[a-z]:\\)/i, ''));
const same = (left, right) => normalized(left).toLowerCase() === normalized(right).toLowerCase();
const inside = (path, root) => { const value = relative(normalized(root), normalized(path)); return value === '' || !value.startsWith('..') && !isAbsolute(value); };
const json = value => JSON.stringify(value, null, 2) + '\n';
const sleep = ms => new Promise(done => setTimeout(done, ms));

function persisted(fixture) {
  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try { return JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id=1').get().payload); }
  finally { db.close(); }
}

async function prepare() {
  assert.ok(!options.prepared && !options.candidate && !options['candidate-build-info'], 'Preparation takes no existing data or candidate.');
  const script = fileURLToPath(new URL('verify-native-settings.mjs', import.meta.url));
  const { stdout } = await execute(process.execPath, [script, '--phase', 'prepare'], { windowsHide: true, timeout: 20000, maxBuffer: 128 * 1024, env: { ...process.env, TEMP: dataParent, TMP: dataParent } });
  const prepared = JSON.parse(stdout.trim());
  assert.equal(prepared.status, 'prepared-not-run', 'The reused settings preparer did not finish preparation.');
  assert.equal(prepared.noNativeLaunch, true, 'The reused preparation must not launch a native application.');
  const fixture = await readFixture(prepared.fixture);
  const descriptor = join(fixture.root, 'appearance-copy-dataset.json');
  await writeFile(descriptor, json({ format, settingsFixture: prepared.fixture, syntheticOnly: true, createdAt: new Date().toISOString() }), { flag: 'wx' });
  console.log(JSON.stringify({ status: 'prepared-not-run', prepared: descriptor, report: join(fixture.root, 'appearance-copy-result.json'), noNativeLaunch: true }));
}

async function readFixture(path) {
  assert.ok(inside(path, dataParent) && basename(path) === 'dataset.json', 'The settings descriptor must be dataset.json under the approved manager-data directory.');
  const fixture = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(fixture.format, settingsFormat, 'The existing settings fixture format does not match.');
  assert.equal(fixture.driverFormat, driverFormat, 'The fixture native driver format does not match.');
  assert.equal(fixture.syntheticOnly, true, 'The fixture must contain only generated data.');
  assert.equal(fixture.skillCount, 2, 'Appearance acceptance requires the two-Skill settings fixture.');
  assert.equal(fixture.toolCount, 0, 'Appearance acceptance must not register tools.');
  assert.equal(fixture.scenario, undefined, 'The extended settings scenario is outside this focused appearance test.');
  assert.ok(same(dirname(path), fixture.root) && inside(fixture.resourcesRoot, resourceParent), 'The descriptor and resource roots must match the approved fixture locations.');
  assert.ok(same(fixture.dataDir, join(fixture.root, 'data')) && same(fixture.dbPath, join(fixture.dataDir, 'manager.sqlite3')), 'The generated database must remain in the exact fixture data directory.');
  for (const directory of [fixture.root, fixture.dataDir, fixture.resourcesRoot]) assert.ok(same(await realpath(directory), directory), `A fixture directory was redirected: ${directory}.`);
  const owner = JSON.parse(await readFile(join(fixture.root, 'fixture-owner.json'), 'utf8'));
  assert.equal(owner.format, driverFormat, 'The fixture ownership marker has the wrong native format.');
  assert.equal(owner.settingsFormat, settingsFormat, 'The fixture ownership marker has the wrong settings format.');
  assert.equal(owner.syntheticOnly, true, 'The ownership marker must identify generated data.');
  assert.equal(await digest(fixture.dbPath), fixture.initialDatabaseSha256, 'Previously used fixtures are not replayed.');
  await verifyFiles(fixture);
  return fixture;
}

async function verifyFiles(fixture) {
  for (const file of fixture.sourceFiles) {
    assert.ok(inside(file.path, fixture.resourcesRoot) && same(await realpath(file.path), file.path), `A generated source file escaped or redirected its approved resource root: ${file.path}.`);
    assert.equal(await digest(file.path), file.sha256, `A generated source file changed: ${file.path}.`);
  }
}

async function candidate() {
  assert.equal(typeof options.candidate, 'string', 'The native candidate executable is required.');
  assert.equal(typeof options['candidate-build-info'], 'string', 'The native candidate build information is required.');
  const path = resolve(options.candidate), buildInfoPath = resolve(options['candidate-build-info']);
  assert.equal(basename(path).toLowerCase(), 'agent-resource-manager.exe', 'The selected executable must be the resource manager candidate.');
  const bytes = await readFile(path), offset = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.readUInt16LE(0), 0x5a4d, 'The candidate is missing the Windows MZ header.');
  assert.equal(bytes.readUInt32LE(offset), 0x4550, 'The candidate is missing the Windows PE header.');
  assert.equal(bytes.readUInt16LE(offset + 4), 0x8664, 'The native candidate must be x64.');
  const info = JSON.parse(await readFile(buildInfoPath, 'utf8'));
  assert.equal(info.buildMode, 'release', 'Appearance acceptance requires a release candidate.');
  assert.equal((info.executableSha256 || info.sha256)?.toLowerCase(), hash(bytes), 'The candidate executable does not match its build information.');
  assert.equal(typeof info.version, 'string', 'The build information must contain the exact product version.');
  return { path, sha256: hash(bytes), buildInfoPath, buildInfoSha256: await digest(buildInfoPath), sourceIdentity: info.sourceIdentity || info.sourceCommit, version: info.version };
}

async function wait(read, accepts, description) {
  const deadline = Date.now() + 20000;
  for (;;) {
    const value = await read();
    if (accepts(value)) return value;
    assert.ok(Date.now() < deadline, `Native appearance observation unavailable: ${description}. No action was replayed.`);
    await sleep(50);
  }
}

async function invoke(app, name, scope) {
  await wait(() => app.call('state', { name, ...(scope ? { scope } : {}) }), rows => list(rows).filter(row => row.type === 'ControlType.Button' && row.enabled).length === 1, name);
  return app.call('invokeName', { name, ...(scope ? { scope } : {}) });
}

async function settingsGroup(app, group) {
  await invoke(app, '设置', '主要导航');
  // Names supplies only name/type. Enabled and visibility are inspected through
  // state immediately before an exact scoped invocation.
  const settingsNames = await wait(() => app.call('names'), rows => list(rows).some(row => row.type === 'ControlType.Button' && row.name.startsWith('设置分类：')), 'the actual settings classification toggle');
  const rows = list(await app.call('state', { name: group })).filter(row => row.type === 'ControlType.Button' && row.enabled && !row.offscreen);
  const toggles = list(settingsNames).filter(row => row.type === 'ControlType.Button' && row.name.startsWith('设置分类：'));
  assert.equal(toggles.length, 1, `The settings classification toggle must be unique before selecting ${group}.`);
  if (!rows.length) {
    await invoke(app, toggles[0].name);
  }
  await invoke(app, group, '设置分类');
  await wait(() => app.call('state', { name: `设置分类：${group}` }), values => list(values).filter(row => row.type === 'ControlType.Button' && row.enabled).length === 1, `the selected settings classification ${group}`);
  return { group, previousToggle: toggles[0].name, openedClassification: !rows.length, selectedToggle: `设置分类：${group}` };
}

async function select(app, name, option) {
  const selected = await app.call('selectCombo', { name, option });
  assert.equal(selected.selected, option, `Native selection returned the wrong value for ${name}.`);
  const state = await app.call('comboState', { name });
  assert.ok(state.value === option || state.selected.includes(option), `Native selection did not retain ${name}.`);
  return { name, option, state };
}

// These Windows calls inspect clipboard metadata only. No content, original
// clipboard copy, clearing operation or synthetic clipboard prefill is used.
async function clipboardMetadata(temporary) {
  const command = `$ErrorActionPreference='Stop';Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class AppearanceClipboardMetadata{[StructLayout(LayoutKind.Sequential)]public struct InputInfo{public uint size,tick;}[DllImport("user32.dll",SetLastError=true)]public static extern bool OpenClipboard(IntPtr owner);[DllImport("user32.dll",SetLastError=true)]public static extern bool CloseClipboard();[DllImport("user32.dll",SetLastError=true)]public static extern int CountClipboardFormats();[DllImport("user32.dll")]public static extern uint GetClipboardSequenceNumber();[DllImport("user32.dll")]public static extern bool GetLastInputInfo(ref InputInfo value);}';if(-not [AppearanceClipboardMetadata]::OpenClipboard([IntPtr]::Zero)){throw 'Clipboard metadata is temporarily unavailable.'};try{$count=[AppearanceClipboardMetadata]::CountClipboardFormats();$sequence=[AppearanceClipboardMetadata]::GetClipboardSequenceNumber();$clipboardActivityInfo=[AppearanceClipboardMetadata+InputInfo]::new();$clipboardActivityInfo.size=8;if(-not [AppearanceClipboardMetadata]::GetLastInputInfo([ref]$clipboardActivityInfo)){throw 'Desktop activity metadata unavailable.'};[pscustomobject]@{formatCount=$count;sequence=$sequence;lastInputTick=$clipboardActivityInfo.tick;contentsRead=$false}|ConvertTo-Json -Compress}finally{if(-not [AppearanceClipboardMetadata]::CloseClipboard()){throw 'Clipboard metadata lock was not released.'}}`;
  const pending = execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 20000, maxBuffer: 64 * 1024, env: { ...process.env, TEMP: temporary, TMP: temporary } });
  pending.child.stdin.end();
  const { stdout } = await pending;
  const result = JSON.parse(stdout.trim());
  assert.ok(Number.isSafeInteger(result.formatCount) && result.formatCount >= 0 && Number.isSafeInteger(result.sequence) && result.sequence > 0, 'Clipboard metadata must contain valid format count and nonzero sequence.');
  assert.equal(result.contentsRead, false, 'Clipboard inspection must not read clipboard contents.');
  assert.ok(Number.isSafeInteger(result.lastInputTick) && result.lastInputTick >= 0, 'Desktop activity must be observable before copying.');
  return result;
}

export function clipboardStillEmpty(before, current) {
  return before.formatCount === 0 && current.formatCount === 0 && before.sequence > 0
    && current.sequence === before.sequence && Number.isSafeInteger(before.lastInputTick)
    && current.lastInputTick === before.lastInputTick;
}

function clipboardFailure(error) {
  if (!error || typeof error !== 'object' || !('cmd' in error || 'stderr' in error || error.killed)) return { error: String(error?.message || error).slice(0, 1200) };
  return {
    error: 'The bounded clipboard helper failed before verification completed.',
    helperExitCode: error.code ?? null, helperSignal: error.signal ?? null, helperTimedOut: error.killed === true,
    helperStderr: String(error.stderr || '').replace(/\x1b\[[0-9;]*m/g, '').replace(/[A-Za-z0-9+/=]{160,}/g, '[encoded output omitted]').slice(0, 1800),
  };
}

// Only the exact generated preview is read through UIA. Clipboard data is not
// requested until the owned process family, sequence and desktop activity pass
// checks while OpenClipboard is held. Neither text is returned or logged.
export const diagnosticClipboardReader = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Automation;
public static class DiagnosticClipboardRead {
  [StructLayout(LayoutKind.Sequential)] struct InputInfo { public uint size,tick; }
  [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr owner);
  [DllImport("user32.dll")] static extern bool CloseClipboard();
  [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll")] static extern IntPtr GetClipboardOwner();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32.dll")] static extern bool IsClipboardFormatAvailable(uint format);
  [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint format);
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref InputInfo value);
  [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr memory);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr memory);
  [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr memory);
  static string Normalize(string value) { return value.Replace("\r\n","\n"); }
  static string Hash(string value) { return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant(); }
  static uint Tick() { var input=new InputInfo{size=8};if(!GetLastInputInfo(ref input))throw new InvalidOperationException("Input activity unavailable");return input.tick; }
  static void Require(bool condition) { if(!condition)throw new InvalidOperationException("Owned diagnostic copy conditions did not hold"); }
  public static Dictionary<string,object> Verify(string encoded) {
    var result=new Dictionary<string,object>{{"status","unverified-owned-text-unavailable"},{"clipboardContentsRead",false},{"clipboardContentsVerified",false},{"originalClipboardRead",false},{"clipboardLockReleased",false}};
    bool opened=false;
    try {
      Require(Thread.CurrentThread.GetApartmentState()==ApartmentState.STA);
      using var document=JsonDocument.Parse(Encoding.UTF8.GetString(Convert.FromBase64String(encoded)));
      var spec=document.RootElement;int appPid=spec.GetProperty("pid").GetInt32();
      long created=long.Parse(spec.GetProperty("creationFileTime").GetString());
      using var app=Process.GetProcessById(appPid);
      Require(!app.HasExited&&app.StartTime.ToUniversalTime().ToFileTimeUtc()==created);
      Require(String.Equals(Path.GetFullPath(app.MainModule.FileName),Path.GetFullPath(spec.GetProperty("executable").GetString()),StringComparison.OrdinalIgnoreCase));
      var window=new IntPtr(spec.GetProperty("windowHandle").GetInt64());uint windowPid;
      GetWindowThreadProcessId(window,out windowPid);Require(windowPid==(uint)appPid);
      var root=AutomationElement.FromHandle(window);
      var matches=root.FindAll(TreeScope.Descendants,new AndCondition(
        new PropertyCondition(AutomationElement.NameProperty,"可复制的诊断摘要"),
        new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Edit)));
      Require(matches.Count==1&&!matches[0].Current.IsPassword&&!matches[0].Current.IsOffscreen);
      object available;Require(matches[0].TryGetCurrentPattern(ValuePattern.Pattern,out available));
      var preview=(ValuePattern)available;Require(preview.Current.IsReadOnly);
      string expected=Normalize(preview.Current.Value);const int limit=32768;
      Require(expected.Length>0&&expected.Length<=limit);
      string version=spec.GetProperty("version").GetString();int skills=spec.GetProperty("skillCount").GetInt32();
      Require(expected.StartsWith("Agent 资源管理器 · 诊断摘要\n",StringComparison.Ordinal));
      Require(expected.Contains("\n程序自报版本："+version+"\n")&&expected.Contains("\n运行模式：普通模式\n"));
      Require(expected.Contains("\n已登记 Skill："+skills+"；来源异常：0\n")&&expected.Contains("\n问题类别与记录阶段：\n"));
      Require(expected.EndsWith("摘要不包含账号、凭据、仓库名、路径、原始错误、调用参数或文件内容；仅复制到本机剪贴板，不上传。",StringComparison.Ordinal));
      Require(!Regex.IsMatch(expected,@"(?i)([a-z]:[\\/]|github_pat_|PRIVATE_PATH_MARKER|NATIVE_SETTINGS_ERROR_MARKER|NATIVE_SETTINGS_CONTENT_MARKER)"));
      result["previewValidated"]=true;result["previewSha256"]=Hash(expected);result["previewLength"]=expected.Length;
      uint inputTick=spec.GetProperty("lastInputTick").GetUInt32();Require(Tick()==inputTick);
      var family=new Dictionary<int,long>();
      foreach(var member in spec.GetProperty("processes").EnumerateArray())family.Add(member.GetProperty("pid").GetInt32(),long.Parse(member.GetProperty("creationFileTime").GetString()));
      Require(family.Count>0&&family.Count<=64&&family.TryGetValue(appPid,out long appTime)&&appTime==created);
      Require(OpenClipboard(IntPtr.Zero));opened=true;
      uint sequence=GetClipboardSequenceNumber();result["sequenceBeforeRead"]=sequence;
      Require(sequence!=0&&sequence!=spec.GetProperty("beforeSequence").GetUInt32()&&Tick()==inputTick);
      IntPtr owner=GetClipboardOwner();uint ownerPid;Require(owner!=IntPtr.Zero);
      GetWindowThreadProcessId(owner,out ownerPid);Require(family.TryGetValue((int)ownerPid,out long ownerTime));
      using(var ownerProcess=Process.GetProcessById((int)ownerPid))Require(!ownerProcess.HasExited&&ownerProcess.StartTime.ToUniversalTime().ToFileTimeUtc()==ownerTime);
      result["ownerPid"]=ownerPid;result["ownerVerified"]=true;
      Require(IsClipboardFormatAvailable(13)&&GetClipboardSequenceNumber()==sequence&&Tick()==inputTick);
      IntPtr memory=GetClipboardData(13);result["clipboardContentsRead"]=true;Require(memory!=IntPtr.Zero);
      ulong bytes=GlobalSize(memory).ToUInt64();Require(bytes>=2&&bytes<=2UL*(limit+1)&&bytes%2==0);
      IntPtr text=GlobalLock(memory);Require(text!=IntPtr.Zero);string actual;
      try {
        var value=new StringBuilder();bool terminated=false;
        for(int index=0;index<(int)bytes/2;index++) { char c=unchecked((char)Marshal.ReadInt16(text,index*2));if(c=='\0'){terminated=true;break;}value.Append(c); }
        Require(terminated);actual=Normalize(value.ToString());
      } finally { GlobalUnlock(memory); }
      uint after=GetClipboardSequenceNumber();result["sequenceAfterRead"]=after;
      Require(after==sequence&&GetClipboardOwner()==owner&&Tick()==inputTick);
      GetWindowThreadProcessId(window,out windowPid);Require(windowPid==(uint)appPid&&!app.HasExited);
      result["textLength"]=actual.Length;result["textSha256"]=Hash(actual);
      Require(String.Equals(actual,expected,StringComparison.Ordinal));
      result["clipboardContentsVerified"]=true;result["newlineNormalization"]="CRLF-to-LF-only";
      result["status"]="passed-owned-clipboard-text-equals-preview";
    } catch(Exception error) { result["errorType"]=error.GetType().Name; }
    finally { if(opened){result["clipboardLockReleased"]=CloseClipboard();if(!(bool)result["clipboardLockReleased"]){result["status"]="unverified-clipboard-lock-release";result["clipboardContentsVerified"]=false;}} }
    return result;
  }
}
`;

async function readCopiedDiagnostic(app, fixture, info, before) {
  const observed = await app.call('memory');
  assert.ok(Array.isArray(observed.processes) && observed.processes.length > 0 && observed.processes.length <= 64, 'The exact owned process tree is unavailable.');
  assert.ok(Number.isSafeInteger(app.identity.pid) && app.identity.pid > 0 && Number.isSafeInteger(app.identity.windowHandle) && app.identity.windowHandle > 0, 'The exact native application identity is unavailable.');
  assert.ok(observed.processes.every(member => Number.isSafeInteger(member.pid) && member.pid > 0 && /^\d+$/.test(member.creationFileTime))
    && new Set(observed.processes.map(member => member.pid)).size === observed.processes.length, 'The owned process creation identities must be unique and complete.');
  const spec = { pid: app.identity.pid, creationFileTime: app.identity.creationFileTime, windowHandle: app.identity.windowHandle, executable: info.path,
    version: info.version, skillCount: fixture.skillCount, beforeSequence: before.sequence, lastInputTick: before.lastInputTick,
    processes: observed.processes.map(({ pid, creationFileTime }) => ({ pid, creationFileTime })) };
  const encoded = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64');
  const command = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Add-Type -AssemblyName UIAutomationClient;Add-Type -AssemblyName UIAutomationTypes;$refs=@((Get-ChildItem -LiteralPath (Join-Path $PSHOME 'ref') -Filter '*.dll').FullName)+@((Join-Path $PSHOME 'UIAutomationClient.dll'),(Join-Path $PSHOME 'UIAutomationTypes.dll'),(Join-Path $PSHOME 'WindowsBase.dll'));Add-Type -ReferencedAssemblies $refs -TypeDefinition @'\n${diagnosticClipboardReader}\n'@\n[DiagnosticClipboardRead]::Verify('${encoded}')|ConvertTo-Json -Compress`;
  const script = Buffer.from(command, 'utf16le').toString('base64');
  assert.ok(script.length < 28000, 'The bounded owned clipboard verifier request exceeds the native command-line limit.');
  const pending = execute('pwsh.exe', ['-STA', '-NoProfile', '-NonInteractive', '-EncodedCommand', script], {
    windowsHide: true, timeout: 20000, maxBuffer: 64 * 1024, env: { ...process.env, TEMP: join(fixture.root, 'driver-temp'), TMP: join(fixture.root, 'driver-temp') },
  });
  pending.child.stdin.end();
  const { stdout } = await pending;
  const result = JSON.parse(stdout.trim());
  assert.equal(result.originalClipboardRead, false, 'The diagnostic verifier must not read prior clipboard data.');
  return result;
}

async function diagnosticCopy(app, fixture, info) {
  await settingsGroup(app, '诊断');
  await invoke(app, '生成诊断预览');
  await wait(() => app.call('state', { name: '可复制的诊断摘要' }), rows => list(rows).some(row => row.type === 'ControlType.Edit' && !row.offscreen), 'generated diagnostic preview');
  const result = { previewGenerated: true, copyRequested: false, clipboardContentsRead: false, clipboardContentsVerified: false, originalClipboardBackedUp: false, clipboardCleared: false };
  if (options['clipboard-if-empty'] !== 'true') return { ...result, status: 'not-requested' };
  try {
    await wait(() => app.call('state', { name: '复制当前摘要' }), rows => list(rows).filter(row => row.type === 'ControlType.Button' && row.enabled).length === 1, 'enabled diagnostic copy button');
    result.before = await clipboardMetadata(join(fixture.root, 'driver-temp'));
    if (result.before.formatCount !== 0) return { ...result, status: 'unverified-clipboard-not-empty' };
    result.beforeInvoke = await clipboardMetadata(join(fixture.root, 'driver-temp'));
    if (!clipboardStillEmpty(result.before, result.beforeInvoke)) return { ...result, status: 'unverified-clipboard-changed-before-copy' };
    result.copyRequested = true;
    await app.call('invokeName', { name: '复制当前摘要' });
    await wait(() => app.call('state', { name: '已复制当前预览，未上传。' }), rows => list(rows).some(row => !row.offscreen), 'real clipboard success feedback');
    result.clipboardTextVerificationAttempted = true;
    result.clipboardContentsRead = null;
    Object.assign(result, await readCopiedDiagnostic(app, fixture, info, result.beforeInvoke));
    result.sharedClipboardLeftAsObserved = true;
    return result;
  } catch (error) { return { ...result, status: 'unverified-copy-or-metadata-unavailable', ...clipboardFailure(error) }; }
}

async function run() {
  assert.equal(typeof options.prepared, 'string', 'A fresh prepared appearance descriptor is required.');
  const descriptorPath = resolve(options.prepared);
  assert.ok(inside(descriptorPath, dataParent) && basename(descriptorPath) === 'appearance-copy-dataset.json', 'The appearance descriptor must use its exact name under the approved manager-data directory.');
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
  assert.equal(descriptor.format, format, 'The appearance descriptor format does not match.');
  assert.equal(descriptor.syntheticOnly, true, 'The appearance descriptor must identify generated data.');
  assert.ok(same(dirname(descriptorPath), dirname(descriptor.settingsFixture)), 'The appearance and settings descriptors must belong to the same fixture.');
  const fixture = await readFixture(descriptor.settingsFixture), info = await candidate();
  const transportSha256 = requestedTransportSha256 || info.sha256;
  const copyOnly = options['copy-only'] === 'true';
  const before = persisted(fixture), reportPath = join(fixture.root, copyOnly ? 'diagnostic-copy-result.json' : 'appearance-copy-result.json');
  const report = { format, mode: copyOnly ? 'copy-only' : 'appearance-save-reopen-and-copy', status: 'running', syntheticOnly: true, startedAt: new Date().toISOString(), candidate: info, transportFileSha256: transportSha256, fixture: descriptorPath, ...(copyOnly ? {} : { targetAppearance }), actions: [], limitations: [copyOnly ? 'Native diagnostic preview and optional copy only. Appearance save/reopen is not repeated.' : 'Actual UI save and same-database native reopen only. No system DPI, monitor configuration, visual contrast percentile or performance claim.', 'Optional copying requires an initially empty unchanged clipboard. Only the generated preview and the verified owned process family clipboard text are read; text is not logged. New clipboard contents remain in place.', 'A nonempty, unavailable or changing clipboard, unknown owner or unavailable preview leaves copying unverified without reading or replacing previous contents.'] };
  let app;
  try {
    report.harness = await Promise.all(['verify-native-appearance-copy.mjs', 'native-uia-client.mjs', 'verify-native-uia.ps1'].map(async name => ({ name, sha256: await digest(fileURLToPath(new URL(name, import.meta.url))) })));
    await writeFile(reportPath, json(report), { flag: 'wx' });
    report.currentStep = 'launch-initial-native-window';
    app = await NativeUiaSession.launch({ executable: info.path, dataDir: fixture.dataDir, reportPath: join(fixture.root, copyOnly ? 'diagnostic-copy-native-driver.json' : 'appearance-save-native-driver.json'), sha256: info.sha256, transportSha256, accessibilityInput: true });
    report.initialNative = app.identity;
    if (!copyOnly) {
      report.currentStep = 'open-appearance-settings';
      report.initialSettingsNavigation = await settingsGroup(app, '外观');
      report.currentStep = 'discover-eye-theme-button';
      const themeNames = await wait(() => app.call('names'), rows => list(rows).some(row => row.type === 'ControlType.Button' && row.name.startsWith('护眼')), 'the eye-theme button');
      const themes = list(themeNames).filter(row => row.type === 'ControlType.Button' && row.name.startsWith('护眼'));
      assert.equal(themes.length, 1, 'The actual eye-theme button must be unique.');
      report.themeButtonName = themes[0].name;
      report.currentStep = 'preview-eye-theme-and-teal-accent';
      await invoke(app, themes[0].name);
      await invoke(app, '青绿');
      report.selections = [];
      for (const [name, option] of [['界面密度', '紧凑（默认）'], ['动效', '关闭动效'], ['基础字号', '20 px']]) {
        report.currentStep = `preview-${name}`;
        report.selections.push(await select(app, name, option));
      }
      for (const key of Object.keys(targetAppearance)) assert.equal(persisted(fixture).settings[key], before.settings[key], `Preview unexpectedly saved ${key}.`);
      const oldTaskIds = new Set((await app.call('tasks')).tasks.map(item => item.id));
      report.currentStep = 'save-display-settings-through-native-button';
      await invoke(app, '保存显示设置');
      const tasks = await wait(() => app.call('tasks'), value => value.tasks.some(item => !oldTaskIds.has(item.id) && item.action === 'set_settings'), 'one actual display-save task');
      const saves = tasks.tasks.filter(item => !oldTaskIds.has(item.id) && item.action === 'set_settings');
      assert.equal(saves.length, 1, 'One native display-save click must create exactly one set_settings task.');
      const task = (await wait(() => app.call('task', { taskId: saves[0].id }), value => value.task && !['queued', 'running'].includes(value.task.status), 'display-save completion')).task;
      assert.equal(task.status, 'succeeded', task.error || 'Actual display save failed.');
      report.actions.push({ taskId: task.id, action: task.action, status: task.status });
      for (const [key, value] of Object.entries(targetAppearance)) assert.equal(persisted(fixture).settings[key], value, `The saved database differs for ${key}.`);
      report.previewWasNotPersisted = true;
      report.savedAppearance = targetAppearance;
      report.currentStep = 'normal-exit-after-display-save';
      report.firstNormalExit = (await app.quit()).driverReport.closedNormally;
      app = null;
      report.currentStep = 'reopen-same-native-database';
      app = await NativeUiaSession.launch({ executable: info.path, dataDir: fixture.dataDir, reportPath: join(fixture.root, 'appearance-reopen-native-driver.json'), sha256: info.sha256, transportSha256, accessibilityInput: true });
      report.reopenedNative = app.identity;
      report.currentStep = 'open-reopened-appearance-settings';
      report.reopenedSettingsNavigation = await settingsGroup(app, '外观');
      for (const [key, value] of Object.entries(targetAppearance)) assert.equal(persisted(fixture).settings[key], value, `The reopened database differs for ${key}.`);
      report.reopenedSelections = [];
      for (const [name, option] of [['界面密度', '紧凑（默认）'], ['动效', '关闭动效'], ['基础字号', '20 px']]) {
        report.currentStep = `verify-reopened-${name}`;
        const state = await app.call('comboState', { name });
        assert.ok(state.value === option || state.selected.includes(option), `Native reopened appearance differs for ${name}.`);
        report.reopenedSelections.push({ name, option, state });
      }
      const saveButtons = list(await app.call('state', { name: '保存显示设置' })).filter(row => row.type === 'ControlType.Button');
      assert.equal(saveButtons.length, 1, 'The reopened appearance group must expose exactly one save button.');
      assert.equal(saveButtons[0].enabled, false, 'Reopening created an unsaved appearance draft.');
    }
    report.currentStep = 'optional-diagnostic-clipboard-feedback';
    report.copy = await diagnosticCopy(app, fixture, info);
    report.currentStep = 'normal-exit-after-diagnostic-preview';
    report.secondNormalExit = (await app.quit()).driverReport.closedNormally;
    app = null;
    const after = persisted(fixture);
    report.currentStep = 'verify-generated-data-and-harness-preservation';
    for (const original of before.skills) {
      const retained = after.skills.find(skill => skill.id === original.id);
      assert.ok(retained, `An original synthetic Skill is missing: ${original.id}.`);
      for (const [key, value] of Object.entries(original)) assert.deepEqual(retained[key], value, `An existing Skill field changed: ${key}.`);
    }
    assert.equal(after.skills.length, before.skills.length, 'Appearance operations changed the number of registered Skills.');
    for (const key of ['sources', 'connections', 'localRoots', 'ignoredLocalPaths', 'checkMode']) assert.deepEqual(after[key], before[key], `An unrelated management field changed: ${key}.`);
    for (const [key, value] of Object.entries(before.settings)) if (copyOnly || !(key in targetAppearance)) assert.deepEqual(after.settings[key], value, `An unrelated setting changed: ${key}.`);
    await verifyFiles(fixture);
    for (const file of report.harness) assert.equal(await digest(fileURLToPath(new URL(file.name, import.meta.url))), file.sha256, 'A native helper changed during this run.');
    assert.equal(await digest(info.path), info.sha256, 'The candidate executable changed during the appearance run.');
    assert.equal(await digest(info.buildInfoPath), info.buildInfoSha256, 'The candidate build information changed during the appearance run.');
    report.generatedFilesAndUnrelatedManagementDataUnchanged = true;
    const copied = report.copy.status === 'passed-owned-clipboard-text-equals-preview';
    if (copyOnly) report.status = copied ? 'passed-native-diagnostic-copy-text' : 'native-diagnostic-copy-unverified';
    else report.status = copied ? 'passed-native-appearance-save-reopen-and-copy-text' : 'passed-native-appearance-save-reopen-copy-unverified';
  } catch (error) {
    report.status = 'failed-or-blocked'; report.error = String(error); report.errorStack = error.stack; process.exitCode = 1;
    if (app && !app.exited && !app.operationError) {
      try { report.failureButtonNames = list(await app.call('names')).filter(row => row.type === 'ControlType.Button').map(row => row.name).slice(0, 120); }
      catch (observationError) { report.failureObservationError = String(observationError); }
    }
  }
  finally {
    if (app) { try { report.finalNormalExit = (await app.quit()).driverReport.closedNormally; } catch (error) { report.finalNormalExit = false; report.closeError = String(error); } }
    report.finishedAt = new Date().toISOString();
    await writeFile(reportPath, json(report));
  }
  console.log(JSON.stringify({ status: report.status, report: reportPath, firstNormalExit: report.firstNormalExit, secondNormalExit: report.secondNormalExit, copy: report.copy?.status }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) {
    console.log('Prepare a fresh fixture with --phase prepare. Run with --phase run --prepared <appearance-copy-dataset.json> --candidate <release.exe> --candidate-build-info <json>. Add --copy-only true to skip appearance save/reopen. Optional --clipboard-if-empty true copies only when the shared clipboard is empty and unchanged across two metadata/input checks. A bounded STA reader compares only owned new diagnostic text with its actual native preview, without logging text or touching previous contents. No clear/restore, system DPI or monitor change is requested.');
    console.log('Optional --transport-file-sha256 <64hex> verifies the formal stdio executable independently of the selected native candidate. Omit it to retain the candidate-digest default. Both initial and reopened native sessions keep the same strict ownership preflight.');
  } else {
    assert.ok(['prepare', 'run'].includes(options.phase), 'Use --phase prepare or --phase run.');
    assert.ok(options['clipboard-if-empty'] === undefined || options['clipboard-if-empty'] === 'true', 'Clipboard copying requires the explicit value true.');
    assert.ok(!Object.hasOwn(options, 'copy-only') || options['copy-only'] === 'true', 'Copy-only mode requires the explicit value true.');
    if (options.phase === 'prepare') await prepare();
    else await run();
  }
}
