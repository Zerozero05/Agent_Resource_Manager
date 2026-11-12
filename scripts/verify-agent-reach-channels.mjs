import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// Representative read-only capability observations. Never persist returned content.
const root = 'D:/03_github_projects/Agent-Reach';
const approved = 'D:/03_github_projects/Agent_Resource_Manager/validation/manager-data';
const phase = process.argv[2];
if (!['before', 'after'].includes(phase)) throw new Error('Choose before or after adoption');
const baseline = phase === 'after' ? JSON.parse(await readFile(process.argv[3], 'utf8')) : null;
if (baseline && baseline.phase !== 'before') throw new Error('After checks require the recorded before baseline');
await mkdir(approved, { recursive: true });
const output = await mkdtemp(join(approved, `reach-${phase}-`));
await mkdir(join(output, 'temp'));
const probes = [
  ['bilibili', 'search', 'mathematics', '--limit', '1'],
  ['v2ex', 'hot', '--limit', '1'],
  ['github', 'read', 'https://github.com/Panniantong/Agent-Reach'],
  ['youtube', 'read', 'https://www.youtube.com/watch?v=jNQXAC9IVRw'],
  ['web', 'read', 'https://example.com'],
  ['xiaohongshu', 'search', '数学', '--limit', '1'],
  ['twitter', 'search', 'mathematics', '--limit', '1'],
  ['douyin', 'search', '数学', '--limit', '1'],
];
const fixedFiles = ['agent-reach.cmd', 'Scripts/agent-reach.exe', 'Lib/site-packages/agent_reach/runtime/cli.py', 'Lib/site-packages/agent_reach/runtime/manage.py', 'Lib/site-packages/agent_reach/channels/bilibili.py', 'Lib/site-packages/agent_reach/channels/douyin.py'];
async function fingerprints() {
  return Object.fromEntries(await Promise.all(fixedFiles.map(async path => [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])));
}
const report = { phase, output, startedAt: new Date().toISOString(), before: await fingerprints(), results: [], limitations: ['One representative action per channel. Search results do not verify comments, subtitles, account functions, or every action.'] };
const run = promisify(execFile);
for (const args of probes) {
  const prior = baseline?.results.find(result => result.channel === args[0]);
  if (prior && ['NEED_LOGIN', 'PLATFORM_BLOCKED', 'RATE_LIMITED', 'BUSY'].includes(prior.errorCode)) {
    const observation = { channel: args[0], action: args[1], skipped: true, reason: prior.errorCode, ok: false, count: 0 };
    report.results.push(observation);
    console.log(JSON.stringify(observation));
    continue;
  }
  const started = Date.now();
  let stdout;
  try {
    ({ stdout } = await run(join(root, 'Scripts/agent-reach.exe'), [...args, '--timeout', '35'], {
      timeout: 65000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PATH: join(root, 'Scripts') + ';' + process.env.PATH, PYTHONDONTWRITEBYTECODE: '1', TEMP: join(output, 'temp'), TMP: join(output, 'temp') },
    }));
  } catch (error) { stdout = error.stdout; }
  let value;
  try { value = JSON.parse(stdout || ''); } catch { value = null; }
  const observation = { channel: args[0], action: args[1], ok: value?.ok === true, count: Array.isArray(value?.items) ? value.items.length : 0, backend: value?.backend || null, errorCode: value?.error?.code || (value ? null : 'NO_JSON_RESULT'), elapsedMs: Date.now() - started };
  report.results.push(observation);
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(observation));
}
report.after = await fingerprints();
report.fixedFilesUnchanged = JSON.stringify(report.before) === JSON.stringify(report.after);
report.finishedAt = new Date().toISOString();
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ report: join(output, 'report.json'), fixedFilesUnchanged: report.fixedFilesUnchanged }));
if (!report.fixedFilesUnchanged) process.exitCode = 1;
