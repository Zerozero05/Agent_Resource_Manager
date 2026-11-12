import { readFile, readdir, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

// Browser layout probe only: representative package rows with the production CSS.
// Does not claim native installation, keyboard, or performance acceptance.
const root = resolve(import.meta.dirname, '..');
const output = await mkdtemp(join(root, 'outputs/v1-validation/file-row-layout-'));
await mkdir(join(output, 'temp'));
const assets = await readdir(join(root, 'dist/assets'));
const css = await Promise.all(['index-', 'WorkspaceApp-', 'ResourcePanel-'].map(async prefix => {
  const files = assets.filter(name => name.startsWith(prefix) && name.endsWith('.css'));
  assert.equal(files.length, 1, `Build one current ${prefix} stylesheet first`);
  return { name: files[0], content: await readFile(join(root, 'dist/assets', files[0]), 'utf8') };
}));
const row = (path, size) => `<div class="resource-package-file"><label><input type="checkbox" checked><span>${path}</span><small>${size} KiB</small></label><select aria-label="${path}用途"><option>运行文件</option><option>专用依赖</option></select></div>`;
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css.map(file => file.content).join('\n')}
body{margin:0;padding:16px;overflow:auto;height:auto}#fixture{margin:0}.resource-lifecycle-panel{margin-top:0}</style></head><body>
<main id="fixture" class="resource-panel"><section class="resource-lifecycle-panel"><h2>发行包文件</h2><div class="resource-file-selection">
${row('bin/runtime.txt', '1.2')}${row('private/dependency.txt', '4.6')}${row('resources/中文说明与English-long-name-without-spaces-012345678901234567890123456789.txt', '0.0')}
</div></section></main><pre id="result"></pre><script>
const results = [];
const panel = document.getElementById('fixture');
for (const theme of ['light','dark','eye']) for (const font of [14,18,22]) for (const zoom of [0.8,1.15,1.6]) for (const width of [280,480,900]) {
 document.documentElement.dataset.theme = theme;
 document.documentElement.style.fontSize = font + 'px';
 document.documentElement.style.setProperty('--base-font-size', font + 'px');
 panel.style.width = width + 'px'; panel.style.zoom = zoom;
 panel.style.fontSize = font + 'px';
 const rows = [...panel.querySelectorAll('.resource-package-file')];
 const rects = rows.map(row => ({row:row.getBoundingClientRect(), select:row.querySelector('select').getBoundingClientRect(), label:row.querySelector('label').getBoundingClientRect()}));
 const failures = [];
 rects.forEach((r,i) => {
  if (r.select.top < r.row.top || r.select.bottom > r.row.bottom + 0.5) failures.push('control-outside-row');
  if (r.select.left < r.row.left - 0.5 || r.select.right > r.row.right + 0.5) failures.push('horizontal-overflow');
  if (Math.min(r.select.right,r.label.right)-Math.max(r.select.left,r.label.left)>0.5 && Math.min(r.select.bottom,r.label.bottom)-Math.max(r.select.top,r.label.top)>0.5) failures.push('label-control-overlap');
  if (i && r.select.top-rects[i-1].select.bottom < 8*zoom-0.5) failures.push('adjacent-controls-too-close');
 });
 results.push({theme,font,zoom,width,failures});
}
document.getElementById('result').textContent = JSON.stringify({cases:results.length,failed:results.filter(result=>result.failures.length),styles:${JSON.stringify(css.map(file => file.name))}});
document.documentElement.dataset.theme='light';panel.style.width='480px';panel.style.zoom='1';
</script></body></html>`;
const fixture = join(output, 'fixture.html');
await writeFile(fixture, html);
const { stdout, stderr } = await promisify(execFile)('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless', '--disable-gpu', '--no-first-run', `--user-data-dir=${join(output, 'edge-profile')}`, '--dump-dom', pathToFileURL(fixture).href,
], { timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, TEMP: join(output, 'temp'), TMP: join(output, 'temp') } });
await writeFile(join(output, 'browser.log'), stderr);
const match = stdout.match(/<pre id="result">([^<]+)<\/pre>/);
assert(match, 'Browser did not return the layout observations');
const report = JSON.parse(match[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, ...report }));
assert.deepEqual(report.failed, [], 'Package controls must remain separated and within their rows');
