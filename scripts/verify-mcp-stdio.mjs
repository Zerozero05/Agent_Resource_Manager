import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, access, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

const executable = process.argv[2];
if (!executable) throw new Error('Pass the compiled manager executable path.');
const outputs = resolve('outputs/v1-validation');
await mkdir(outputs, { recursive: true });
const fixture = await mkdtemp(join(outputs, 'stdio-smoke-'));
const unusedData = join(fixture, 'must-not-be-created');
const messages = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic-native-smoke', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'apply_resource_remove', arguments: { previewId: 'forged', confirmed: true } } },
  { jsonrpc: '2.0', id: 4, method: 'ping' },
];
async function run(args, input = '') {
  const child = spawn(resolve(executable), args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  const result = await new Promise((done, fail) => {
    const timer = setTimeout(() => { child.kill(); fail(new Error('Synthetic startup did not exit within 15 seconds.')); }, 15000);
    child.once('error', error => { clearTimeout(timer); fail(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); done({ code, signal }); });
    child.stdin.end(input);
  });
  return { result, stdout, stderr };
}
const { result, stdout, stderr } = await run(['--mcp', '--data-dir', unusedData], messages.map(message => JSON.stringify(message)).join('\n') + '\n');
assert.deepEqual(result, { code: 0, signal: null });
assert.equal(stderr, '', 'discovery must not log startup errors or create a GUI backend');
const replies = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
assert.equal(replies.length, 4, 'notifications must not create responses');
assert.equal(replies[0].result.protocolVersion, '2025-11-25');
assert(replies[1].result.tools.some(tool => tool.name === 'resource_invoke'));
const cacheTool = replies[1].result.tools.find(tool => tool.name === 'content_cache_stats');
assert(cacheTool && cacheTool.annotations.readOnlyHint === true, 'shared content-cache diagnostics must be a fixed readonly tool');
assert.equal(cacheTool.inputSchema.additionalProperties, false, 'cache observation cannot accept arbitrary action or content selectors');
assert(replies[1].result.tools.some(tool => tool.name === 'task_result_files'));
assert(replies[1].result.tools.some(tool => tool.name === 'resource_space'));
assert(!replies[1].result.tools.some(tool => tool.name === 'task_open_result'));
for (const name of ['resource_scenes', 'resource_scene_activate', 'resource_idle', 'resource_keep_alive', 'resource_usage_begin', 'resource_usage_end']) assert(replies[1].result.tools.some(tool => tool.name === name), name);
for (const name of ['resource_scene_save', 'resource_scene_remove', 'resource_idle_set']) assert(!replies[1].result.tools.some(tool => tool.name === name), name);
assert(replies[1].result.tools.some(tool => tool.name === 'resource_github_releases'));
assert(replies[1].result.tools.some(tool => tool.name === 'preview_resource_download'));
assert(replies[1].result.tools.some(tool => tool.name === 'resource_downloads'));
assert(replies[1].result.tools.some(tool => tool.name === 'preview_resource_resume'));
assert(replies[1].result.tools.some(tool => tool.name === 'preview_resource_repair'));
for (const name of ['resource_templates', 'resource_template_prepare', 'resource_relations', 'resource_source', 'resource_source_health', 'preview_resource_source', 'skill_source_health', 'preview_associate']) {
  const tool = replies[1].result.tools.find(tool => tool.name === name);
  assert(tool, `missing read operation: ${name}`);
  assert.equal(tool.annotations.readOnlyHint, true);
}
assert(replies[1].result.tools.find(tool => tool.name === 'resource_invoke').inputSchema.properties.expectedRevision);
assert(!replies[1].result.tools.some(tool => tool.name === 'resource_template_save'));
assert(!replies[1].result.tools.some(tool => tool.name === 'resource_template_remove'));
assert(!replies[1].result.tools.some(tool => tool.name === 'resource_relation_add'));
assert(!replies[1].result.tools.some(tool => tool.name === 'resource_relation_remove'));
assert(!replies[1].result.tools.some(tool => tool.name === 'apply_resource_remove'));
assert(!replies[1].result.tools.some(tool => tool.name === 'apply_resource_download'));
assert(!replies[1].result.tools.some(tool => tool.name === 'apply_resource_repair'));
assert(!replies[1].result.tools.some(tool => tool.name === 'apply_resource_source'));
assert(!replies[1].result.tools.some(tool => tool.name === 'apply_associate'));
assert.equal(replies[2].error.code, -32602);
assert.deepEqual(replies[3].result, {});
await assert.rejects(access(unusedData), { code: 'ENOENT' });
const invalidMode = await run(['--mcp', '--basic-mode', '--data-dir', unusedData]);
assert.equal(invalidMode.result.code, 1);
assert.equal(invalidMode.stdout, '');
assert(invalidMode.stderr.includes('--basic-mode'));
const failedBackground = await run(['--background', '--basic-mode', '--data-dir', unusedData]);
assert.equal(failedBackground.result.code, 1, 'failed background startup must not wait for an invisible dialog or report success');
assert.equal(failedBackground.stdout, '');
assert(failedBackground.stderr.length > 0);
await assert.rejects(access(unusedData), { code: 'ENOENT' });
const hash = createHash('sha256');
for await (const chunk of createReadStream(resolve(executable))) hash.update(chunk);
const evidence = { executable: resolve(executable), sha256: hash.digest('hex'), fixture, startup: 'protocol-only', replies: replies.map(reply => ({ id: reply.id, errorCode: reply.error?.code ?? null })), toolCount: replies[1].result.tools.length, databaseCreated: false, result, invalidMode: invalidMode.result, failedBackground: failedBackground.result };
await writeFile(join(fixture, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
