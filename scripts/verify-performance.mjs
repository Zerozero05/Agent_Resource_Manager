import { spawn, execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, appendFile, readFile, access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { cpus, hostname, release } from 'node:os';
import { createServer } from 'node:net';
import { get as httpGet } from 'node:http';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createPerformanceFixture } from './performance-fixture.mjs';
import { PERFORMANCE_POLICY as policy, startupComparison, localInteractionVerdict, freezeConvergenceBounds, stabilityVerdict } from './performance-policy.mjs';

const help = `Native Windows performance acceptance (no downloads, real user data, or cleanup).
  node scripts/verify-performance.mjs --candidate <release.exe> --candidate-source <commit/dirty-manifest>
    [--baseline <release.exe> --baseline-source <commit>] [--output <D:\\...>]
    [--candidate-build-info <json> --baseline-build-info <json>]
    [--suite all|startup|interactive|stability|prepare]
prepare creates only isolated 1000-Skills + 100-tools fixtures and the fixed policy.
all requires ten app-cold and ten app-warm starts per binary, local UI input samples,
five warmup cycles, five-minute idle calibration and a full thirty-minute stability run.
Cold means a new application/WebView profile; OS filesystem caches are not purged.
Both binaries are always fully shut down between startup samples. No resident backend
may serve the measurement. A different live manager causes a blocked run, never a kill.
The script retains its generated evidence and fixtures. No result is a release approval.`;

const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, index, all) => arg.startsWith('--') ? [...pairs, [arg.slice(2), all[index + 1] && !all[index + 1].startsWith('--') ? all[index + 1] : true]] : pairs, []));
if (options.help) { console.log(help); process.exit(0); }
const suite = options.suite || 'all';
if (!['all', 'startup', 'interactive', 'stability', 'prepare'].includes(suite)) throw new Error(help);
if (process.platform !== 'win32' && suite !== 'prepare') throw new Error('Native Windows acceptance must run on Windows.');
const baseOutput = resolve(typeof options.output === 'string' ? options.output : 'D:\\03_github_projects\\Agent_Management\\Agent_Resource_Manager\\validation\\manager-data');
if (process.platform === 'win32' && !/^D:\\/i.test(baseOutput)) throw new Error('Choose an absolute D-drive output directory.');
await mkdir(baseOutput, { recursive: true });
const output = await mkdtemp(join(baseOutput, 'native-performance-'));
const logPath = join(output, 'observations.jsonl');
const emit = async (kind, value) => { await appendFile(logPath, JSON.stringify({ observedAt: new Date().toISOString(), kind, ...value }) + '\n'); };
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, Math.max(0, ms)));
const report = { formatVersion: 1, status: 'incomplete', suite, output, policy, machine: { hostname: hostname(), platform: process.platform, release: release(), logicalProcessors: cpus().length, cpuModel: cpus()[0]?.model, node: process.version }, measurement: { mode: 'native-release-WebView2-CDP', start: 'driver monotonic clock before spawning the complete native application', ready: 'main local controls enabled, expected rendered data, then two animation frames', interaction: 'driver emission of trusted browser input through interactive painted result; includes queue, IPC and rendering', cold: 'fresh application database and WebView profile; OS caches left untouched', warm: 'same profile and equivalent dataset, with application and backend completely stopped', processMemory: 'sum of manager and descendant WebView PrivateMemorySize64; summed working sets separately, not physical memory released', noRealResources: true }, startup: { baseline: { cold: [], warm: [] }, candidate: { cold: [], warm: [] } }, interactions: [], stability: null, limitations: ['The default background workload covers real local checks. Download and update overlap require their own native acceptance evidence.', 'Application-cold samples do not claim machine-reboot or purged-system-cache measurements.'], nativeErrors: [] };
const harnessFiles = ['verify-performance.mjs', 'performance-policy.mjs', 'performance-fixture.mjs', 'performance-load-fixture.mjs'];
report.harness = await Promise.all(harnessFiles.map(async name => ({ path: fileURLToPath(new URL(name, import.meta.url)), sha256: await executableDigest(new URL(name, import.meta.url)) })));
await writeFile(join(output, 'policy-before-run.json'), JSON.stringify({ policy, measurement: report.measurement, startedAt: new Date().toISOString() }, null, 2));

async function executableInfo(path, source, buildInfoPath) {
  if (typeof path !== 'string' || typeof source !== 'string' || !source.trim()) throw new Error('Pass the exact release executable and its source identity.');
  path = resolve(path); await access(path);
  if (!/^(agent-resource-manager|skill-manager)\.exe$/i.test(basename(path))) throw new Error('Pass the application executable, never an installer or unrelated program.');
  const header = await readFile(path); // Native candidate size is bounded by the existing release package.
  const offset = header.readUInt32LE(0x3c);
  if (header.readUInt16LE(0) !== 0x5a4d || header.readUInt32LE(offset) !== 0x00004550 || header.readUInt16LE(offset + 4) !== 0x8664) throw new Error('Pass a Windows x64 release executable.');
  const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk);
  const version = await powershell(`(Get-Item -LiteralPath '${path.replaceAll("'", "''")}').VersionInfo | Select-Object ProductVersion,FileVersion | ConvertTo-Json -Compress`);
  const sha256 = hash.digest('hex');
  const buildInfo = typeof buildInfoPath === 'string' ? JSON.parse(await readFile(resolve(buildInfoPath), 'utf8')) : null;
  const releaseProvenanceVerified = !!buildInfo && buildInfo.buildMode === 'release' && (buildInfo.executableSha256 || buildInfo.sha256)?.toLowerCase() === sha256 && (buildInfo.sourceIdentity || buildInfo.sourceCommit) === source;
  return { path, sha256, source, buildMode: buildInfo?.buildMode || 'unverified', releaseProvenanceVerified, buildInfoPath: buildInfoPath ? resolve(buildInfoPath) : null, version };
}

async function executableDigest(path) { const hash = createHash('sha256'); for await (const bytes of createReadStream(path)) hash.update(bytes); return hash.digest('hex'); }

async function powershell(script) {
  return new Promise((done, fail) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop'; ${script}`, 'utf16le').toString('base64')], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) fail(new Error(`Native measurement failed: ${stderr || error.message}`));
      else { try { done(JSON.parse(stdout.trim() || 'null')); } catch { fail(new Error('Native measurement returned invalid JSON.')); } }
    });
  });
}

async function freePort() {
  const server = createServer(); await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port; await new Promise(done => server.close(done)); return port;
}

function localTargets(port) {
  // A direct loopback socket avoids inheriting any HTTP_PROXY/NODE_OPTIONS
  // behavior intended for external research traffic.
  return new Promise((done, fail) => {
    const request = httpGet({ host: '127.0.0.1', port, path: '/json/list', agent: false, timeout: 500 }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', value => { text += value; if (text.length > 1024 * 1024) request.destroy(new Error('Unexpectedly large local target list.')); });
      response.once('end', () => { try { if (response.statusCode !== 200) throw new Error(`Local CDP status ${response.statusCode}`); done(JSON.parse(text)); } catch (error) { fail(error); } });
    });
    request.once('timeout', () => request.destroy(new Error('Local CDP connection timed out.'))); request.once('error', fail);
  });
}

class DevTools {
  constructor(socket) {
    this.socket = socket; this.nextId = 1; this.waiters = new Map(); this.errors = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) { const waiter = this.waiters.get(message.id); if (waiter) { clearTimeout(waiter.timer); this.waiters.delete(message.id); message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result); } }
      else if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params.exceptionDetails.text || 'Unhandled exception');
      else if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'warn'].includes(message.params.type)) this.errors.push(`${message.params.type}: ${message.params.args.map(value => value.value ?? value.description ?? value.type).join(' ')}`);
      else if (message.method === 'Log.entryAdded' && ['error', 'warning'].includes(message.params.entry.level)) this.errors.push(`${message.params.entry.level}: ${message.params.entry.text}`);
    });
    socket.addEventListener('close', () => { for (const waiter of this.waiters.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Native WebView connection closed.')); } this.waiters.clear(); });
  }
  static async connect(url) { const socket = new WebSocket(url); await new Promise((done, fail) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', fail, { once: true }); }); return new DevTools(socket); }
  call(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolveCall, reject) => { const timer = setTimeout(() => { this.waiters.delete(id); reject(new Error(`${method} timed out.`)); }, timeoutMs); this.waiters.set(id, { resolve: resolveCall, reject, timer }); this.socket.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression) { const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Browser evaluation failed.'); return result.result?.value; }
  invoke(request) { return this.evaluate(`window.__TAURI_INTERNALS__.invoke('manager_request',{request:${JSON.stringify(request)}})`); }
  async painted(predicate, timeoutMs = 15000) {
    return this.evaluate(`new Promise((resolve,reject)=>{const end=performance.now()+${timeoutMs};let frames=0;const tick=()=>{if((${predicate})){if(++frames>=2)return resolve({paintedAt:performance.now(),timeOrigin:performance.timeOrigin});}else frames=0;if(performance.now()>end)return reject(new Error('Expected native UI result did not become interactive.'));requestAnimationFrame(tick);};requestAnimationFrame(tick);})`);
  }
  async click(selector) {
    const rect = await this.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||!e.getClientRects().length)throw new Error('Native control not available: '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await this.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect });
    await this.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect });
  }
}

const visible = `e=>!!e&&e.getClientRects().length>0&&!e.closest('[hidden]')`;
const tableRows = `[...document.querySelectorAll('.skill-table-row')].filter(${visible})`;
const inputSelector = 'input[aria-label="搜索 Skill"]';
const homeSelector = '[data-home="true"] .workspace-tab-select';
const activeTab = `.workspace-tab-select[aria-selected="true"]`;

async function launch(info, dataset, label) {
  if (await executableDigest(info.path) !== info.sha256) throw new Error('The executable changed during acceptance. Rebuild evidence and restart the same-candidate measurement.');
  const existing = await powershell(`ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Where-Object {$_.Name -in @('skill-manager.exe','agent-resource-manager.exe')} | Select-Object ProcessId,Name)`);
  if (existing.length) throw new Error('An existing manager process is running. The performance run is blocked; no existing process was closed or reused.');
  const port = await freePort(), started = performance.now(), child = spawn(info.path, ['--data-dir', dataset.dataDir], { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: join(dataset.root, 'webview-profile'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` } });
  const app = { info, dataset, label, port, child, started, cdp: null, stderr: '', stdout: '', ownedPid: child.pid, exited: false, exitCode: null };
  child.stdout.on('data', bytes => { app.stdout = (app.stdout + bytes).slice(-1024 * 1024); });
  child.stderr.on('data', bytes => { app.stderr = (app.stderr + bytes).slice(-1024 * 1024); });
  child.once('close', code => { app.exited = true; app.exitCode = code; });
  child.once('error', error => { app.spawnError = error.message; });
  await emit('native-launch', { label, pid: child.pid, port, executableSha256: info.sha256, dataset: dataset.root, nativeWindowRequestedVisible: true, harness: report.harness });
  try {
    let targetSignature = null, answered = false;
    while (performance.now() - started < 30000) {
      if (app.exited || app.spawnError) throw new Error(`Native process exited before an isolated UI was ready: ${app.spawnError || app.stderr || app.exitCode}`);
      try {
        const targets = await localTargets(port); answered = true;
        const summary = targets.map(value => ({ id: value.id, type: value.type, url: String(value.url || '').split(/[?#]/)[0] })), signature = JSON.stringify(summary);
        if (signature !== targetSignature) { await emit('native-cdp-targets', { label, port, targets: summary }); targetSignature = signature; }
        const target = targets.find(value => value.type === 'page' && value.webSocketDebuggerUrl && /tauri\.localhost|tauri:\/\//.test(value.url));
        if (target) { app.cdp = await DevTools.connect(target.webSocketDebuggerUrl); break; }
      } catch { /* The native WebView has not opened its local debugging socket yet. */ }
      await sleep(25);
    }
    if (!app.cdp) throw new Error(answered ? 'The isolated CDP endpoint answered, but no native application page matched. Inspect native-cdp-targets observations.' : `No isolated native WebView CDP endpoint answered on loopback port ${port}. Inspect the owned process/window and WebView2 command line before retrying.`);
    await app.cdp.call('Runtime.enable'); await app.cdp.call('Log.enable');
    await app.cdp.painted(`!!window.__TAURI_INTERNALS__&&!!document.querySelector(${JSON.stringify(inputSelector)})&&!document.querySelector(${JSON.stringify(inputSelector)}).disabled&&!!document.querySelector('.source-filters button:not([disabled])')&&!!document.querySelector('.workspace-tab-select:not([disabled])')&&${tableRows}.length===20&&!!document.querySelector('.library-summary')&&document.querySelector('.library-summary').textContent.includes('1000')`);
    app.startupMs = performance.now() - started;
    const state = await app.cdp.invoke({ action: 'get_state' });
    if (resolve(state.dataDir).toLowerCase() !== resolve(dataset.dataDir).toLowerCase() || state.skills?.length !== 1000) throw new Error('The native application did not open the exact synthetic database.');
    await emit('native-startup', { label, executableSha256: info.sha256, dataset: dataset.root, startupMs: app.startupMs, pid: child.pid, port, completeBackendStartup: true, visibility: await app.cdp.evaluate(`({state:document.visibilityState,focused:document.hasFocus()})`), webView: await app.cdp.call('Browser.getVersion') });
    return app;
  } catch (error) { await stop(app, true); throw error; }
}

async function stop(app, startupFailed = false) {
  if (!app) return;
  if (app.cdp && !app.exited) {
    try {
      const intent = await app.cdp.invoke({ action: 'workspace_close_intent', all: true, mode: 'quit' });
      if (!intent.final || !intent.closeId) throw new Error('No final native close intent.');
      await app.cdp.invoke({ action: 'workspace_finish_close', closeId: intent.closeId });
    } catch (error) { if (!app.exited) await emit('native-close-observation', { label: app.label, error: String(error) }); }
  }
  const deadline = performance.now() + 15000;
  while (!app.exited && performance.now() < deadline) await sleep(50);
  if (!app.exited) {
    // Only the PID returned by this spawn is eligible. A different user's or
    // pre-existing manager is never found by process name and never terminated.
    if (!startupFailed) throw new Error('The owned test application did not exit gracefully. It was left running; no startup or performance sample can pass.');
    app.child.kill(); await emit('owned-test-process-stop', { label: app.label, pid: app.ownedPid, forced: true, startupFailed });
  }
  app.cdp?.socket.close();
  if (app.stderr || app.cdp?.errors.length) { report.nativeErrors.push({ label: app.label, stderr: app.stderr, errors: app.cdp?.errors || [] }); await emit('native-errors', report.nativeErrors.at(-1)); }
}

async function goHome(app) { await app.cdp.click(homeSelector); await app.cdp.painted(`document.querySelector('${homeSelector}').getAttribute('aria-selected')==='true'`); }
async function navigation(app, label, resultSelector) {
  await goHome(app);
  const selector = await app.cdp.evaluate(`(()=>{const e=[...document.querySelectorAll('.sidebar .nav-item')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}||e.querySelector('span')?.textContent===${JSON.stringify(label)});if(!e)throw new Error('Navigation unavailable');e.dataset.perfNavigation='target';return '[data-perf-navigation="target"]';})()`);
  await app.cdp.click(selector); await app.cdp.painted(`!![...document.querySelectorAll(${JSON.stringify(resultSelector)})].find(${visible})`);
  await app.cdp.evaluate(`delete document.querySelector('[data-perf-navigation="target"]').dataset.perfNavigation`);
}

async function search(app, index, measured = true) {
  const key = String(index).padStart(4, '0'), query = `perf-skill-${key}`;
  await app.cdp.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(inputSelector)});e.focus();e.setSelectionRange(0,e.value.length);})()`);
  const startedAtUtcMs = Date.now(), started = performance.now(); await app.cdp.call('Input.insertText', { text: query });
  await app.cdp.painted(`document.querySelector(${JSON.stringify(inputSelector)}).value===${JSON.stringify(query)}&&${tableRows}.length===1&&${tableRows}[0].dataset.skillId===${JSON.stringify(query)}`);
  const sample = { category: 'search', condition: 'native-ui-input-to-painted-result', startedAtUtcMs, finishedAtUtcMs: Date.now(), durationMs: performance.now() - started, index, executableSha256: app.info.sha256 };
  if (measured) { report.interactions.push(sample); await emit('interaction', sample); }
}
async function clearSearch(app) {
  await app.cdp.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(inputSelector)});e.focus();e.setSelectionRange(0,e.value.length);})()`);
  await app.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await app.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await app.cdp.painted(`${tableRows}.length===20&&document.querySelector(${JSON.stringify(inputSelector)}).value===''`);
}
async function sourceFilter(app, github, measured = true) {
  const target = github ? 'GitHub' : '全部';
  const selector = await app.cdp.evaluate(`(()=>{const e=[...document.querySelectorAll('.source-filters button')].find(e=>e.textContent===${JSON.stringify(target)});if(!e)throw new Error('Source filter unavailable');e.dataset.perfFilter='target';return '[data-perf-filter="target"]';})()`);
  const startedAtUtcMs = Date.now(), started = performance.now(); await app.cdp.click(selector);
  await app.cdp.painted(`document.querySelector('${selector}').getAttribute('aria-pressed')==='true'&&${tableRows}.length===${github ? 0 : 20}`);
  const sample = { category: 'filter', condition: 'native-ui-input-to-painted-result', startedAtUtcMs, finishedAtUtcMs: Date.now(), durationMs: performance.now() - started, target, executableSha256: app.info.sha256 };
  await app.cdp.evaluate(`delete document.querySelector('${selector}').dataset.perfFilter`);
  if (measured) { report.interactions.push(sample); await emit('interaction', sample); }
}
async function openDetail(app, index, measured = false) {
  await navigation(app, 'Skills', '.skill-table'); await search(app, index, false);
  const startedAtUtcMs = Date.now(), started = performance.now();
  await app.cdp.click('.skill-table-row .skill-name-button');
  await app.cdp.painted(`document.querySelector('${activeTab}')?.textContent.includes(${JSON.stringify(`Perf Skill ${String(index).padStart(4, '0')}`)})&&!![...document.querySelectorAll('.session-document .markdown h1')].filter(${visible}).find(e=>e.textContent===${JSON.stringify(`Perf Skill ${String(index).padStart(4, '0')}`)})`);
  if (measured) { const sample = { category: 'document', condition: 'native-ui-input-to-painted-result', startedAtUtcMs, finishedAtUtcMs: Date.now(), durationMs: performance.now() - started, index, executableSha256: app.info.sha256 }; report.interactions.push(sample); await emit('interaction', sample); }
}
async function tabSample(app, home, measured = true) {
  const selector = home ? homeSelector : '.workspace-tab[data-home="false"] .workspace-tab-select';
  const startedAtUtcMs = Date.now(), started = performance.now(); await app.cdp.click(selector);
  await app.cdp.painted(`document.querySelector('${selector}')?.getAttribute('aria-selected')==='true'&&${home ? `!![...document.querySelectorAll(${JSON.stringify(inputSelector)})].find(${visible})` : `!![...document.querySelectorAll('.session-document .markdown h1')].find(${visible})`}`);
  const sample = { category: 'tab', condition: 'native-ui-input-to-painted-result', startedAtUtcMs, finishedAtUtcMs: Date.now(), durationMs: performance.now() - started, target: home ? 'home' : 'detail', executableSha256: app.info.sha256 };
  if (measured) { report.interactions.push(sample); await emit('interaction', sample); }
}
async function closeDetails(app) {
  for (;;) { const count = await app.cdp.evaluate(`document.querySelectorAll('.workspace-tab-close').length`); if (!count) break; await app.cdp.click('.workspace-tab-close'); await app.cdp.painted(`document.querySelectorAll('.workspace-tab-close').length<${count}`); }
}
async function cycle(app, index, mixed) {
  await navigation(app, 'Skills', '.skill-table'); await clearSearch(app); await search(app, index % 1000, false); await clearSearch(app);
  await sourceFilter(app, true, false); await sourceFilter(app, false, false);
  await openDetail(app, index % 1000); await tabSample(app, true, false); await tabSample(app, false, false); await closeDetails(app);
  await navigation(app, '设置', '.settings-shell');
  if (mixed) { await navigation(app, '工具', '.resource-panel'); await app.cdp.painted(`document.querySelector('.resource-count')?.textContent.includes('100')`); }
  await navigation(app, 'Skills', '.skill-table'); await clearSearch(app);
}

async function processSample(app) {
  const root = app.ownedPid;
  const values = await powershell(`$rows=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate); $ids=[Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${root}); do {$changed=$false; foreach($row in $rows) {if($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)){$changed=$true}}}while($changed); $result=@(foreach($row in $rows){if($ids.Contains([int]$row.ProcessId)){try{$p=Get-Process -Id $row.ProcessId -ErrorAction Stop; [pscustomobject]@{pid=$p.Id;parentPid=$row.ParentProcessId;name=$row.Name;createdAt=$row.CreationDate.ToUniversalTime().ToString('o');privateBytes=$p.PrivateMemorySize64;workingSetBytes=$p.WorkingSet64;cpuSeconds=$p.TotalProcessorTime.TotalSeconds}}catch{}}}); ConvertTo-Json -Compress -InputObject $result`);
  if (!values.some(row => row.pid === root) || !values.some(row => /msedgewebview2/i.test(row.name))) throw new Error('Cannot account for both the native manager and its WebView process tree.');
  return { rows: values, privateBytes: values.reduce((sum, row) => sum + row.privateBytes, 0), workingSetBytes: values.reduce((sum, row) => sum + row.workingSetBytes, 0) };
}
async function idleSample(app, elapsedMs) {
  const deadline = performance.now() + 15000; let busy;
  do { const tasks = await app.cdp.invoke({ action: 'list_tasks' }); busy = tasks.tasks.filter(task => ['running', 'queued'].includes(task.status)); if (busy.length) await sleep(100); } while (busy.length && performance.now() < deadline);
  if (busy.length) throw new Error('The native workload did not return to idle before its memory/CPU sample.');
  const before = await processSample(app), start = performance.now(); await sleep(1000); const after = await processSample(app);
  const seconds = (performance.now() - start) / 1000;
  const previous = new Map(before.rows.map(row => [`${row.pid}:${row.createdAt}`, row.cpuSeconds]));
  const cpu = after.rows.reduce((sum, row) => sum + Math.max(0, row.cpuSeconds - (previous.get(`${row.pid}:${row.createdAt}`) ?? row.cpuSeconds)), 0);
  const cache = await app.cdp.invoke({ action: 'get_content_cache_stats' });
  const heap = await app.cdp.call('Runtime.getHeapUsage');
  return { elapsedMs, ...after, idleCpuPercent: cpu / seconds / cpus().length * 100, pendingTasksBeforeSample: busy.length, cache, webViewHeap: heap, executableSha256: app.info.sha256 };
}
async function startCheck(app) {
  return app.cdp.invoke({ action: 'start_task', request: { action: 'check_now', skillIds: Array.from({ length: 1000 }, (_, index) => `perf-skill-${String(index).padStart(4, '0')}`) }, label: 'Synthetic native performance background check', origin: { view: 'skills' }, foreground: false });
}
async function recordBackground(app, started, category) {
  const task = started.task?.id ? (await app.cdp.invoke({ action: 'get_task', taskId: started.task.id })).task : null;
  const began = Date.parse(task?.startedAt || ''), finished = task?.finishedAt ? Date.parse(task.finishedAt) : Date.now();
  const overlapSamples = Number.isFinite(began) ? report.interactions.filter(sample => sample.category === category && sample.startedAtUtcMs < finished && sample.finishedAtUtcMs > began).length : 0;
  const observation = { category, taskId: task?.id || null, startedAt: task?.startedAt || null, finishedAt: task?.finishedAt || null, status: task?.status || 'unknown', overlappingInputSamples: overlapSamples };
  (report.backgroundCoverage ||= []).push(observation); await emit('background-check-coverage', observation);
  if (['failed', 'interrupted'].includes(task?.status)) report.nativeErrors.push({ label: `background-${category}`, error: task.error || task.status });
}
async function interactionRun(app) {
  let background = await startCheck(app); const firstTask = background.task?.id || null;
  for (let index = 0; index < policy.localSamplesPerCategory; index++) { await search(app, index); }
  await recordBackground(app, background, 'search');
  await clearSearch(app);
  background = await startCheck(app);
  for (let index = 0; index < policy.localSamplesPerCategory; index++) await sourceFilter(app, index % 2 === 0);
  await recordBackground(app, background, 'filter');
  await openDetail(app, 0);
  background = await startCheck(app);
  for (let index = 0; index < policy.localSamplesPerCategory; index++) await tabSample(app, index % 2 === 0);
  await recordBackground(app, background, 'tab');
  await closeDetails(app);
  background = await startCheck(app);
  for (let index = 0; index < policy.localSamplesPerCategory; index++) {
    await openDetail(app, index + 10, true); await closeDetails(app);
    // Observe this result before the deliberately bounded task history evicts it.
    if (index === 9) await recordBackground(app, background, 'document');
  }
  await navigation(app, 'Skills', '.skill-table'); await clearSearch(app);
  return firstTask;
}
async function stabilityRun(app) {
  for (let index = 0; index < policy.warmupCycles; index++) { await cycle(app, index, true); await emit('fixed-warmup-cycle', { index: index + 1 }); }
  const idle = [], calibrationStart = performance.now();
  for (let index = 0; index < policy.idleCalibrationSamples; index++) { await sleep(calibrationStart + index * policy.sampleIntervalMs - performance.now()); const sample = await idleSample(app, performance.now() - calibrationStart); idle.push(sample); await emit('idle-calibration', sample); }
  const bounds = freezeConvergenceBounds(idle); await writeFile(join(output, 'convergence-bounds-before-loop.json'), JSON.stringify(bounds, null, 2));
  const samples = []; let start = performance.now();
  for (let index = 0; index <= policy.stabilityDurationMs / policy.sampleIntervalMs; index++) {
    await sleep(start + index * policy.sampleIntervalMs - performance.now());
    const check = index % 2 === 0 ? await startCheck(app) : null;
    await cycle(app, index + policy.warmupCycles, true);
    const sample = await idleSample(app, 0); sample.elapsedMs = performance.now() - start;
    if (index === 0) { start = performance.now(); sample.elapsedMs = 0; }
    sample.cycle = index + 1; sample.backgroundCheckId = check?.task?.id || null;
    samples.push(sample); await emit('stability-sample', sample);
    console.log(JSON.stringify({ phase: 'stability', sample: index + 1, of: 61, elapsedSeconds: Math.round(sample.elapsedMs / 1000), privateMiB: +(sample.privateBytes / 1048576).toFixed(1), cacheBytes: sample.cache?.bytes }));
  }
  return { warmupCycles: policy.warmupCycles, idleCalibration: idle, bounds, samples, verdict: stabilityVerdict(samples, bounds, policy.warmupCycles) };
}

try {
  const mixed = await createPerformanceFixture(output, 'mixed-native-fixture', 100);
  report.dataset = mixed;
  if (suite === 'prepare') { report.status = 'prepared-not-measured'; }
  else {
    report.candidate = await executableInfo(options.candidate, options['candidate-source'], options['candidate-build-info']);
    report.baseline = options.baseline ? await executableInfo(options.baseline, options['baseline-source'], options['baseline-build-info']) : null;
    if (suite === 'startup' || suite === 'all') {
      for (const label of ['baseline', 'candidate']) {
        const info = report[label]; if (!info) continue;
        for (let index = 0; index < policy.startupSamples; index++) {
          const fixture = await createPerformanceFixture(output, `${label}-cold-${index}`, 0); let app;
          try { app = await launch(info, fixture, `${label}-cold-${index}`); report.startup[label].cold.push(app.startupMs); } finally { await stop(app); }
        }
        const fixture = await createPerformanceFixture(output, `${label}-warm`, 0); let warm;
        try { warm = await launch(info, fixture, `${label}-warm-conditioning`); } finally { await stop(warm); }
        for (let index = 0; index < policy.startupSamples; index++) {
          let app; try { app = await launch(info, fixture, `${label}-warm-${index}`); report.startup[label].warm.push(app.startupMs); } finally { await stop(app); }
        }
      }
      report.startup.verdict = { cold: startupComparison(report.startup.baseline.cold, report.startup.candidate.cold), warm: startupComparison(report.startup.baseline.warm, report.startup.candidate.warm) };
    }
    if (['all', 'interactive', 'stability'].includes(suite)) {
      let app;
      try {
        app = await launch(report.candidate, mixed, 'candidate-mixed-1000-100');
        if (['all', 'interactive'].includes(suite)) { report.backgroundCheckId = await interactionRun(app); report.interactionVerdict = localInteractionVerdict(report.interactions); }
        if (['all', 'stability'].includes(suite)) report.stability = await stabilityRun(app);
      } finally { await stop(app); }
    }
    const gates = [report.startup.verdict?.cold.status, report.startup.verdict?.warm.status, ...Object.values(report.interactionVerdict || {}).map(value => value.status), report.stability?.verdict.status];
    report.status = report.nativeErrors.length || gates.includes('failed') || gates.includes('invalid') ? 'failed' : suite === 'all' && report.candidate.releaseProvenanceVerified && report.baseline?.releaseProvenanceVerified && gates.length === 7 && gates.every(status => status === 'passed') ? 'measured-gates-passed-remaining-load-coverage' : 'incomplete';
  }
} catch (error) { report.status = 'blocked-or-failed'; report.error = String(error); process.exitCode = 1; }
finally {
  report.harnessChangedDuringRun = (await Promise.all(report.harness.map(async entry => await executableDigest(entry.path) !== entry.sha256))).some(Boolean);
  if (report.harnessChangedDuringRun) { report.status = 'failed'; report.error = 'The measurement harness changed during this run. Repeat with fixed harness bytes.'; }
  report.finishedAt = new Date().toISOString(); await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  if (['failed', 'blocked-or-failed'].includes(report.status)) process.exitCode = 1;
  else if (suite === 'all' && report.status !== 'passed') process.exitCode = 2;
  console.log(JSON.stringify({ status: report.status, report: join(output, 'report.json'), error: report.error || null }));
}
