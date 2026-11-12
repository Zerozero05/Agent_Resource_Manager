import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

export const FIXTURE_FORMAT = 'agent-resource-manager-native-performance-v1';

/** All contents are generated test data. No user database or source is copied. */
export async function createPerformanceFixture(parent, name, toolCount = 100) {
  if (!/^[a-z0-9-]{1,64}$/.test(name)) throw new Error('Use a simple, unique fixture name.');
  if (![0, 100].includes(toolCount)) throw new Error('Use exactly 100 tools for mixed scale, or zero for the equal-Skills comparison.');
  parent = resolve(parent);
  if (!isAbsolute(parent) || (process.platform === 'win32' && !/^D:\\/i.test(parent))) throw new Error('Performance fixtures must stay at the selected absolute D-drive location.');
  const root = join(parent, name);
  await mkdir(root); // Exclusive: never reuse, overwrite or migrate existing data.
  await writeFile(join(root, 'fixture-owner.json'), JSON.stringify({ format: FIXTURE_FORMAT, syntheticOnly: true, name, createdAt: new Date().toISOString() }, null, 2));
  const dataDir = join(root, 'data'), skillsRoot = join(root, 'skills'), toolsRoot = join(root, 'tools');
  await Promise.all([mkdir(dataDir), mkdir(skillsRoot), mkdir(toolsRoot)]);
  const skills = [], tools = [], createdAt = '2026-10-30T00:00:00Z';
  const categories = ['论文研究', '工作流程', '工具开发', '技能规范', '日常操作'].map((name, index) => ({ id: `perf-category-${index}`, name, color: ['blue', 'teal', 'purple', 'rose', 'orange'][index] }));
  for (let index = 0; index < 1000; index++) {
    const key = String(index).padStart(4, '0'), id = `perf-skill-${key}`, path = join(skillsRoot, id);
    await mkdir(path);
    const text = `---\nname: ${id}\ndescription: Synthetic local Skill ${key} for native performance acceptance.\nmetadata:\n  version: "1.0.0"\n---\n\n# Perf Skill ${key}\n\n## 作用与适用范围\n\n仅用于隔离的本地性能验收，不调用外部程序，不连接远端。\n\n## 使用方法与示例\n\n阅读本条目；不安装或修改任何用户资源。\n\n## 输入与输出\n\n静态生成的文本，无私人内容。\n\n## 依赖与权限\n\n不需要网络、凭据或系统配置。\n\n## 验证与局限\n\n${'这是生成的说明内容，用于真实WebView中的本地阅读与滚动验收。\n'.repeat(80)}\n`;
    await writeFile(join(path, 'SKILL.md'), text, 'utf8');
    const digest = createHash('sha256').update(text).digest('hex');
    skills.push({ id, name: id, displayName: `Perf Skill ${key}`, description: `Synthetic local content ${key}. Native UI rendering and filtering only.`, localPath: path, status: 'local_only', version: '1.0.0', runtimeFiles: ['SKILL.md'], runtimeConfirmed: true, runtimeAudit: { status: 'verified', warnings: [], checkedAt: createdAt }, runtimeWarnings: [], runtimeIssues: [], localHashes: { 'SKILL.md': digest }, categoryId: categories[index % categories.length].id, favorite: index % 10 === 0, readOnly: false });
  }
  for (let index = 0; index < toolCount; index++) {
    const key = String(index).padStart(3, '0'), id = `perf-tool-${key}`, rootPath = join(toolsRoot, id);
    await mkdir(rootPath); await writeFile(join(rootPath, 'README.md'), `# Synthetic Tool ${key}\n\nNo executable, no login and no mutable tool data.\n`);
    tools.push({ id, name: `Perf Tool ${key}`, kind: ['cli', 'portable', 'mcp'][index % 3], rootPath, repository: null, version: '1.0.0', alias: '', notes: 'Generated performance catalogue entry; no runnable actions.', enabled: true, ownership: 'external', managementScope: 'register', actions: [], capabilities: [], updatePolicy: { mode: 'manual', intervalHours: 24, pinnedVersion: null, skippedVersions: [] }, installation: null, revision: 1, createdAt, updatedAt: createdAt });
  }
  const state = { skills, sources: [], connections: [], localRoots: [], ignoredLocalPaths: [], checkMode: 'manual', checkGeneration: 0, checkSummary: null, stateRevision: 1, settings: { checkIntervalMinutes: 30, uiTheme: 'dark', uiZoom: 115, uiFontSize: 18, uiDensity: 'comfortable', uiAccent: 'violet', uiMotion: 'light', libraryMode: 'list', libraryPageSize: 20, librarySort: 'name', categories, sidebarWidth: 224, sidebarCollapsed: false } };
  const dbPath = join(dataDir, 'manager.sqlite3'), db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE app_state (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, payload TEXT NOT NULL); CREATE TABLE workspace_state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL); CREATE TABLE resource_catalog (id TEXT PRIMARY KEY,root_key TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL CHECK(revision>0),payload TEXT NOT NULL); CREATE TABLE resource_catalog_meta (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL); BEGIN IMMEDIATE;');
    db.prepare('INSERT INTO app_state VALUES(1,1,?)').run(JSON.stringify(state));
    const insert = db.prepare('INSERT INTO resource_catalog VALUES(?,?,1,?)');
    for (const tool of tools) insert.run(tool.id, process.platform === 'win32' ? tool.rootPath.replaceAll('/', '\\').toLowerCase() : tool.rootPath, JSON.stringify(tool));
    db.prepare('INSERT INTO resource_catalog_meta VALUES(1,?)').run(tools.length);
    db.exec('COMMIT;');
  } finally { db.close(); }
  const dataset = { format: FIXTURE_FORMAT, syntheticOnly: true, root, dataDir, dbPath, skillsRoot, toolsRoot, skillCount: skills.length, toolCount: tools.length, databaseBytes: (await stat(dbPath)).size, settings: state.settings, dataFingerprint: createHash('sha256').update(JSON.stringify({ skillCount: skills.length, toolCount: tools.length, template: 'static-skill-v1', settings: state.settings })).digest('hex') };
  await writeFile(join(root, 'dataset.json'), JSON.stringify(dataset, null, 2) + '\n');
  return dataset;
}
