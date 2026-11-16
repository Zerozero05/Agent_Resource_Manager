import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import childProcess from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { NativeUiaSession, assertNoUserManager, runManagerPreflightCli } from '../scripts/native-uia-client.mjs';

function driver(closedNormally) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  const session = new NativeUiaSession(child, 'D:/03_github_projects/Agent_Management/Agent_Resource_Manager/validation/missing-test-driver-report.json');
  child.stdout.write(JSON.stringify({ event: 'ready', pid: 1 }) + '\n');
  child.stdin.once('data', data => {
    const request = JSON.parse(data.toString());
    assert.equal(request.op, 'quit');
    child.stdout.write(JSON.stringify({ id: request.id, ok: true, value: { closedNormally } }) + '\n');
    child.stdout.write(JSON.stringify({ closedNormally }) + '\n');
    // No close event: a surviving GUI descendant can retain the pipe handles.
    setImmediate(() => child.emit('exit', closedNormally ? 0 : 1));
  });
  return session;
}

test('native driver exit settles even when inherited GUI pipes never emit close', { timeout: 2000 }, async () => {
  const session = driver(true);
  await session.ready;
  assert.equal((await session.quit()).driverReport.closedNormally, true);
  assert.equal(session.exited, true);
});

test('driver termination never promotes an unverified native application exit to success', { timeout: 2000 }, async () => {
  const session = driver(false);
  await session.ready;
  await assert.rejects(session.quit(), /did not finish the real normal exit/);
  assert.equal(session.exitCode, 1);
});

function transportDriver(stdin = new PassThrough()) {
  const child = new EventEmitter(), requests = [];
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = stdin;
  const session = new NativeUiaSession(child, 'D:/03_github_projects/Agent_Management/Agent_Resource_Manager/validation/missing-test-driver-report.json');
  stdin.on('data', data => requests.push(JSON.parse(data.toString())));
  child.stdout.write(JSON.stringify({ event: 'ready', pid: 1 }) + '\n');
  return { session, child, requests };
}

test('observation timeout closes input once and preserves its cause through late pipe errors and failed exit', { timeout: 2000 }, async context => {
  const { session, child, requests } = transportDriver();
  await session.ready;
  const end = context.mock.method(child.stdin, 'end');
  child.stdin.once('finish', () => setImmediate(() => {
    child.stdin.emit('error', Object.assign(new Error('late write after end'), { code: 'ERR_STREAM_WRITE_AFTER_END' }));
    child.emit('exit', 1);
  }));
  const results = await Promise.allSettled([session.call('windowIdentity', {}, 10), session.call('memory', {}, 60000)]);
  const failure = results[0].reason;
  assert.equal(results[0].status, 'rejected');
  assert.match(failure.message, /windowIdentity exceeded its observation deadline; no command was replayed/);
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason, failure);
  await assert.rejects(session.call('memory'), error => error === failure);
  await assert.rejects(session.quit(), error => error === failure);
  assert.deepEqual(requests.map(request => request.op), ['windowIdentity', 'memory']);
  assert.equal(end.mock.calls.length, 1);
  assert.equal(session.pending.size, 0);
  assert.equal(session.failure, failure);
});

test('an observation timeout remains the failure when the normal exit wait also expires', async context => {
  const { session, child, requests } = transportDriver();
  await session.ready;
  context.after(() => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let failure;
  const observation = assert.rejects(session.call('memory', {}, 10), error => { failure = error; return /observation deadline/.test(error.message); });
  context.mock.timers.tick(10);
  await observation;
  const exit = assert.rejects(session.quit(), error => error === failure);
  context.mock.timers.tick(25000);
  await exit;
  assert.deepEqual(requests.map(request => request.op), ['memory']);
  assert.equal(session.exited, false);
});

test('ended and destroyed input pipes reject without writing a request or allocating a pending timer', async context => {
  for (const close of ['end', 'destroy']) {
    const { session, child, requests } = transportDriver();
    await session.ready;
    child.stdin[close]();
    const write = context.mock.method(child.stdin, 'write', () => { throw new Error('Closed input must never receive a write.'); });
    let failure;
    await assert.rejects(session.call('memory'), error => { failure = error; return /input pipe is closed; no command was sent or replayed/.test(error.message); });
    child.emit('exit', 1);
    await assert.rejects(session.quit(), error => error === failure);
    assert.equal(write.mock.calls.length, 0);
    assert.equal(session.nextId, 1);
    assert.equal(session.pending.size, 0);
    assert.deepEqual(requests, []);
  }
});

test('asynchronous pipe write failures reject pending work and remain handled when emitted as stream errors', { timeout: 2000 }, async () => {
  const failure = Object.assign(new Error('synthetic broken input pipe'), { code: 'EPIPE' });
  let writes = 0, streamErrors = 0;
  const stdin = new Writable({ write(chunk, encoding, callback) { writes++; setImmediate(() => callback(failure)); } });
  const { session, child } = transportDriver(stdin);
  stdin.on('error', () => streamErrors++);
  await session.ready;
  await assert.rejects(session.call('memory'), error => error === failure);
  await new Promise(resolve => setImmediate(resolve));
  child.emit('exit', 1);
  await assert.rejects(session.quit(), error => error === failure);
  assert.equal(streamErrors, 1);
  assert.equal(writes, 1);
  assert.equal(session.pending.size, 0);
});

test('synchronous write exceptions clear the pending request and retain the original failure', async context => {
  const { session, child, requests } = transportDriver();
  await session.ready;
  const failure = new Error('synthetic synchronous input failure');
  const write = context.mock.method(child.stdin, 'write', () => { throw failure; });
  await assert.rejects(session.call('memory'), error => error === failure);
  child.emit('exit', 1);
  await assert.rejects(session.quit(), error => error === failure);
  assert.equal(write.mock.calls.length, 1);
  assert.equal(session.pending.size, 0);
  assert.deepEqual(requests, []);
});

test('a driver operation failure is not replaced by exit cleanup or promoted by a normal-close report', async () => {
  const { session, child, requests } = transportDriver();
  await session.ready;
  const request = session.call('memory');
  child.stdout.write(JSON.stringify({ id: requests[0].id, ok: false, error: 'synthetic observation failure' }) + '\n');
  let failure;
  await assert.rejects(request, error => { failure = error; return /Native UIA memory: synthetic observation failure/.test(error.message); });
  child.stdout.write(JSON.stringify({ closedNormally: true }) + '\n');
  child.emit('exit', 0);
  await assert.rejects(session.quit(), error => error === failure);
  assert.deepEqual(requests.map(request => request.op), ['memory']);
  assert.equal((await session.closed).driverReport.closedNormally, true);
});

test('concurrent observation cannot launch without explicit accessibility input', async () => {
  await assert.rejects(NativeUiaSession.launch({ concurrentObservation: true }), /requires explicit native accessibility input/);
});

function processCheck(context, value, error = null) {
  return context.mock.method(childProcess, 'execFile', (executable, arguments_, options, callback) => {
    callback(error, typeof value === 'string' ? value : JSON.stringify(value));
  });
}

test('default strict manager preflight permits an empty list without querying command lines', async context => {
  const check = processCheck(context, { checked: true, managers: [] });
  assert.deepEqual(await assertNoUserManager(), { checked: true, managers: [] });
  assert.equal(check.mock.calls.length, 1);
  const [executable, arguments_, options] = check.mock.calls[0].arguments;
  assert.equal(executable, 'pwsh.exe');
  assert.deepEqual(arguments_.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.match(arguments_[3], /Get-CimInstance Win32_Process/);
  assert.match(arguments_[3], /GetOwnerSid/);
  assert.doesNotMatch(arguments_[3], /SessionId|Stop-Process|TerminateProcess|CommandLine/);
  assert.equal(options.windowsHide, true);
  assert.equal(options.timeout, 10000);
  assert.equal(options.maxBuffer, 64 * 1024);
});

test('manager preflight permits confirmed other users and returns only process identity metadata', async context => {
  processCheck(context, { checked: true, managers: [{ name: 'skill-manager.exe', pid: 11, ownership: 'otherUser', ownerSid: 'PRIVATE_SID_MARKER', sessionId: 1 }] });
  assert.deepEqual(await assertNoUserManager({ pwsh: 'D:/existing/pwsh.exe' }), { checked: true, managers: [{ name: 'skill-manager.exe', pid: 11, ownership: 'otherUser' }] });
});

test('manager preflight rejects a same-user manager regardless of its desktop session', async context => {
  processCheck(context, { checked: true, managers: [{ name: 'agent-resource-manager.exe', pid: 12, ownership: 'sameUser', sessionId: 999 }] });
  await assert.rejects(assertNoUserManager(), /existing manager process\. agent-resource-manager\.exe \(PID 12, same user\)/);
});

test('manager preflight rejects uncertain ownership and keeps raw owner data out of its error', async context => {
  processCheck(context, { checked: true, managers: [{ name: 'skill-manager.exe', pid: 13, ownership: 'unknown', ownerSid: 'PRIVATE_SID_MARKER' }] });
  await assert.rejects(assertNoUserManager(), error => /PID 13, ownership unknown/.test(error.message) && !error.message.includes('PRIVATE_SID_MARKER'));
});

test('manager preflight rejects command failure and malformed or incomplete results', async context => {
  const check = processCheck(context, '', new Error('PRIVATE_STDERR_MARKER'));
  await assert.rejects(assertNoUserManager(), error => /Could not verify/.test(error.message) && !error.message.includes('PRIVATE_STDERR_MARKER'));
  check.mock.restore();
  for (const output of ['not-json', null, {}, { checked: false, managers: [] }, { checked: true, managers: {} }]) {
    const invalid = processCheck(context, output);
    await assert.rejects(assertNoUserManager(), /invalid JSON|incomplete result/);
    invalid.mock.restore();
  }
});

test('manager preflight rejects invalid process identity and ownership records', async context => {
  const valid = { name: 'skill-manager.exe', pid: 14, ownership: 'otherUser' };
  for (const managers of [[null], [{ ...valid, name: 'unrelated.exe' }], [{ ...valid, pid: '14' }], [{ ...valid, pid: 0 }], [{ ...valid, ownership: 'unverified' }], [valid, valid]]) {
    const check = processCheck(context, { checked: true, managers });
    await assert.rejects(assertNoUserManager(), /invalid process record/);
    check.mock.restore();
  }
});

test('manager preflight validates its executable before invoking a command', async context => {
  const check = processCheck(context, { checked: true, managers: [] });
  for (const pwsh of ['', '  ', null, false, 1, 'path\0suffix']) {
    await assert.rejects(assertNoUserManager({ pwsh }), /PowerShell executable path/);
  }
  assert.equal(check.mock.calls.length, 0);
});

test('native launch rejects an existing same-user backend before spawning a driver', async context => {
  processCheck(context, { checked: true, managers: [{ name: 'agent-resource-manager.exe', pid: 15, ownership: 'sameUser' }] });
  const spawn = context.mock.method(childProcess, 'spawn', () => { throw new Error('Driver must not spawn during blocked preflight.'); });
  await assert.rejects(NativeUiaSession.launch({ dataDir: 'D:/unused-synthetic-data', pwsh: 'D:/existing/pwsh.exe' }), /PID 15, same user/);
  assert.equal(spawn.mock.calls.length, 0);
});

const candidateSha256 = 'f9dfe387f6900925808cdd16b9785f29b96e90c40b554b828b17557f99bd846f';
function transport() {
  return {
    name: 'agent-resource-manager.exe', pid: 201, ownership: 'sameUser', role: 'mcpTransport',
    transportProof: {
      currentFileSha256: candidateSha256,
      executable: 'D:\\03_github_projects\\Agent_Management\\Agent_Resource_Manager\\app\\agent-resource-manager.exe',
      createdFileTime: '134388700647784010', appWriteFileTime: '134388600647784010',
      parentPid: 101, hostPid: 101, hostCreatedFileTime: '134388500647784010',
      hostExecutable: 'C:\\Users\\Administrator\\AppData\\Local\\OpenAI\\Codex\\bin\\5449c1f0f26f1f98\\codex.exe',
      physicalPathVerified: true, exactMcpArgv: true, hostSameUser: true, identityRechecked: true,
      roleEvidence: 'current-file-start-identity', loadedImageSha256: null,
    },
  };
}

test('bound candidate preflight permits only a fully verified pure MCP transport and returns limited proof metadata', async context => {
  const process = transport();
  process.privateCommand = 'PRIVATE_COMMAND_MARKER';
  const check = processCheck(context, { checked: true, managers: [process] });
  assert.deepEqual(await assertNoUserManager({ transportSha256: candidateSha256 }), {
    checked: true, managers: [{ name: process.name, pid: 201, ownership: 'sameUser', role: 'mcpTransport', createdFileTime: process.transportProof.createdFileTime, hostPid: 101, roleEvidence: 'current-file-start-identity', loadedImageSha256: null }],
  });
  const [, arguments_, options] = check.mock.calls[0].arguments;
  const command = arguments_[3];
  assert.match(command, /Get-TransportProof/);
  assert.match(command, /CreationDate,CommandLine/);
  assert.match(command, /CommandLineToArgvW/);
  assert.match(command, /\$argv\[0\]\.Replace\('\/','\\'\)/);
  assert.match(command, /\$argv\.Count -ne 2/);
  assert.match(command, /\$argv\[1\] -cne '--mcp'/);
  assert.match(command, /\$ownership -eq 'sameUser'/);
  assert.match(command, /ReparsePoint/);
  assert.match(command, /\$current -is \[IO\.DirectoryInfo\]/);
  assert.match(command, /Get-FileHash/);
  assert.match(command, /Transport process identity changed/);
  assert.match(command, /Manager process inventory changed/);
  assert.doesNotMatch(command, /Stop-Process|TerminateProcess|SessionId|\$host\b/i);
  assert.equal(options.windowsHide, true);
});

test('a transport-looking record remains blocked without a verified candidate hash', async context => {
  processCheck(context, { checked: true, managers: [transport()] });
  await assert.rejects(assertNoUserManager(), /existing manager process/);
});

test('GUI, background, uncertain roles and incomplete transport evidence remain blocked', async context => {
  const cases = [
    { role: 'gui' }, { role: 'background' }, { role: 'unknown' }, { ownership: 'unknown' },
    { name: 'skill-manager.exe' }, { transportProof: null },
  ];
  const proofCases = [
    { currentFileSha256: 'a'.repeat(64) }, { executable: 'D:\\elsewhere\\agent-resource-manager.exe' },
    { physicalPathVerified: false }, { exactMcpArgv: false }, { hostSameUser: false }, { identityRechecked: false },
    { createdFileTime: '134388400647784010' }, { createdFileTime: '' }, { appWriteFileTime: 'unknown' },
    { parentPid: 999 }, { hostPid: 201 }, { hostPid: 0 }, { hostCreatedFileTime: '134388900647784010' },
    { hostExecutable: 'D:\\unverified\\codex.exe' }, { hostExecutable: 'C:\\Users\\Administrator\\AppData\\Local\\OpenAI\\Codex\\bin\\unknown\\codex.exe' },
    { roleEvidence: 'unreviewed' }, { loadedImageSha256: candidateSha256 },
  ];
  for (const patch of cases) {
    const record = { ...transport(), ...patch };
    const check = processCheck(context, { checked: true, managers: [record] });
    await assert.rejects(assertNoUserManager({ transportSha256: candidateSha256 }), /existing manager process/);
    check.mock.restore();
  }
  for (const patch of proofCases) {
    const record = transport(); record.transportProof = { ...record.transportProof, ...patch };
    const check = processCheck(context, { checked: true, managers: [record] });
    await assert.rejects(assertNoUserManager({ transportSha256: candidateSha256 }), /existing manager process/);
    check.mock.restore();
  }
});

test('verified transports do not hide an additional same-user GUI or unknown process', async context => {
  for (const ownership of ['sameUser', 'unknown']) {
    const check = processCheck(context, { checked: true, managers: [transport(), { name: 'agent-resource-manager.exe', pid: 202, ownership }] });
    await assert.rejects(assertNoUserManager({ transportSha256: candidateSha256 }), /PID 202/);
    check.mock.restore();
  }
});

test('native launch passes its bound SHA into preflight and still does not spawn when a GUI is present', async context => {
  const check = processCheck(context, { checked: true, managers: [{ name: 'agent-resource-manager.exe', pid: 202, ownership: 'sameUser' }] });
  const spawn = context.mock.method(childProcess, 'spawn', () => { throw new Error('A real GUI must remain blocking.'); });
  await assert.rejects(NativeUiaSession.launch({ dataDir: 'D:/unused-synthetic-data', sha256: candidateSha256 }), /PID 202/);
  assert.match(check.mock.calls[0].arguments[1][3], new RegExp(candidateSha256));
  assert.equal(spawn.mock.calls.length, 0);
});

test('invalid transport hashes are rejected before process inspection', async context => {
  const check = processCheck(context, { checked: true, managers: [] });
  for (const transportSha256 of ['', null, false, 'not-a-hash', 'a'.repeat(63), 'a'.repeat(65), "a'.repeat(64)"]) {
    await assert.rejects(assertNoUserManager({ transportSha256 }), /verified candidate SHA256/);
  }
  assert.equal(check.mock.calls.length, 0);
});

function pinFor(record) {
  const proof = record.transportProof;
  return { pid: record.pid, createdFileTime: proof.createdFileTime, parentPid: proof.hostPid,
    hostCreatedFileTime: proof.hostCreatedFileTime, hostExecutable: proof.hostExecutable,
    executable: proof.executable, role: 'mcpTransport', exactMcpArgv: true, loadedImageSha256: null };
}

test('an explicitly pinned existing transport can predate current disk bytes without a loaded-image digest claim', async context => {
  const record = transport();
  record.transportProof.appWriteFileTime = '134388800647784010';
  record.transportProof.roleEvidence = 'pinned-existing-stdio';
  const pinnedTransports = [pinFor(record)];
  const check = processCheck(context, { checked: true, managers: [record] });
  const result = await assertNoUserManager({ transportSha256: candidateSha256, pinnedTransports });
  assert.equal(result.managers[0].roleEvidence, 'pinned-existing-stdio');
  assert.equal(result.managers[0].loadedImageSha256, null);
  assert.match(check.mock.calls[0].arguments[1][3], /pinnedTransportMap/);
  assert.match(check.mock.calls[0].arguments[1][3], /elseif\(\[long\]\$created -lt \[long\]\$appProof\.writeTime\)/);
});

test('a pin is not a general exemption for a new PID, reused birth, changed host or different role', async context => {
  const original = transport(); original.transportProof.roleEvidence = 'pinned-existing-stdio';
  const pinnedTransports = [pinFor(original)];
  const cases = [
    { pid: 202 },
    { transportProof: { ...original.transportProof, createdFileTime: '134388710647784010' } },
    { transportProof: { ...original.transportProof, hostCreatedFileTime: '134388510647784010' } },
    { transportProof: { ...original.transportProof, hostExecutable: original.transportProof.hostExecutable.replace('5449c1f0f26f1f98', 'aaaaaaaaaaaaaaaa') } },
    { transportProof: { ...original.transportProof, roleEvidence: 'current-file-start-identity' } },
    { transportProof: { ...original.transportProof, exactMcpArgv: false } },
    { transportProof: { ...original.transportProof, loadedImageSha256: candidateSha256 } },
  ];
  for (const patch of cases) {
    const check = processCheck(context, { checked: true, managers: [{ ...original, ...patch }] });
    await assert.rejects(assertNoUserManager({ transportSha256: candidateSha256, pinnedTransports }), /existing manager process/);
    check.mock.restore();
  }
});

test('invalid or unbound pin lists are rejected before querying processes', async context => {
  const record = transport(), pin = pinFor(record);
  const check = processCheck(context, { checked: true, managers: [] });
  for (const pinnedTransports of [null, {}, [pin, pin], [{ ...pin, loadedImageSha256: candidateSha256 }], [{ ...pin, createdFileTime: 'unknown' }], [{ ...pin, exactMcpArgv: false }]]) {
    await assert.rejects(assertNoUserManager({ transportSha256: candidateSha256, pinnedTransports }), /Pinned transports/);
  }
  await assert.rejects(assertNoUserManager({ pinnedTransports: [pin] }), /Pinned transports/);
  assert.equal(check.mock.calls.length, 0);
});

test('launch forwards explicit process pins to preflight without exempting another GUI', async context => {
  const record = transport(); record.transportProof.roleEvidence = 'pinned-existing-stdio';
  const check = processCheck(context, { checked: true, managers: [record, { name: 'agent-resource-manager.exe', pid: 202, ownership: 'sameUser' }] });
  const spawn = context.mock.method(childProcess, 'spawn', () => { throw new Error('A real GUI remains blocking.'); });
  await assert.rejects(NativeUiaSession.launch({ dataDir: 'D:/unused-synthetic-data', sha256: candidateSha256, pinnedTransports: [pinFor(record)] }), /PID 202/);
  assert.match(check.mock.calls[0].arguments[1][3], /pinnedTransportMap/);
  assert.equal(spawn.mock.calls.length, 0);
});

test('a newer diagnostic candidate uses the separately bound formal transport digest without hiding another GUI', async context => {
  const record = transport(); record.transportProof.roleEvidence = 'pinned-existing-stdio';
  const diagnosticSha256 = 'd'.repeat(64);
  const check = processCheck(context, { checked: true, managers: [record, { name: 'agent-resource-manager.exe', pid: 202, ownership: 'sameUser' }] });
  const spawn = context.mock.method(childProcess, 'spawn', () => { throw new Error('An additional GUI remains blocking.'); });
  await assert.rejects(NativeUiaSession.launch({ dataDir: 'D:/unused-synthetic-data', sha256: diagnosticSha256, transportSha256: candidateSha256, pinnedTransports: [pinFor(record)] }), error => /PID 202/.test(error.message) && !/PID 201/.test(error.message));
  const command = check.mock.calls[0].arguments[1][3];
  assert.match(command, new RegExp(candidateSha256));
  assert.ok(!command.includes(diagnosticSha256));
  assert.equal(spawn.mock.calls.length, 0);
});

test('a separate formal transport digest still rejects invalid hashes before inspecting or spawning', async context => {
  const check = processCheck(context, { checked: true, managers: [] });
  const spawn = context.mock.method(childProcess, 'spawn', () => { throw new Error('Invalid transport identity must not launch a driver.'); });
  await assert.rejects(NativeUiaSession.launch({ sha256: candidateSha256, transportSha256: 'unverified-formal-file', pinnedTransports: [pinFor(transport())] }), /verified candidate SHA256/);
  assert.equal(check.mock.calls.length, 0);
  assert.equal(spawn.mock.calls.length, 0);
});

function guardCliArguments(transports, patch = {}) {
  const proof = { candidateSha256, transports, ...patch };
  return ['--manager-preflight', '--sha256', candidateSha256, '--pinned-transports-base64', Buffer.from(JSON.stringify(proof)).toString('base64')];
}

test('guard-only CLI repeats the full bound process check without spawning a native driver', async context => {
  const record = transport(); record.transportProof.roleEvidence = 'pinned-existing-stdio';
  record.transportProof.appWriteFileTime = '134388800647784010';
  const check = processCheck(context, { checked: true, managers: [record] });
  const spawn = context.mock.method(childProcess, 'spawn', () => { throw new Error('Guard-only mode must never launch the product.'); });
  const result = await runManagerPreflightCli(guardCliArguments([pinFor(record)]));
  assert.equal(result.managers[0].roleEvidence, 'pinned-existing-stdio');
  assert.equal(result.managers[0].loadedImageSha256, null);
  assert.equal(check.mock.calls.length, 1);
  assert.match(check.mock.calls[0].arguments[1][3], /Manager process inventory changed/);
  assert.equal(spawn.mock.calls.length, 0);
});

test('guard-only CLI accepts empty pins only through the full current-file and process-start identity proof', async context => {
  const check = processCheck(context, { checked: true, managers: [transport()] });
  const spawn = context.mock.method(childProcess, 'spawn', () => { throw new Error('Guard-only mode must not start the product.'); });
  const result = await runManagerPreflightCli(guardCliArguments([]));
  assert.equal(result.managers[0].roleEvidence, 'current-file-start-identity');
  assert.equal(result.managers[0].loadedImageSha256, null);
  assert.equal(check.mock.calls.length, 1);
  const command = check.mock.calls[0].arguments[1][3];
  assert.match(command, /FromBase64String\('W10='\)/);
  assert.match(command, /elseif\(\[long\]\$created -lt \[long\]\$appProof\.writeTime\)\{return \$null\}/);
  assert.match(command, /Manager process inventory changed/);
  assert.equal(spawn.mock.calls.length, 0);
});

test('empty-pin CLI rejects GUI, unknown new managers, extra arguments and incomplete host proof', async context => {
  const mutations = [
    record => { delete record.role; delete record.transportProof; },
    record => { record.ownership = 'unknown'; },
    record => { record.transportProof.exactMcpArgv = false; },
    record => { record.transportProof.hostSameUser = false; },
    record => { record.transportProof.hostExecutable = 'D:\\untrusted\\codex.exe'; },
    record => { delete record.transportProof.hostCreatedFileTime; },
    record => { record.transportProof.parentPid++; },
    record => { record.transportProof.identityRechecked = false; },
    record => { record.transportProof.createdFileTime = '134388500647784010'; },
    record => { record.transportProof.roleEvidence = 'pinned-existing-stdio'; },
  ];
  for (const mutate of mutations) {
    const record = transport(); mutate(record);
    const check = processCheck(context, { checked: true, managers: [record] });
    await assert.rejects(runManagerPreflightCli(guardCliArguments([])), /existing manager process/);
    check.mock.restore();
  }
  const check = processCheck(context, { checked: true, managers: [transport(), { name: 'agent-resource-manager.exe', pid: 202, ownership: 'sameUser' }] });
  await assert.rejects(runManagerPreflightCli(guardCliArguments([])), /PID 202/);
  check.mock.restore();
});

test('guard-only CLI rejects unbound, oversized or non-metadata arguments before querying', async context => {
  const check = processCheck(context, { checked: true, managers: [] });
  const pin = pinFor(transport()), valid = guardCliArguments([pin]);
  const cases = [[], [...valid, '--extra'], ['--other', ...valid.slice(1)], [...valid.slice(0, 4), 'not base64'],
    [...valid.slice(0, 4), 'A'.repeat(16388)], guardCliArguments([pin], { candidateSha256: 'a'.repeat(64) }),
    guardCliArguments([pin], { command: 'arbitrary expression' }), guardCliArguments([{ ...pin, rawCommand: 'PRIVATE_COMMAND_MARKER' }])];
  for (const arguments_ of cases) await assert.rejects(runManagerPreflightCli(arguments_));
  assert.equal(check.mock.calls.length, 0);
});

test('guard-only CLI still rejects GUI processes and changes to pinned process identity', async context => {
  const original = transport(); original.transportProof.roleEvidence = 'pinned-existing-stdio';
  const arguments_ = guardCliArguments([pinFor(original)]);
  for (const managers of [
    [original, { name: 'agent-resource-manager.exe', pid: 202, ownership: 'sameUser' }],
    [{ ...original, pid: 202 }],
    [{ ...original, transportProof: { ...original.transportProof, exactMcpArgv: false } }],
  ]) {
    const check = processCheck(context, { checked: true, managers });
    await assert.rejects(runManagerPreflightCli(arguments_), /existing manager process/);
    check.mock.restore();
  }
});

test('PowerShell launch keeps its strict default and uses only the fixed sibling guard with separate metadata arguments', async () => {
  const harness = await readFile(new URL('../scripts/verify-native-uia.ps1', import.meta.url), 'utf8');
  const client = await readFile(new URL('../scripts/native-uia-client.mjs', import.meta.url), 'utf8');
  assert.match(harness, /\$guardScript=Join-Path \$PSScriptRoot 'native-uia-client\.mjs'/);
  assert.match(harness, /& \$GuardNodeExecutable @guardArguments/);
  assert.match(harness, /ReparsePoint/);
  assert.match(harness, /\$guardResult\.Count -ne 1/);
  assert.match(harness, /\$actualHash -ne \$ExpectedSha256\.ToLowerInvariant\(\)/);
  assert.match(harness, /\$guardArguments=@\(\$guardScript,'--manager-preflight','--sha256',\$transportHash/);
  assert.match(harness, /\$transportHash=if\(\$TransportFileSha256\)/);
  assert.match(harness, /elseif \(@\(Get-Process -Name 'agent-resource-manager','skill-manager'/);
  assert.doesNotMatch(harness, /Invoke-Expression|\biex\b/);
  assert.match(client, /arguments_\.push\('-PinnedTransportProofBase64', encoded, '-GuardNodeExecutable', process\.execPath\)/);
  assert.match(client, /'-ExpectedSha256', sha256/);
  assert.match(client, /arguments_\.push\('-TransportFileSha256', transportSha256\.toLowerCase\(\)\)/);
  assert.match(client, /if \(sha256 !== undefined\) \{\s*const transports = \(pinnedTransports \?\? \[\]\)\.map/);
  assert.match(client, /JSON\.stringify\(\{ candidateSha256: transportSha256\.toLowerCase\(\), transports \}\)/);
  assert.doesNotMatch(client.slice(client.indexOf('static async launch('), client.indexOf('const child = childProcess.spawn', client.indexOf('static async launch('))), /if \(pinnedTransports\?\.length\)/);
});

test('PowerShell bound guard rejects absent or redirected Node and mismatched live calling-host identity before executing its fixed CLI', async () => {
  const harness = await readFile(new URL('../scripts/verify-native-uia.ps1', import.meta.url), 'utf8');
  const start = harness.indexOf('if ($PinnedTransportProofBase64 -or $GuardNodeExecutable -or $TransportFileSha256)');
  const execute = harness.indexOf('& $GuardNodeExecutable @guardArguments', start);
  assert.ok(start >= 0 && execute > start);
  const guard = harness.slice(start, execute);
  assert.match(guard, /-not \$PinnedTransportProofBase64 -or -not \$GuardNodeExecutable/);
  assert.match(guard, /\$PinnedTransportProofBase64\.Length -gt 16384/);
  assert.match(guard, /\$guardItem -isnot \[IO\.FileInfo\]/);
  assert.match(guard, /\[IO\.FileAttributes\]::ReparsePoint/);
  assert.match(guard, /GetFileName\(\$GuardNodeExecutable\) -ine 'node\.exe'/);
  assert.match(guard, /\$guardCaller=Get-CimInstance Win32_Process -Filter \('ProcessId='\+\[int\]\$PID\)/);
  assert.match(guard, /\$guardCaller\.ParentProcessId -le 0/);
  assert.match(guard, /\$guardParent=Get-CimInstance Win32_Process -Filter \('ProcessId='\+\[int\]\$guardCaller\.ParentProcessId\)/);
  assert.match(guard, /\$guardParent\.Name -ine 'node\.exe'/);
  assert.match(guard, /\$null -eq \$guardParent\.CreationDate/);
  assert.match(guard, /\$guardParent\.CreationDate -gt \$guardCaller\.CreationDate/);
  assert.match(guard, /\[string\]::Equals\(\[string\]\$guardParent\.ExecutablePath,\[IO\.Path\]::GetFullPath\(\$GuardNodeExecutable\)/);
  assert.match(guard, /\$guardArguments=@\(\$guardScript,'--manager-preflight','--sha256',\$transportHash,'--pinned-transports-base64',\$PinnedTransportProofBase64\)/);
  assert.doesNotMatch(guard, /Invoke-Expression|\biex\b|--eval| -Command/);
});
