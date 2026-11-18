import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { NativeUiaSession } from './native-uia-client.mjs';
import { createPerformanceFixture } from './performance-fixture.mjs';

assert.equal(process.platform, 'win32');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Use the isolated hosted runner for physical Tab and pointer input.');
const { values: options } = parseArgs({ options: {
  candidate: { type: 'string' }, 'candidate-build-info': { type: 'string' },
} });
assert.ok(options.candidate && options['candidate-build-info'], 'Pass the candidate executable and its exact release build information.');
const executable = resolve(options.candidate), infoPath = resolve(options['candidate-build-info']);
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const info = JSON.parse(await readFile(infoPath, 'utf8'));
assert.equal(basename(executable), 'agent-resource-manager.exe');
assert.equal(info.buildMode, 'release');
assert.equal(await digest(executable), info.executableSha256);
const source = info.sourceIdentity || info.sourceCommit;
assert.ok(source, 'The candidate release requires its bound source identity.');

const parent = 'D:\\03_github_projects\\Agent_Management\\Agent_Resource_Manager\\validation\\manager-data';
await mkdir(parent, { recursive: true });
assert.equal((await realpath(parent)).toLowerCase(), parent.toLowerCase(), 'The validation parent must not be redirected.');
const root = await mkdtemp(join(parent, 'hosted-search-focus-'));
const reportPath = join(root, 'search-focus-result.json');
const harness = await Promise.all(['verify-hosted-search-focus.mjs', 'native-uia-client.mjs', 'verify-native-uia.ps1', 'performance-fixture.mjs']
  .map(async name => ({ name, sha256: await digest(new URL(name, import.meta.url)) })));
const report = {
  status: 'running', syntheticOnly: true, startedAt: new Date().toISOString(), harness,
  candidate: { executable, sha256: info.executableSha256, source, buildInfoSha256: await digest(infoPath) },
  visualReviewRequired: true, cases: [],
};
async function save() { await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); }
await save();

let app;
try {
  const fixture = await createPerformanceFixture(root, 'focus', 100);
  report.display = { theme: fixture.settings.uiTheme, zoom: fixture.settings.uiZoom, fontSize: fixture.settings.uiFontSize, density: fixture.settings.uiDensity };
  app = await NativeUiaSession.launch({ executable, sha256: info.executableSha256, dataDir: fixture.dataDir,
    reportPath: join(root, 'native-driver.json'), accessibilityInput: true, keyboardInput: true });
  report.native = app.identity;
  assert.equal(app.identity.functionalKeyboardInputRequested, true);
  await app.call('resize', { width: 1280, height: 850 });
  report.foreground = await app.call('prepareKeyboardForeground');
  assert.equal(report.foreground.inputTickBefore, report.foreground.inputTickAfter);
  assert.equal(report.foreground.sentKeyboardOrMouseInput, false);
  const cases = [
    { id: 'unified', navigation: '全部资源', name: '搜索全部资源', next: '全部', nextType: 'ControlType.Button' },
    { id: 'tools', navigation: '工具', name: '搜索工具', next: '工具类型', nextType: 'ControlType.ComboBox' },
  ];
  for (const item of cases) {
    const result = { ...item, focus: [] };
    report.cases.push(result);
    await app.call('invokeName', { name: item.navigation, scope: '主要导航' });
    for (const phase of ['pointer', 'tab', 'shift-tab']) {
      const observed = await app.call('keyboardSearchFocus', { name: item.name, phase });
      assert.equal(observed.keyboardFocusOwned, true);
      assert.equal(observed.phase, phase);
      assert.equal(observed.search, item.name);
      assert.equal(observed.pid, app.identity.pid);
      assert.equal(observed.windowHandle, app.identity.windowHandle);
      assert.equal(observed.focusedName, phase === 'tab' ? item.next : item.name);
      assert.equal(observed.focusedType, phase === 'tab' ? item.nextType : 'ControlType.Edit');
      const path = join(root, item.id + '-' + phase + '.png');
      const capture = await app.call('screenshot', { path });
      assert.equal(capture.nativeWindowOnly, true);
      result.focus.push({ ...observed, screenshot: basename(path), sha256: await digest(path) });
      await save();
    }
  }
  report.status = 'captured-native-focus-evidence';
} catch (error) {
  report.status = 'failed';
  report.error = String(error);
} finally {
  if (app) {
    try { report.closedNormally = (await app.quit()).driverReport.closedNormally; }
    catch (error) { report.status = 'failed'; report.normalExitError = String(error); }
  }
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ status: report.status, report: reportPath, visualReviewRequired: report.visualReviewRequired }));
  if (report.status === 'failed') process.exitCode = 1;
}
