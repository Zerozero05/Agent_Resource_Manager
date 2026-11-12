import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mode = process.argv[2];
assert.ok(process.argv.length === 3 && ['service', 'consumer'].includes(mode));
const root = resolve(process.cwd());
assert.ok(root.toLowerCase().startsWith('d:\\03_github_projects\\agent_resource_manager\\validation\\resources\\native-maintenance-'));
const started = { mode, pid: process.pid, startedAt: new Date().toISOString() };
writeFileSync('started.json', JSON.stringify(started) + '\n', { flag: 'wx' });
console.log(JSON.stringify(started));
// The ordinary runtime owns and releases the service. This independent upper
// bound also lets a stranded synthetic helper exit without external cleanup.
setTimeout(() => console.log(JSON.stringify({ ...started, finishedAt: new Date().toISOString() })), mode === 'service' ? 180000 : 40000);
