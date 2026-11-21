import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { NativeUiaSession } from './native-uia-client.mjs';
import { createPerformanceFixture } from './performance-fixture.mjs';
import { referenceObservationRows, validBox, VisualSession } from './verify-native-visual-stability.mjs';

const source = '5480977711719efadcb79c322931b7d2066a6f84';
const candidateRun = '44907287993';
const branch = 'codex/hosted-narrow-detail-5480977-20261121';
const repository = 'zerozero05/agent_resource_manager';
const approved = 'D:/03_github_projects/Agent_Management/Agent_Resource_Manager/validation/manager-data';
const frame = { left: 60, top: 60, width: 960, height: 650, dpi: 96 };
const skillId = 'perf-skill-0000';
const skillTitle = 'Perf Skill 0000';
const tab = 'ControlType.TabItem';
const button = 'ControlType.Button';
const protectedTables = ['app_state', 'resource_catalog', 'resource_catalog_meta', 'skill_annotations',
  'management_data_meta', 'resource_relations', 'resource_relations_meta', 'task_history'];
const sleep = ms => new Promise(done => setTimeout(done, ms));
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = async path => hash(await readFile(path));
const samePath = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase();

export function inFrame(bounds) {
  if (typeof bounds !== 'string') return null;
  const coords = bounds.split(',').map(Number);
  if (coords.length !== 4 || !coords.every(Number.isFinite)) return null;
  const [left, top, width, height] = coords;
  const x = Math.floor(left) - frame.left, y = Math.floor(top) - frame.top;
  const box = [x, y, Math.ceil(left + width) - frame.left - x, Math.ceil(top + height) - frame.top - y];
  return validBox(box, frame) ? box : null;
}

function point(bounds) {
  const box = inFrame(bounds);
  assert.ok(box, 'Pointer target is outside the exact compact frame.');
  const [x, y, width, height] = box;
  return { x: x + Math.floor(width / 2), y: y + Math.floor(height / 2) };
}

export function workspaceState(row) {
  if (!row) return { revision: -1, active: 'home', id: null, section: null };
  const { revision, windows } = JSON.parse(row.payload);
  assert.ok(Number.isSafeInteger(revision) && revision >= 0);
  assert.equal(windows.length, 1);
  const { label, panes, activePaneId, splitView } = windows[0];
  assert.equal(label, 'main');
  assert.equal(splitView, undefined);
  assert.ok(panes.length >= 1 && panes.length <= 2);
  assert.equal(panes.filter(pane => pane.kind === 'home' && pane.id === 'home').length, 1);
  const detail = panes.find(pane => pane.kind === 'detail');
  if (panes.length === 2) {
    assert.equal(detail?.skillId, skillId);
    assert.equal(detail.title, skillTitle);
  }
  assert.ok(activePaneId === 'home' || activePaneId === detail?.id);
  return { revision, active: activePaneId === 'home' ? 'home' : 'document',
    id: detail?.id ?? null, section: detail?.state.section ?? null };
}

function protectedState(db) {
  return Object.fromEntries(protectedTables.map(table => {
    const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table);
    const rows = exists ? db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() : [];
    return [table, hash(JSON.stringify(rows))];
  }));
}

export function checkBinding({ artifactId, sha256, archiveSha256 }) {
  assert.match(artifactId, /^\d+$/, 'The candidate artifact ID must be bound before this test.');
  assert.match(sha256, /^[a-f0-9]{64}$/, 'The exact candidate EXE SHA-256 must be bound before this test.');
  assert.match(archiveSha256, /^[a-f0-9]{64}$/, 'The exact candidate archive SHA-256 must be bound before this test.');
}

async function exercise(dataset, executable, sha256, report) {
  const temporary = join(dataset.root, 'visual-temp');
  await mkdir(temporary);
  const env = { ...process.env, TEMP: temporary, TMP: temporary };
  const db = new DatabaseSync(dataset.dbPath, { readOnly: true });
  const workspaceQuery = db.prepare('SELECT payload FROM workspace_state WHERE id=1');
  const workspace = () => workspaceState(workspaceQuery.get());
  const file = join(dataset.skillsRoot, skillId, 'SKILL.md');
  const originalFile = await digest(file);
  let app, visual, baseline, error;
  try {
    app = await NativeUiaSession.launch({ executable, sha256, dataDir: dataset.dataDir, reportPath: join(dataset.root, 'native-driver.json') });
    visual = await VisualSession.attach(app.identity, { root: dataset.root }, env, frame, executable);
    for (const [key, expected] of Object.entries(frame)) assert.equal(visual.identity[key], expected);
    await visual.call('prepareForeground');
    report.identity = visual.identity;
    baseline = protectedState(db);

    async function rows(name, scope, deadline) {
      const remaining = Math.floor(deadline - performance.now());
      assert.ok(remaining > 0, 'Native observation deadline elapsed.');
      return referenceObservationRows(await app.call('state', { name, ...(scope ? { scope, referenceAllowPendingScope: true } : {}),
        referenceReadBudgetMs: remaining }, remaining));
    }
    async function element(name, { scope, type, selected, focused, reveal = false, optional = false } = {}) {
      const deadline = performance.now() + (optional ? 3500 : 15000);
      let scroll = null;
      do {
        const observed = (await rows(name, scope, deadline)).filter(item => !type || item.type === type);
        report.lastNamedObservation = { name, scope, observed };
        assert.ok(observed.length <= 1, 'Ambiguous exact native control ' + name);
        const item = observed[0];
        if (item?.enabled && (selected === undefined || selected === item.selected) &&
            (focused === undefined || focused === item.hasKeyboardFocus)) {
          if (!item.offscreen && inFrame(item.bounds)) return { ...item, scroll };
          if (reveal && !scroll) {
            const before = await visual.call('identity');
            await app.call('reveal', { name }, Math.max(1, Math.floor(deadline - performance.now())));
            const after = await visual.call('identity');
            assert.equal(before.lastInputTick, after.lastInputTick);
            scroll = { method: 'owned-control-ScrollItem', before: item.bounds };
          }
        }
        await sleep(60);
      } while (performance.now() < deadline - 100);
      if (optional) return { observedInFrame: false, lastObservation: report.lastNamedObservation };
      throw new Error('Expected one enabled and entirely visible native control: ' + name);
    }
    async function clickTransition(bounds, before, expectedSection) {
      const input = await visual.call('click', point(bounds));
      const deadline = performance.now() + 12000;
      do {
        const after = workspace();
        if (after.revision > before.revision && after.active === 'document' && after.id &&
            (!before.id || after.id === before.id) && after.section === expectedSection) return { before, after, input };
        if (after.revision > before.revision && before.id && after.id !== before.id)
          throw new Error('Navigation selected an unexpected detail pane. The click was not replayed.');
        await sleep(60);
      } while (performance.now() < deadline);
      throw new Error('Native input did not persist the expected detail section. The click was not replayed.');
    }

    report.stage = 'first-search';
    const search = await element('搜索 Skill', { type: 'ControlType.Edit' });
    await visual.call('click', point(search.bounds));
    await visual.call('text', { value: skillId });
    const result = await element(skillTitle, { scope: '可横向滚动的 Skill 列表', type: button });
    const focusedSearch = await element('搜索 Skill', { type: 'ControlType.Edit', focused: true });
    const value = await app.call('firstSearchValue', { referenceReadBudgetMs: 12000 }, 12000);
    assert.equal(value.matchesExpected, true);
    assert.equal(value.observed, skillId);
    report.search = { result, focusedSearch, value };

    report.stage = 'open-exact-detail';
    const before = workspace();
    assert.equal(before.active, 'home');
    assert.equal(before.id, null);
    report.open = await clickTransition(result.bounds, before, 'docs');
    report.detail = await element(skillTitle, { scope: '工作区标签', type: tab, selected: true });
    report.stage = 'first-screen-description-tab';
    report.description = await element('说明', { scope: 'Skill 详情', type: tab, selected: true });
    report.firstParagraph = await element('仅用于隔离的本地性能验收，不调用外部程序，不连接远端。', {
      type: 'ControlType.Text', optional: true });

    report.stage = 'open-source-and-inspect-management-entries';
    const sourceTab = await element('来源与连接', { scope: 'Skill 详情', type: tab, selected: false });
    report.sourceTransition = await clickTransition(sourceTab.bounds, workspace(), 'source');
    assert.equal(report.sourceTransition.after.id, report.open.after.id);
    report.selectedSource = await element('来源与连接', { scope: 'Skill 详情', type: tab, selected: true });
    report.management = {};
    for (const [name, scope] of [['别名与备注', 'Skill 别名与备注'], ['依赖关系', '资源依赖关系'], ['空间明细', undefined]])
      report.management[name] = await element(name, { scope, type: button, reveal: true });
    assert.equal(workspace().id, report.open.after.id);
    assert.equal(workspace().section, 'source');
    report.stage = 'checks-completed';
  } catch (failure) {
    error = failure;
    throw failure;
  } finally {
    const issues = [];
    if (visual) await visual.finish().catch(failure => issues.push(failure.message));
    if (app) {
      let receipt;
      try { ({ driverReport: receipt } = await app.quit()); }
      catch (failure) { issues.push(failure.message); receipt = app.driverReport; }
      report.normalExit = receipt?.closedNormally === true && receipt.pid === app.identity.pid &&
        receipt.creationFileTime === app.identity.creationFileTime && receipt.windowHandle === app.identity.windowHandle &&
        receipt.executableSha256 === sha256 && !!receipt.dataDirectory && samePath(receipt.dataDirectory, dataset.dataDir);
      if (!report.normalExit) issues.push('No exact owned normal exit was proved.');
    }
    try {
      if (baseline) {
        const final = protectedState(db);
        report.protectedManagementChanged = Object.keys(baseline).filter(table => baseline[table] !== final[table]);
        report.selectedSkillFileUnchanged = await digest(file) === originalFile;
        if (report.protectedManagementChanged.length || !report.selectedSkillFileUnchanged) issues.push('Protected fixture content changed.');
      }
    } catch (failure) { issues.push(failure.message); }
    finally { db.close(); }
    if (issues.length) {
      report.cleanupOrProtectionErrors = issues;
      if (!error) throw new Error(issues.join(' / '));
    }
  }
}

async function main() {
  assert.equal(process.platform, 'win32');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(process.env.GITHUB_REPOSITORY?.toLowerCase(), repository);
  assert.equal(process.env.GITHUB_REF_NAME, branch);
  const { CANDIDATE_ARTIFACT_ID: artifactId, CANDIDATE_SHA256: sha256, CANDIDATE_ARCHIVE_SHA256: archiveSha256 } = process.env;
  checkBinding({ artifactId, sha256, archiveSha256 });
  const [givenExe, givenInfo, frameJson, reportPath] = process.argv.slice(2);
  assert.equal(process.argv.length, 6);
  const executable = await realpath(givenExe), buildPath = await realpath(givenInfo);
  assert.ok(samePath(executable, resolve(process.env.RUNNER_TEMP, 'arm-native-performance', 'agent-resource-manager.exe')));
  assert.ok(samePath(buildPath, resolve(dirname(executable), 'BUILD_INFO.native-validation.json')));
  assert.ok(samePath(reportPath, resolve(process.env.RUNNER_TEMP, 'arm-narrow-detail.json')));
  assert.deepEqual(JSON.parse(frameJson), frame);
  const build = JSON.parse(await readFile(buildPath, 'utf8'));
  assert.equal(build.sourceCommit, source);
  assert.equal(String(build.workflowRunId), candidateRun);
  assert.equal(Number(build.workflowRunAttempt), 1);
  assert.equal(build.repository.toLowerCase(), repository);
  assert.equal(build.buildMode, 'release');
  assert.equal(build.version, '0.3.0-dev.1');
  assert.equal(build.executableSha256, sha256);
  assert.equal(await digest(executable), sha256);
  await mkdir(approved, { recursive: true });
  assert.equal((await lstat(approved)).isSymbolicLink(), false);
  assert.ok(samePath(await realpath(approved), approved));
  const root = await mkdtemp(join(approved, 'native-visual-'));
  const report = {
    format: 'agent-resource-manager-hosted-narrow-detail-v1', status: 'running', syntheticOnly: true,
    source, candidateRun, artifactId, sha256, archiveSha256, frame,
    baselineFailure: { run: '44865721974', rawSha256: '7bbf6ab6295e3237c7882bf495021562f8a239bdf312f1a797a77f76a5690b80',
      descriptionBounds: '342,748,82,56' },
    baselineSearch: { run: '44864093902', rawSha256: 'd461a7ce3a1bcb3ed38c4846e99fda4831a2599104712a3c3f77e9ac9bc45ccf' },
    limitations: ['Only the exact synthetic narrow first-screen flow and visibility of the three Sources entries are covered.',
      'Normal navigation may persist workspace_state. Protected fixture management tables and selected Skill file are checked for changes.'],
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  try {
    const dataset = await createPerformanceFixture(root, 'narrow-detail');
    assert.equal(dataset.dataFingerprint, 'bd3bb8c680b1b7578d376583ab4b416c88ee47b66ae66b813bee455ca31ba3a1');
    assert.equal(dataset.settings.uiZoom, 115);
    assert.equal(dataset.settings.uiFontSize, 18);
    report.fixture = { sha256: dataset.dataFingerprint, skills: dataset.skillCount, tools: dataset.toolCount,
      zoom: dataset.settings.uiZoom, fontSize: dataset.settings.uiFontSize };
    await exercise(dataset, executable, sha256, report);
    assert.equal(await digest(executable), sha256);
    report.status = 'narrow-detail-observed';
  } catch (failure) {
    report.status = 'failed-or-blocked';
    report.error = failure.message;
    throw failure;
  } finally {
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, reportPath }));
  }
}

if (import.meta.main) main().catch(error => { console.error(error.message); process.exitCode = 1; });
