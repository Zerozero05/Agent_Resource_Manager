import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const managerRoot = resolve(projectRoot, '..', '..');
const sourceRoot = join(dirname(managerRoot), 'skill_manager');
const outputRoot = join(projectRoot, 'outputs', 'v1-validation');
const syntheticRoot = join(managerRoot, 'validation', 'manager-data');
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
const pathKey = value => resolve(value.replace(/^\\\\\?\\([A-Za-z]:\\)/, '$1')).toLowerCase();

export function isWithin(value, root) {
  const result = relative(pathKey(root), pathKey(value));
  return result === '' || (!isAbsolute(result) && result !== '..' && !result.startsWith(`..${sep}`));
}

export function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!['--mode', '--candidate', '--candidate-build-info', '--output'].includes(name)
      || !args[index + 1] || args[index + 1].startsWith('--') || Object.hasOwn(options, name.slice(2))) {
      throw new Error('Use --mode inventory|plan, --candidate, --candidate-build-info and a new --output JSON path. No apply operation exists.');
    }
    options[name.slice(2)] = args[index + 1];
  }
  options.mode ||= 'plan';
  if (!['inventory', 'plan'].includes(options.mode)) throw new Error('Only read-only inventory and plan modes are supported.');
  if (!options.output || (options.mode === 'plan' && (!options.candidate || !options['candidate-build-info']))) {
    throw new Error('A new --output path is required. Plan mode also requires the candidate and its build evidence.');
  }
  if (!!options.candidate !== !!options['candidate-build-info']) throw new Error('Candidate and build evidence must be supplied together.');
  return options;
}

export function validateManifestEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('The runtime source manifest is empty.');
  const seen = new Set();
  for (const entry of entries) {
    if (typeof entry?.path !== 'string' || isAbsolute(entry.path) || /^[A-Za-z]:/.test(entry.path)
      || entry.path.split(/[\\/]/).some(part => part === '..' || part === '.' || part === '')
      || !/^[0-9a-f]{64}$/.test(entry.sha256 || '')) {
      throw new Error('The runtime source manifest contains an invalid relative path or digest.');
    }
    const key = entry.path.replaceAll('\\', '/').toLowerCase();
    if (seen.has(key)) throw new Error('The runtime source manifest repeats a path.');
    seen.add(key);
  }
}

export function mapSourceEntry(entry, oldRoot, newRoot) {
  if (!isWithin(entry.path, oldRoot) || pathKey(entry.path) === pathKey(oldRoot)) throw new Error('An inventory entry escaped the source root.');
  const local = relative(oldRoot, entry.path);
  const first = local.split(sep)[0], firstKey = first.toLowerCase();
  const runtime = ['skill-manager.exe', 'third_party_notices.txt', 'user_guide.md', 'data-directory.txt'];
  const directories = {
    webview: join(newRoot, 'cache', 'webview'), temp: join(newRoot, 'cache', 'temp'),
    recovery: join(newRoot, 'data', 'recovery'), 'private-recovery': join(newRoot, 'data', 'private-recovery'),
    'upload-receipts': join(newRoot, 'data', 'receipts'), exports: join(newRoot, 'exports'),
    outputs: join(newRoot, 'dev', 'legacy-skill-manager', 'outputs'),
    work: join(newRoot, 'dev', 'legacy-skill-manager', 'work'),
    '.planning': join(newRoot, 'dev', 'legacy-skill-manager', '.planning'),
  };
  if (entry.reparse) return { ...entry, action: 'retain-review-required', destination: entry.path, reason: 'Reparse entry was recorded without following it.' };
  if (runtime.includes(firstKey)) return { ...entry, action: 'retain-in-place', destination: entry.path, reason: 'Preserve the previous runtime and its existing support files at their original location.' };
  if (/^manager\.sqlite3(?:-wal|-shm)?$/i.test(local)) return { ...entry, action: 'move-after-database-close', destination: join(newRoot, 'data', local), reason: 'One canonical database. A later cutover must finish WAL handling and move the whole remaining database family without a backup copy.' };
  if (directories[firstKey]) return { ...entry, action: 'move-after-owner-release', destination: join(directories[firstKey], relative(join(oldRoot, first), entry.path)), reason: 'Preserve all existing content and relative paths. No deletion or deduplication is proposed.' };
  if (local === '启动 Skill Manager.cmd') return { ...entry, action: 'review-launcher-forwarding', destination: entry.path, reason: 'The old launcher currently opens the old executable. Review forwarding to the new formal entry before changing it.' };
  return { ...entry, action: 'retain-review-required', destination: entry.path, reason: 'Unique or unclassified material stays at its source until its purpose and target are reviewed.' };
}

export function classifyManagerProcess(process, oldRoot, newRoot, testRoot) {
  const record = { pid: process.pid, name: process.name, executable: process.executable || null, classification: 'unknown-manager', blocksCutover: true };
  if (!process.executable || !isAbsolute(process.executable)) return record;
  if (isWithin(process.executable, oldRoot) || isWithin(process.executable, join(newRoot, 'app'))) {
    return { ...record, classification: 'formal-program-running' };
  }
  const matches = [...(process.commandLine || '').matchAll(/(?:^|\s)--data-dir\s+(?:"([^"]+)"|([^\s"]+))/g)];
  if (matches.length !== 1) return record;
  const dataRoot = matches[0][1] || matches[0][2];
  if (!isAbsolute(dataRoot)) return record;
  if (isWithin(dataRoot, oldRoot) || isWithin(dataRoot, join(newRoot, 'data'))) {
    return { ...record, classification: 'formal-data-writer', dataRoot };
  }
  if (isWithin(dataRoot, testRoot) && isWithin(process.executable, newRoot)
    && !isWithin(process.executable, join(newRoot, 'app'))) {
    return { ...record, classification: 'isolated-validation-process', dataRoot, blocksCutover: false };
  }
  return { ...record, dataRoot };
}

async function digest(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

async function existing(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function powershell(script) {
  const command = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n$OutputEncoding=[Console]::OutputEncoding\n${script}`;
  return new Promise((done, reject) => execFile('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
    { windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error(`Read-only Windows inventory failed: ${error.message}`));
      else { try { done(JSON.parse(stdout)); } catch { reject(new Error('Windows inventory returned invalid JSON.')); } }
    }));
}

const psLiteral = value => `'${value.replaceAll("'", "''")}'`;
async function windowsInventory(paths) {
  return powershell(`
    $ErrorActionPreference='Stop'
    $ancestors=[Collections.Generic.List[object]]::new()
    foreach($requested in @(${paths.map(psLiteral).join(',')})){
      $path=$requested
      while($path){
        if([IO.File]::Exists($path) -or [IO.Directory]::Exists($path)){
          $attributes=[IO.File]::GetAttributes($path)
          if(($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){$ancestors.Add([pscustomobject]@{requested=$requested;path=$path;reparse=$true})}
        }
        $path=[IO.Path]::GetDirectoryName($path)
      }
    }
    if($ancestors.Count -gt 0){throw 'A source, destination, report or candidate path crosses a reparse point. No source tree was enumerated.'}
    $entries=[Collections.Generic.List[object]]::new()
    $pending=[Collections.Generic.Queue[string]]::new()
    $pending.Enqueue(${psLiteral(sourceRoot)})
    while($pending.Count -gt 0){
      $directory=$pending.Dequeue()
      foreach($path in [IO.Directory]::EnumerateFileSystemEntries($directory)){
        $attributes=[IO.File]::GetAttributes($path)
        $reparse=($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
        $isDirectory=($attributes -band [IO.FileAttributes]::Directory) -ne 0
        $bytes=if($isDirectory -or $reparse){$null}else{([IO.FileInfo]::new($path)).Length}
        $entries.Add([pscustomobject]@{path=$path;kind=$(if($isDirectory){'directory'}else{'file'});bytes=$bytes;reparse=$reparse;attributes=[int]$attributes})
        if($isDirectory -and -not $reparse){$pending.Enqueue($path)}
      }
    }
    $processes=@(Get-CimInstance Win32_Process -Filter "Name='skill-manager.exe' OR Name='agent-resource-manager.exe'" | ForEach-Object {
      [pscustomobject]@{pid=[int]$_.ProcessId;name=$_.Name;executable=$_.ExecutablePath;commandLine=$_.CommandLine}
    })
    [pscustomobject]@{entries=@($entries);reparseAncestors=@($ancestors);processes=$processes}|ConvertTo-Json -Depth 6 -Compress
  `);
}

async function candidateIdentity(candidatePath, infoPath) {
  const executable = resolve(candidatePath), buildInfoPath = resolve(infoPath);
  if (!isWithin(executable, projectRoot) || !isWithin(buildInfoPath, projectRoot)
    || basename(executable).toLowerCase() !== 'agent-resource-manager.exe') throw new Error('Use the project-owned normal candidate and build evidence.');
  const infoBytes = await readFile(buildInfoPath), info = JSON.parse(infoBytes);
  const manifestPath = join(dirname(buildInfoPath), 'candidate-runtime-source-manifest.json');
  const manifestBytes = await readFile(manifestPath), entries = JSON.parse(manifestBytes);
  if (info.buildMode !== 'release' || info.diagnosticOnly === true || !info.sourceIdentity
    || !/^[0-9a-f]{64}$/.test(info.executableSha256 || '')
    || hashBytes(manifestBytes) !== info.runtimeSourceManifestSha256
    || await digest(executable) !== info.executableSha256
    || pathKey(info.executablePath || '') !== pathKey(executable)) throw new Error('Candidate hashes, normal release mode or source identity differ from the build evidence.');
  validateManifestEntries(entries);
  const rawDifferences = [];
  for (const entry of entries) {
    const path = resolve(projectRoot, entry.path);
    if (!isWithin(path, projectRoot) || pathKey(await realpath(path)) !== pathKey(path)) throw new Error('A candidate source input escaped its ordinary project path.');
    const actualSha256 = await digest(path);
    if (actualSha256 !== entry.sha256) rawDifferences.push({ path: entry.path, d0Sha256: entry.sha256, currentSha256: actualSha256 });
  }
  let equivalent = { differences: [], proofs: [] }, equivalenceError = null;
  if (rawDifferences.length) {
    try { equivalent = await verifyD0TestOnlyDifferences({ executableSha256: info.executableSha256, manifestSha256: hashBytes(manifestBytes) }, entries, rawDifferences); }
    catch (error) { equivalenceError = error.message; }
  }
  const mismatches = rawDifferences.filter(item => !equivalent.differences.some(verified => verified.path === item.path)).map(item => item.path);
  return { executable, executableSha256: info.executableSha256, version: info.version, sourceIdentity: info.sourceIdentity,
    buildInfoPath, buildInfoSha256: hashBytes(infoBytes), manifestPath, manifestSha256: hashBytes(manifestBytes),
    sourceEntryCount: entries.length, currentSourcesMatch: mismatches.length === 0, sourceMismatches: mismatches,
    rawSourcesMatch: rawDifferences.length === 0, rawSourceDifferences: rawDifferences,
    productionEquivalent: rawDifferences.length > 0 && mismatches.length === 0,
    testOnlySourceDifferences: equivalent.differences, equivalenceProofs: equivalent.proofs, equivalenceError };
}

export async function verifyD0TestOnlyDifferences(identity, entries, differences, readSource = path => readFile(resolve(projectRoot, path))) {
  if (identity.executableSha256 !== 'd0b6551f5fd11125ec6f548b7239643f9076a6ccec0ccf54f6afca15e8ce87e0'
    || identity.manifestSha256 !== '0a9936d0c021391740efe8bcc676981e516d9a8f7806ffb88ec151430a94ebaa' || entries.length !== 273) throw new Error('Test-only equivalence is restricted to the recorded d0 executable and original 273-entry manifest.');
  const proofFiles = [
    ['automatic-update-real-pipeline-inputs-20261110.json', 'a15d3aa3d71106613dceeb027b1c97bd4faac784438b67e8ccb262fefac42e1c'],
    ['real-runtime-acceptance-20261110.json', 'f7d4bcfa4e590e1201e5c11adc2338d44cfa9148362c776338dcbba754163c97'],
  ];
  const proofs = [], documents = [];
  for (const [name, sha256] of proofFiles) {
    const path = join(outputRoot, name), bytes = await readFile(path);
    if (hashBytes(bytes) !== sha256) throw new Error('The recorded test-only equivalence proof changed.');
    proofs.push({ path, sha256 }); documents.push(JSON.parse(bytes));
  }
  const [inputs, acceptance] = documents, recorded = acceptance.originalRuntimeManifest.rawDifferences;
  if (!differences.length || differences.length > 4 || new Set(differences.map(item => item.path)).size !== differences.length) throw new Error('Test-only differences must be a unique subset of the four recorded inputs.');
  for (const item of differences) {
    const entry = entries.find(value => value.path === item.path), known = recorded.find(value => value.path === item.path);
    if (!entry || !known || item.d0Sha256 !== entry.sha256 || known.d0Sha256 !== entry.sha256 || item.currentSha256 !== known.currentSha256
      || hashBytes(await readSource(item.path)) !== item.currentSha256) throw new Error(`Unrecorded or changed candidate source difference: ${item.path}`);
  }
  async function originalSource(path) {
    const bytes = await readSource(path), entry = entries.find(item => item.path === path);
    if (!entry) throw new Error('A test-only parent input is absent from the original manifest.');
    if (hashBytes(bytes) === entry.sha256) return bytes.toString('utf8');
    const proof = inputs.productionFiles.find(item => pathKey(item.path) === pathKey(resolve(projectRoot, path)));
    if (!proof || proof.sha256 !== hashBytes(bytes) || proof.d0Sha256 !== entry.sha256) throw new Error('A test-only parent changed beyond its exact recorded bytes.');
    let text = bytes.toString('utf8');
    for (const block of proof.addedCfgTestBlocks) {
      const fragment = text.includes(block) ? block : block.replaceAll('\n', '\r\n');
      const parts = text.split(fragment);
      if (parts.length !== 2) throw new Error('A recorded cfg(test) fragment is missing or repeated.');
      text = parts.join('');
    }
    if (proof.additionalCfgTestOnlyChange) {
      const fragment = '    pub(super) struct Fixture {';
      if (text.split(fragment).length !== 2 || !text.includes('#[cfg(test)]\nmod tests {')) throw new Error('The recorded test-fixture visibility change no longer matches its test module.');
      text = text.replace(fragment, '    struct Fixture {');
    }
    if (hashBytes(Buffer.from(text)) !== entry.sha256) throw new Error('Removing only the listed test changes did not restore the complete original source digest.');
    return text;
  }
  for (const item of differences) {
    if (item.path === 'src-tauri/src/resource_automation/engine_tests.rs') {
      if (!(await originalSource('src-tauri/src/resource_automation/engine.rs')).includes('#[cfg(test)]\n#[path = "engine_tests.rs"]\nmod tests;')) throw new Error('The engine tests are no longer wholly excluded from production.');
    } else if (item.path === 'src-tauri/src/resource_update/tests.rs') {
      if (!(await originalSource('src-tauri/src/resource_update.rs')).includes('#[cfg(test)]\nmod tests;')) throw new Error('The update tests are no longer wholly excluded from production.');
    } else await originalSource(item.path);
  }
  return { differences: differences.map(item => ({ ...item, productionEquivalent: true })), proofs };
}

async function databaseInventory() {
  const database = join(sourceRoot, 'manager.sqlite3');
  const family = [];
  for (const name of ['manager.sqlite3', 'manager.sqlite3-wal', 'manager.sqlite3-shm']) {
    const path = join(sourceRoot, name), stat = await existing(path);
    if (stat) family.push({ path, bytes: stat.size, sha256: await digest(path) });
  }
  const db = new DatabaseSync(database, { readOnly: true });
  let summary;
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
    if (tables.some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new Error('Unexpected source database table identifier.');
    const counts = Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT COUNT(*) count FROM "${name}"`).get().count]));
    const row = db.prepare('SELECT schema_version,payload FROM app_state WHERE id=1').get();
    if (!row) throw new Error('The source database has no original app_state row.');
    const state = JSON.parse(row.payload);
    const paths = [...(state.skills || []).map(item => item.localPath), ...(state.localRoots || []).map(item => item.resolvedPath || item.path),
      ...(state.connections || []).flatMap(item => [item.path, item.target])].filter(value => typeof value === 'string' && isAbsolute(value));
    summary = { database, family, quickCheck: db.prepare('PRAGMA quick_check').all().map(value => Object.values(value)[0]), tables, counts,
      schemaVersion: row.schema_version, appStateSha256: hashBytes(row.payload),
      originalCounts: Object.fromEntries(['skills', 'sources', 'connections', 'localRoots', 'ignoredLocalPaths'].map(key => [key, state[key]?.length || 0])),
      registeredPaths: [...new Set(paths)].sort(), registeredPathsWithinOldRoot: paths.filter(path => isWithin(path, sourceRoot)),
      registeredPathsWithinNewRoot: paths.filter(path => isWithin(path, managerRoot)) };
  } finally { db.close(); }
  summary.sourceDatabaseAndWalUnchanged = true;
  for (const item of family.filter(item => !item.path.endsWith('-shm'))) {
    if (await digest(item.path) !== item.sha256) summary.sourceDatabaseAndWalUnchanged = false;
  }
  return summary;
}

async function main() {
  if (process.platform !== 'win32') throw new Error('This one-time formal inventory requires Windows.');
  const options = parseOptions(process.argv.slice(2));
  const output = resolve(options.output);
  if (!isWithin(output, outputRoot) || dirname(output) !== outputRoot || !output.endsWith('.json')) {
    throw new Error('The report must be a new JSON file directly under outputs/v1-validation.');
  }
  if (await existing(output)) throw new Error('The requested report already exists. Choose a new report name.');
  const destinations = ['app', 'data', 'cache', 'exports'].map(name => join(managerRoot, name));
  const candidatePaths = [options.candidate, options['candidate-build-info']].filter(Boolean).map(value => resolve(value));
  const windows = await windowsInventory([sourceRoot, managerRoot, outputRoot, join(managerRoot, 'dev', 'legacy-skill-manager'), ...destinations, ...candidatePaths]);
  if (windows.reparseAncestors.length) throw new Error('A source, target, report or candidate ancestor is a reparse point. No report was written.');
  const processes = windows.processes.map(item => classifyManagerProcess(item, sourceRoot, managerRoot, syntheticRoot));
  const blockers = [];
  if (processes.some(item => item.blocksCutover)) blockers.push('A formal or unclassified manager process is active.');
  const mappings = windows.entries.map(entry => mapSourceEntry(entry, sourceRoot, managerRoot));
  for (const entry of mappings.filter(item => item.action.startsWith('move-'))) {
    entry.targetExists = !!await existing(entry.destination);
    if (entry.targetExists) blockers.push(`Planned move target already exists: ${entry.destination}`);
  }
  if (mappings.some(item => item.reparse)) blockers.push('Source reparse entries need review. Their targets were not followed.');
  const database = await databaseInventory();
  if (database.quickCheck.length !== 1 || database.quickCheck[0] !== 'ok' || !database.sourceDatabaseAndWalUnchanged) {
    blockers.push('The original database failed integrity or read-only stability checks.');
  }
  if (database.registeredPathsWithinOldRoot.length || database.registeredPathsWithinNewRoot.length) {
    blockers.push('Registered resources inside a manager root need an explicit independence decision.');
  }
  const candidate = options.candidate && options['candidate-build-info'] ? await candidateIdentity(options.candidate, options['candidate-build-info']) : null;
  if (options.mode === 'plan' && !candidate?.currentSourcesMatch) blockers.push('Current runtime sources differ from the candidate manifest.');
  const candidateFiles = candidate ? [
    { source: candidate.executable, destination: join(managerRoot, 'app', 'agent-resource-manager.exe'), action: 'deploy-verified-candidate', sha256: candidate.executableSha256 },
    { source: join(projectRoot, 'docs', 'THIRD_PARTY_NOTICES.txt'), destination: join(managerRoot, 'app', 'THIRD_PARTY_NOTICES.txt'), action: 'deploy-current-license-notices' },
    { source: join(projectRoot, 'docs', 'USER_GUIDE.md'), destination: join(managerRoot, 'USER_GUIDE.md'), action: 'deploy-current-guide' },
  ] : [];
  for (const entry of candidateFiles) {
    if (!entry.sha256) entry.sha256 = await digest(entry.source);
    entry.targetExists = !!await existing(entry.destination);
    if (entry.targetExists) blockers.push(`Candidate deployment target already exists: ${entry.destination}`);
  }
  const bootstrap = { formatVersion: 1, config: { managedRoot: managerRoot, overrides: {
    state: join(managerRoot, 'data'), webview: join(managerRoot, 'cache', 'webview'), recovery: join(managerRoot, 'data', 'recovery'),
    receipts: join(managerRoot, 'data', 'receipts'), temp: join(managerRoot, 'cache', 'temp'), newSkill: join(dirname(managerRoot), 'Agent_Skills'),
  } } };
  const report = { format: 'agent-resource-manager-formal-cutover-plan-v1', mode: options.mode, checkedAt: new Date().toISOString(),
    status: blockers.length ? 'review-required-with-blockers' : 'read-only-plan-prepared', applyImplemented: false,
    sourceRoot, managerRoot, reportPath: output, destinations, candidate, processes, database, blockers,
    mappings: mappings.sort((a, b) => a.path.localeCompare(b.path)), candidateFiles,
    proposedNewFiles: [
      { path: join(managerRoot, 'app', 'storage-paths.json'), content: bootstrap, reason: 'Matches Storage Bootstrap formatVersion 1 and fresh_product_layout. Writing this requires a later formal cutover.' },
      { path: join(managerRoot, 'app', 'data-directory.txt'), content: '.\n', reason: 'Matches the packaged UTF-8 one-line application-relative sidecar.' },
      { path: join(managerRoot, '启动 Agent Resource Manager.cmd'), content: '@echo off\r\nstart "" "%~dp0app\\agent-resource-manager.exe"\r\n', reason: 'Direct formal program entry.' },
    ],
    reviewItems: [
      'No apply operation is implemented. Revalidate processes, hashes, target absence, path ownership and WAL close before any future move.',
      'The old launcher and previous runtime data pointer need a concrete forwarding/compatibility decision. Retaining the old executable does not prove database downgrade recovery.',
      'Agent_Skills is the product fresh-layout suggestion only. This plan does not create it or change the destination chosen for any resource installation.',
      'All retain-review-required entries remain at source. Existing unique history and recovery files require explicit mapping before the old root can be retired.',
      'GitHub rename, registry and shell shortcuts are outside this file inventory. The existing old installation registration needs its own exact ownership check.',
      'Formal runtime acceptance and final delivery review remain separate from this read-only inventory.',
    ],
    effects: { managerLaunched: false, formalFilesMoved: false, databaseCheckpointed: false, backupCreated: false, filesDeleted: false, registryChanged: false },
  };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, reportPath: output, mappingCount: mappings.length, blockers: blockers.length,
    formalWriters: processes.filter(item => item.blocksCutover).length, isolatedValidationProcesses: processes.filter(item => !item.blocksCutover).length,
    sourceDatabaseAndWalUnchanged: database.sourceDatabaseAndWalUnchanged, candidateSourcesMatch: candidate?.currentSourcesMatch ?? null }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
