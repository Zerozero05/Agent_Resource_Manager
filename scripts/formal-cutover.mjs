import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { isWithin, powershell } from './prepare-formal-cutover.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const managerRoot = resolve(projectRoot, '..', '..');
const validationRoot = join(managerRoot, 'validation');
const reportRoot = join(projectRoot, 'outputs', 'v1-validation');
const oldRoot = join(dirname(managerRoot), 'skill_manager');
const digestBytes = bytes => createHash('sha256').update(bytes).digest('hex');
const key = value => resolve(value).toLowerCase();
const literal = value => `'${value.replaceAll("'", "''")}'`;
const absent = async path => { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

async function digest(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

async function ordinaryAncestors(path) {
  let current = resolve(path);
  while (current) {
    const stat = await absent(current);
    if (stat && (stat.isSymbolicLink() || key(await realpath(current)) !== key(current))) throw new Error(`Reparse path refused: ${current}`);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function bindTree(path) {
  await ordinaryAncestors(path);
  const files = [], directories = [];
  async function visit(current, local) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`Reparse entry refused: ${current}`);
    if (stat.isDirectory()) {
      directories.push(local);
      for (const child of (await readdir(current)).sort()) await visit(join(current, child), local ? join(local, child) : child);
    } else if (stat.isFile() && stat.nlink === 1) files.push({ path: local, bytes: stat.size, sha256: await digest(current) });
    else throw new Error(`Only ordinary unshared files and directories can move: ${current}`);
  }
  await visit(path, '');
  return { kind: (await lstat(path)).isDirectory() ? 'directory' : 'file', directories, files };
}

function sameTree(actual, expected) { return JSON.stringify(actual) === JSON.stringify(expected); }
const databaseFamily = (manifest, path) => [manifest.database.source, `${manifest.database.source}-wal`, `${manifest.database.source}-shm`].some(item => key(item) === key(path));

function logicalDatabase(db) {
  const hash = createHash('sha256');
  const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
  for (const table of tables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table.name)) throw new Error('Unexpected database table identifier.');
    const statement = db.prepare(`SELECT * FROM "${table.name}"`);
    statement.setReadBigInts(true);
    const rows = statement.all().map(row => JSON.stringify(row, (_, value) => typeof value === 'bigint' ? { integer: value.toString() } : value)).sort();
    hash.update(JSON.stringify([table.name, table.sql, rows]));
  }
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
  hash.update(JSON.stringify(schema));
  hash.update(JSON.stringify(db.prepare('PRAGMA user_version').get()));
  return hash.digest('hex');
}

function databaseIdentity(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const check = db.prepare('PRAGMA quick_check').all().map(row => Object.values(row)[0]);
    if (check.length !== 1 || check[0] !== 'ok') throw new Error('Database integrity check failed.');
    return logicalDatabase(db);
  } finally { db.close(); }
}

function checkScope(report) {
  const formal = key(report.sourceRoot) === key(oldRoot) && key(report.managerRoot) === key(managerRoot);
  const synthetic = isWithin(report.sourceRoot, validationRoot) && isWithin(report.managerRoot, validationRoot);
  if ((!formal && !synthetic) || isWithin(report.sourceRoot, report.managerRoot) || isWithin(report.managerRoot, report.sourceRoot)) throw new Error('Cutover roots must be the fixed formal pair or separate validation roots.');
  return formal;
}

function normalizeMoves(mappings, source, target) {
  const moves = mappings.filter(item => item.action.startsWith('move-')).map(item => ({ source: resolve(item.path), destination: resolve(item.destination) }));
  moves.sort((a, b) => a.source.length - b.source.length || a.source.localeCompare(b.source));
  const roots = [];
  for (const move of moves) {
    if (!isWithin(move.source, source) || key(move.source) === key(source) || !isWithin(move.destination, target) || key(move.destination) === key(target)) throw new Error('Move escaped its approved roots.');
    if (resolve(move.source).slice(0, 3).toLowerCase() !== resolve(move.destination).slice(0, 3).toLowerCase()) throw new Error('Move-only cutover requires the same drive.');
    const parent = roots.find(item => isWithin(move.source, item.source));
    if (parent) {
      if (key(join(parent.destination, relative(parent.source, move.source))) !== key(move.destination)) throw new Error('Nested move mapping has a conflicting destination.');
      continue;
    }
    if (roots.some(item => isWithin(move.destination, item.destination) || isWithin(item.destination, move.destination))) throw new Error('Move destinations overlap.');
    roots.push(move);
  }
  return roots;
}

export async function prepareCutover(reportPath, outputPath) {
  if (process.platform !== 'win32') throw new Error('Formal cutover requires Windows.');
  const bytes = await readFile(reportPath), report = JSON.parse(bytes);
  if (report.format !== 'agent-resource-manager-formal-cutover-plan-v1' || report.applyImplemented !== false || report.blockers?.length || !report.candidate?.currentSourcesMatch) throw new Error('Use a reviewed, unblocked inventory with verified candidate sources.');
  const formal = checkScope(report);
  const output = resolve(outputPath);
  if (!isWithin(output, formal ? reportRoot : validationRoot)) throw new Error('Execution manifest must remain in the approved report tree.');
  await ordinaryAncestors(output);
  const moves = normalizeMoves(report.mappings, report.sourceRoot, report.managerRoot);
  for (const move of moves) {
    await ordinaryAncestors(move.destination);
    if (await absent(move.destination)) throw new Error(`Move destination already exists: ${move.destination}`);
    move.tree = await bindTree(move.source);
  }
  const database = join(report.sourceRoot, 'manager.sqlite3');
  if (!moves.some(move => key(move.source) === key(database))) throw new Error('The canonical database move is required.');
  const deploy = [];
  for (const item of report.candidateFiles) {
    if (!isWithin(item.source, formal ? projectRoot : validationRoot) || !isWithin(item.destination, report.managerRoot)) throw new Error('Candidate deployment escaped its approved roots.');
    await ordinaryAncestors(item.destination);
    if (await absent(item.destination)) throw new Error(`Deployment destination already exists: ${item.destination}`);
    const tree = await bindTree(item.source);
    if (tree.kind !== 'file' || tree.files[0].sha256 !== item.sha256) throw new Error('Candidate deployment differs from its reviewed digest.');
    deploy.push({ source: resolve(item.source), destination: resolve(item.destination), tree });
  }
  const generated = report.proposedNewFiles.map(item => {
    if (!isWithin(item.path, report.managerRoot)) throw new Error('Generated entry escaped the new manager root.');
    const content = typeof item.content === 'string' ? item.content : `${JSON.stringify(item.content, null, 2)}\n`;
    return { path: resolve(item.path), content, sha256: digestBytes(Buffer.from(content)) };
  });
  const targets = [...moves.map(item => item.destination), ...deploy.map(item => item.destination), ...generated.map(item => item.path)];
  if (new Set(targets.map(key)).size !== targets.length || targets.some((path, i) => targets.some((other, j) => i !== j && isWithin(path, other)))) throw new Error('Cutover output paths overlap.');
  for (const path of targets) {
    await ordinaryAncestors(path);
    if (await absent(path)) throw new Error(`Cutover output already exists: ${path}`);
  }
  const manifest = { format: 'agent-resource-manager-bound-cutover-v1', preparedAt: new Date().toISOString(), formal,
    sourceReport: resolve(reportPath), sourceReportSha256: digestBytes(bytes), sourceRoot: resolve(report.sourceRoot), managerRoot: resolve(report.managerRoot),
    formalApplyBlocked: formal && report.mappings.some(item => item.action === 'review-launcher-forwarding'),
    ...(formal ? { formalReadiness: { format: 'agent-resource-manager-formal-readiness-v1', status: 'pending', sourceReportSha256: digestBytes(bytes), legacyLauncher: 'pending', legacyDataPointer: 'pending' } } : {}),
    pendingFinalization: formal ? ['legacy-launcher-and-data-pointer', 'installation-registration', 'repository-rename-and-links', 'formal-runtime-acceptance'] : [],
    database: { source: database, logicalSha256: databaseIdentity(database) }, moves, deploy, generated };
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return { path: output, sha256: await digest(output), moveRoots: moves.length, formalApplyBlocked: manifest.formalApplyBlocked };
}

async function saveJournal(path, journal) {
  const pending = `${path}.pending`;
  if (await absent(pending)) throw new Error('An interrupted journal replacement needs inspection before resuming.');
  await writeFile(pending, `${JSON.stringify(journal, null, 2)}\n`, { flag: 'wx' });
  await rename(pending, path);
}

async function noWriters(manifest) {
  const result = await powershell(`$ErrorActionPreference='Stop'; $blocked=@(Get-CimInstance Win32_Process -Filter "Name='skill-manager.exe' OR Name='agent-resource-manager.exe'" | Where-Object {
    $exe=$_.ExecutablePath; $line=$_.CommandLine; $scope=@(${[manifest.sourceRoot, manifest.managerRoot].map(literal).join(',')});
    $touches=$false;foreach($root in $scope){if(($exe -and $exe.StartsWith($root+'\\',[StringComparison]::OrdinalIgnoreCase)) -or ($line -and $line.IndexOf($root,[StringComparison]::OrdinalIgnoreCase)-ge 0)){$touches=$true}}
    $touches -or -not $exe -or -not $line
  } | ForEach-Object {[pscustomobject]@{pid=$_.ProcessId;name=$_.Name}}); [pscustomobject]@{blocked=$blocked}|ConvertTo-Json -Compress`);
  if (result.blocked.length) throw new Error('A manager process may still own a cutover root. Close it before applying.');
}

async function executionLease(identity) {
  const command = `$ErrorActionPreference='Stop';$mutex=[Threading.Mutex]::new($false,${literal(`Local\\ARM-Cutover-${identity}`)});$held=$false;try{try{$held=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$held=$true};if(-not $held){throw 'Another cutover execution owns this manifest.'};[Console]::WriteLine('ready');[Console]::Out.Flush();[Console]::In.ReadLine()|Out-Null}finally{if($held){$mutex.ReleaseMutex()};$mutex.Dispose()}`;
  const child = spawn('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  const closed = new Promise(done => child.once('close', code => done(code)));
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes.toString('utf8'); });
  await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Cutover lease unavailable (${code}): ${stderr.trim()}`)));
    lines.once('line', line => line === 'ready' ? done() : reject(new Error('Unexpected cutover lease response.')));
  });
  return async () => { child.stdin.end('\n'); lines.close(); if (await closed !== 0) throw new Error('Cutover lease did not close normally.'); };
}

async function moveWithExclusiveFiles(move) {
  const paths = move.tree.files.map(item => ({ path: item.path ? join(move.source, item.path) : move.source, sha256: item.sha256 }));
  const command = `[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$ErrorActionPreference='Stop';$request=ConvertFrom-Json ([Console]::In.ReadToEnd());$handles=[Collections.Generic.List[IO.FileStream]]::new();try{
    foreach($path in @($request.source,$request.destination)){$current=$path;while($current){if([IO.File]::Exists($current)-or[IO.Directory]::Exists($current)){if(([IO.File]::GetAttributes($current)-band[IO.FileAttributes]::ReparsePoint)-ne 0){throw 'Native move crosses a reparse entry.'}};$current=[IO.Path]::GetDirectoryName($current)}}
    foreach($file in $request.files){
      $stream=[IO.File]::Open($file.path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Delete);$handles.Add($stream);
      $hash=[Security.Cryptography.SHA256]::Create();try{$actual=[Convert]::ToHexString($hash.ComputeHash($stream)).ToLowerInvariant()}finally{$hash.Dispose()};
      if($actual -ne $file.sha256){throw 'Source changed before its exclusive move.'}
    }
    if([IO.File]::Exists($request.destination) -or [IO.Directory]::Exists($request.destination)){throw 'Move destination appeared.'}
    if($request.kind -eq 'directory'){
      # Windows refuses directory rename while descendant handles are open.
      # Release our occupancy probes, rename once, then the caller verifies
      # the complete destination tree before recording this step.
      foreach($stream in $handles){$stream.Dispose()};$handles.Clear();[IO.Directory]::Move($request.source,$request.destination)
    }else{[IO.File]::Move($request.source,$request.destination)}
    [pscustomobject]@{moved=$true}|ConvertTo-Json -Compress
  }finally{foreach($stream in $handles){$stream.Dispose()}}`;
  const result = await new Promise((done, reject) => {
    const child = execFile('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error(`Native move failed: ${error.message}`));
      else { try { done(JSON.parse(stdout)); } catch { reject(new Error('Native move returned invalid JSON.')); } }
    });
    child.stdin.end(JSON.stringify({ source: move.source, destination: move.destination, kind: move.tree.kind, files: paths }));
  });
  if (result.moved !== true) throw new Error('Native move did not report completion.');
}

async function checkpointDatabase(manifest, journal, journalPath) {
  const stat = await absent(manifest.database.source);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Canonical database is missing or no longer an ordinary unshared file.');
  await ordinaryAncestors(manifest.database.source);
  if (databaseIdentity(manifest.database.source) !== manifest.database.logicalSha256) throw new Error('Canonical database content changed before checkpoint.');
  journal.databasePhase = 'checkpointing';
  await saveJournal(journalPath, journal);
  const db = new DatabaseSync(`${pathToFileURL(manifest.database.source).href}?mode=rw`);
  try {
    db.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE');
    if (logicalDatabase(db) !== manifest.database.logicalSha256) throw new Error('Canonical database content changed before checkpoint.');
    db.exec('COMMIT');
    const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (result.busy !== 0) throw new Error('The database WAL still has an active owner.');
  } finally { db.close(); }
  if (databaseIdentity(manifest.database.source) !== manifest.database.logicalSha256) throw new Error('Database logical content changed during checkpoint.');
  journal.databaseMoves = [];
  for (const move of manifest.moves.filter(item => databaseFamily(manifest, item.source))) {
    journal.databaseMoves.push({ ...move, tree: await absent(move.source) ? await bindTree(move.source) : null });
  }
  journal.databasePhase = 'checkpointed';
  await saveJournal(journalPath, journal);
}

function validateTree(tree) {
  if (!tree || !['file', 'directory'].includes(tree.kind) || !Array.isArray(tree.directories) || !Array.isArray(tree.files)) throw new Error('Invalid bound file tree.');
  const ordinary = value => typeof value === 'string' && !isAbsolute(value) && !/^[A-Za-z]:/.test(value) && (value === '' || !value.split(/[\\/]/).some(part => !part || part === '.' || part === '..'));
  const paths = [...tree.directories, ...tree.files.map(item => item.path)];
  if (paths.some(path => !ordinary(path)) || new Set(paths.map(value => value.toLowerCase())).size !== paths.length
    || tree.files.some(item => !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256 || ''))
    || (tree.kind === 'file' && (tree.directories.length || tree.files.length !== 1 || tree.files[0].path !== ''))
    || (tree.kind === 'directory' && tree.directories[0] !== '')) throw new Error('Bound tree contains invalid or overlapping entries.');
}

function publications(manifest) {
  return [...manifest.deploy.map(entry => ({ kind: 'deploy', source: entry.source, path: entry.destination, sha256: entry.tree.files[0].sha256, bytes: entry.tree.files[0].bytes })),
    ...manifest.generated.map(entry => ({ kind: 'generated', path: entry.path, sha256: entry.sha256, bytes: Buffer.byteLength(entry.content) }))]
    .map(entry => ({ ...entry, staging: `${entry.path}.cutover-${entry.sha256.slice(0, 16)}.pending` }));
}

function validateBoundManifest(manifest, manifestPath, journalPath) {
  if (!manifest.database || key(manifest.database.source || '') !== key(join(manifest.sourceRoot, 'manager.sqlite3'))
    || !/^[a-f0-9]{64}$/.test(manifest.database.logicalSha256 || '')) throw new Error('Execution database must be the canonical sourceRoot/manager.sqlite3.');
  if (![manifest.moves, manifest.deploy, manifest.generated].every(Array.isArray)) throw new Error('Execution manifest arrays are missing.');
  const normalized = normalizeMoves(manifest.moves.map(item => ({ path: item.source, destination: item.destination, action: 'move-bound' })), manifest.sourceRoot, manifest.managerRoot);
  if (normalized.length !== manifest.moves.length) throw new Error('Execution manifest must contain non-overlapping move roots.');
  const databaseMoves = manifest.moves.filter(item => key(item.source) === key(manifest.database.source));
  if (databaseMoves.length !== 1 || key(databaseMoves[0].destination) !== key(join(manifest.managerRoot, 'data', 'manager.sqlite3'))) throw new Error('The canonical database needs exactly one canonical data destination.');
  for (const entry of manifest.moves) {
    validateTree(entry.tree);
    if (databaseFamily(manifest, entry.source) && (entry.tree.kind !== 'file' || key(entry.destination) !== key(join(manifest.managerRoot, 'data', relative(manifest.sourceRoot, entry.source))))) throw new Error('WAL-family mapping escaped the canonical database destination.');
  }
  for (const entry of manifest.deploy) {
    validateTree(entry.tree);
    const candidateRoot = manifest.formal ? projectRoot : validationRoot;
    if (entry.tree.kind !== 'file' || !isWithin(entry.source, candidateRoot) || isWithin(entry.source, manifest.sourceRoot)) throw new Error('Candidate source escaped its independent deployment scope.');
  }
  if (manifest.generated.some(entry => typeof entry.content !== 'string' || digestBytes(Buffer.from(entry.content)) !== entry.sha256)) throw new Error('Generated content differs from its bound digest.');
  const writes = publications(manifest);
  const targets = [...manifest.moves.map(entry => entry.destination), ...writes.flatMap(entry => [entry.path, entry.staging])];
  const protectedFiles = [manifestPath, journalPath, `${journalPath}.pending`, manifest.sourceReport];
  if (targets.some(path => !isWithin(path, manifest.managerRoot) || key(path) === key(manifest.managerRoot)
    || protectedFiles.some(protectedPath => isWithin(path, protectedPath) || isWithin(protectedPath, path)))
    || targets.some((path, index) => targets.some((other, otherIndex) => index !== otherIndex && isWithin(path, other)))
    || manifest.deploy.some(entry => targets.some(path => isWithin(entry.source, path) || isWithin(path, entry.source)))) throw new Error('Cutover outputs overlap or escaped their approved roots.');
  return writes;
}

function validateJournal(journal, manifest, expectedSha256, writes) {
  if (journal.format !== 'agent-resource-manager-cutover-journal-v1' || journal.manifestSha256 !== expectedSha256
    || !['pending', 'checkpointing', 'checkpointed'].includes(journal.databasePhase) || !Array.isArray(journal.completed)
    || journal.completed.some(source => !manifest.moves.some(move => key(move.source) === key(source)))
    || (journal.movingSource && !manifest.moves.some(move => key(move.source) === key(journal.movingSource)))) throw new Error('Execution journal structure or identity differs.');
  if (!Array.isArray(journal.publications) || journal.publications.length !== writes.length) throw new Error('Execution journal publication bindings differ.');
  for (let index = 0; index < writes.length; index++) {
    const { status, ...binding } = journal.publications[index];
    if (!['planned', 'publishing', 'published'].includes(status) || JSON.stringify(binding) !== JSON.stringify(writes[index])) throw new Error('Execution journal publication escaped its bound entry.');
  }
  const databaseMoves = journal.databaseMoves || [];
  if (!Array.isArray(databaseMoves) || new Set(databaseMoves.map(item => key(item.source))).size !== databaseMoves.length) throw new Error('Database execution record repeats a file.');
  for (const entry of databaseMoves) {
    const original = manifest.moves.find(move => key(move.source) === key(entry.source));
    if (!databaseFamily(manifest, entry.source) || !original || key(original.destination) !== key(entry.destination)) throw new Error('Database execution record escaped the canonical WAL family.');
    if (entry.tree !== null) { validateTree(entry.tree); if (entry.tree.kind !== 'file') throw new Error('Database execution record must describe an ordinary file.'); }
    if (key(entry.source) === key(manifest.database.source) && entry.tree === null) throw new Error('Canonical database cannot disappear during checkpoint.');
  }
  if ((journal.databasePhase === 'checkpointed' && databaseMoves.length !== manifest.moves.filter(move => databaseFamily(manifest, move.source)).length)
    || (journal.databasePhase !== 'checkpointed' && databaseMoves.length)) throw new Error('Database checkpoint record is incomplete or out of order.');
}

async function publicationBytes(manifest, publication) {
  const bytes = publication.kind === 'deploy' ? await readFile(publication.source) : Buffer.from(manifest.generated.find(entry => key(entry.path) === key(publication.path)).content);
  if (bytes.length !== publication.bytes || digestBytes(bytes) !== publication.sha256) throw new Error('Candidate deployment source changed.');
  return bytes;
}

async function preflight(manifest, journal, writes) {
  for (const entry of manifest.deploy) {
    if (!sameTree(await bindTree(entry.source), entry.tree)) throw new Error('Candidate deployment source changed.');
  }
  for (let index = 0; index < writes.length; index++) {
    const entry = writes[index], state = journal?.publications[index]?.status;
    await ordinaryAncestors(entry.path); await ordinaryAncestors(entry.staging);
    const destination = await absent(entry.path), staging = await absent(entry.staging);
    if (destination) {
      if (!['publishing', 'published'].includes(state) || staging || !sameTree(await bindTree(entry.path), { kind: 'file', directories: [], files: [{ path: '', bytes: entry.bytes, sha256: entry.sha256 }] })) throw new Error('Publication destination already exists or differs from its execution record.');
    } else if (state === 'published') throw new Error('An already published file is missing.');
    if (staging) {
      if (!journal || !staging.isFile() || staging.isSymbolicLink() || staging.nlink !== 1) throw new Error('Publication staging path is not owned by this execution.');
      const expected = await publicationBytes(manifest, entry), actual = await readFile(entry.staging);
      if (actual.length > expected.length || !actual.equals(expected.subarray(0, actual.length))) throw new Error('Publication staging content differs from its bound source.');
    }
  }
  const moves = manifest.moves.map(move => journal?.databaseMoves?.find(entry => key(entry.source) === key(move.source)) || move);
  for (const move of moves) {
    await ordinaryAncestors(move.source); await ordinaryAncestors(move.destination);
    const source = await absent(move.source), destination = await absent(move.destination);
    if (databaseFamily(manifest, move.source) && journal?.databasePhase !== 'checkpointed') {
      if (destination) throw new Error('Bound move destination already exists.');
      if (manifest.formal && (!journal || journal.databasePhase === 'pending') && (!source || !sameTree(await bindTree(move.source), move.tree))) throw new Error('Bound database physical content changed before its recorded checkpoint.');
    } else if (move.tree === null) {
      if (source || destination) throw new Error('A WAL-family file reappeared after database close.');
    } else if (!source && destination) {
      if (!journal || (!journal.completed.includes(move.source) && journal.movingSource !== move.source) || !sameTree(await bindTree(move.destination), move.tree)) throw new Error('Moved destination differs from its execution record.');
    } else if (!source || destination || !sameTree(await bindTree(move.source), move.tree)) throw new Error('Bound move source changed or destination already exists.');
  }
  if (journal?.databasePhase !== 'checkpointed' && databaseIdentity(manifest.database.source) !== manifest.database.logicalSha256) throw new Error('Bound database logical content changed.');
  return moves;
}

async function publishFiles(manifest, journal, journalFile, hooks) {
  for (const entry of journal.publications) {
    await ordinaryAncestors(entry.path); await ordinaryAncestors(entry.staging);
    if (await absent(entry.path)) {
      const expected = { kind: 'file', directories: [], files: [{ path: '', bytes: entry.bytes, sha256: entry.sha256 }] };
      if (!['publishing', 'published'].includes(entry.status) || await absent(entry.staging) || !sameTree(await bindTree(entry.path), expected)) throw new Error('Publication destination appeared or changed before its operation.');
      entry.status = 'published'; await saveJournal(journalFile, journal); continue;
    }
    const bytes = await publicationBytes(manifest, entry);
    await mkdir(dirname(entry.path), { recursive: true });
    const stagingExists = await absent(entry.staging);
    const handle = await open(entry.staging, stagingExists ? 'r+' : 'wx');
    try {
      if (hooks.afterStagingCreated && !stagingExists) await hooks.afterStagingCreated({ ...entry, bytes });
      const prior = await readFile(entry.staging);
      if (prior.length > bytes.length || !prior.equals(bytes.subarray(0, prior.length))) throw new Error('Publication staging changed before writing.');
      let offset = prior.length;
      while (offset < bytes.length) {
        const result = await handle.write(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesWritten) throw new Error('Publication staging made no write progress.');
        offset += result.bytesWritten;
      }
      await handle.sync();
    } finally { await handle.close(); }
    if (await digest(entry.staging) !== entry.sha256) throw new Error('Publication staging checksum differs.');
    if (hooks.afterStagingWrite) await hooks.afterStagingWrite(entry);
    entry.status = 'publishing'; await saveJournal(journalFile, journal);
    await moveWithExclusiveFiles({ source: entry.staging, destination: entry.path, tree: { kind: 'file', directories: [], files: [{ path: '', bytes: entry.bytes, sha256: entry.sha256 }] } });
    if (await digest(entry.path) !== entry.sha256) throw new Error('Published file checksum differs.');
    if (hooks.afterPublication) await hooks.afterPublication(entry);
    entry.status = 'published'; await saveJournal(journalFile, journal);
  }
}

export function validateCutoverMode(manifest, mode) {
  const formal = checkScope(manifest);
  if (mode === 'rehearse') {
    if (formal || manifest.formal !== false || manifest.formalApplyBlocked) throw new Error('Formal application awaits an explicit apply mode and resolved readiness. Rehearsal accepts only isolated roots.');
    return false;
  }
  if (mode !== 'apply') throw new Error('Choose explicit apply or isolated rehearse mode.');
  if (!formal || manifest.formal !== true) throw new Error('Apply accepts only the fixed formal source and target roots marked formal.');
  if (manifest.formalApplyBlocked !== false) throw new Error('Formal application remains blocked by its reviewed manifest.');
  const ready = manifest.formalReadiness;
  if (ready?.format !== 'agent-resource-manager-formal-readiness-v1' || ready.status !== 'ready'
    || !/^[a-f0-9]{64}$/.test(manifest.sourceReportSha256 || '') || ready.sourceReportSha256 !== manifest.sourceReportSha256
    || ready.legacyLauncher !== 'resolved' || ready.legacyDataPointer !== 'resolved'
    || !Array.isArray(manifest.pendingFinalization) || manifest.pendingFinalization.includes('legacy-launcher-and-data-pointer')) {
    throw new Error('Formal readiness must resolve and bind the legacy launcher and data-pointer decisions to this reviewed source report.');
  }
  return true;
}

export async function applyCutover(manifestPath, expectedSha256, journalPath, hooks = {}, mode = 'rehearse') {
  const bytes = await readFile(manifestPath);
  if (digestBytes(bytes) !== expectedSha256) throw new Error('The exact execution manifest digest is required.');
  const manifest = JSON.parse(bytes);
  if (manifest.format !== 'agent-resource-manager-bound-cutover-v1') throw new Error('Unsupported execution manifest.');
  const formal = validateCutoverMode(manifest, mode);
  if (formal) {
    if (!isWithin(resolve(manifestPath), reportRoot) || !isWithin(manifest.sourceReport, reportRoot)) throw new Error('Formal manifest and reviewed source report must remain in the approved report tree.');
    await ordinaryAncestors(manifest.sourceReport);
    if (await digest(manifest.sourceReport) !== manifest.sourceReportSha256) throw new Error('The reviewed formal source report changed after readiness binding.');
  }
  const journalFile = resolve(journalPath);
  if (!isWithin(journalFile, formal ? reportRoot : validationRoot) || isWithin(journalFile, manifest.sourceRoot) || (!formal && isWithin(journalFile, manifest.managerRoot))) throw new Error('Execution journal must stay in its approved report tree outside the moved data.');
  const writes = validateBoundManifest(manifest, resolve(manifestPath), journalFile);
  await ordinaryAncestors(journalFile);
  const release = await executionLease(digestBytes(Buffer.from(`${key(manifest.sourceRoot)}\n${key(manifest.managerRoot)}`)));
  try { return await applyBoundCutover(manifest, expectedSha256, journalFile, hooks, writes); }
  finally { await release(); }
}

async function applyBoundCutover(manifest, expectedSha256, journalFile, hooks, writes) {
  await noWriters(manifest);
  const pending = `${journalFile}.pending`;
  if (await absent(pending)) {
    const next = JSON.parse(await readFile(pending));
    validateJournal(next, manifest, expectedSha256, writes);
    await rename(pending, journalFile);
  }
  let journal;
  if (await absent(journalFile)) {
    journal = JSON.parse(await readFile(journalFile));
    validateJournal(journal, manifest, expectedSha256, writes);
  } else {
    await preflight(manifest, null, writes);
    journal = { format: 'agent-resource-manager-cutover-journal-v1', manifestSha256: expectedSha256, startedAt: new Date().toISOString(), status: 'applying', databasePhase: 'pending', completed: [], publications: writes.map(entry => ({ ...entry, status: 'planned' })) };
    await writeFile(journalFile, `${JSON.stringify(journal, null, 2)}\n`, { flag: 'wx' });
  }
  await preflight(manifest, journal, writes);
  await publishFiles(manifest, journal, journalFile, hooks);
  await preflight(manifest, journal, writes);
  if (['pending', 'checkpointing'].includes(journal.databasePhase)) await checkpointDatabase(manifest, journal, journalFile);
  validateJournal(journal, manifest, expectedSha256, writes);
  const moves = manifest.moves.map(move => journal.databaseMoves.find(item => key(item.source) === key(move.source)) || move);
  for (const move of moves) {
    await noWriters(manifest);
    await ordinaryAncestors(move.source); await ordinaryAncestors(move.destination);
    const source = await absent(move.source), destination = await absent(move.destination);
    if (move.tree === null) {
      if (source || destination) throw new Error('A WAL-family file reappeared after database close.');
    } else if (!source && destination) {
      if (!sameTree(await bindTree(move.destination), move.tree)) throw new Error('Moved destination differs from the execution record.');
    } else {
      if (!source || destination || !sameTree(await bindTree(move.source), move.tree)) throw new Error('Move state differs from its bound source/destination.');
      await mkdir(dirname(move.destination), { recursive: true });
      journal.movingSource = move.source; await saveJournal(journalFile, journal);
      await moveWithExclusiveFiles(move);
      if (!sameTree(await bindTree(move.destination), move.tree)) throw new Error('Moved content differs from the bound source.');
      if (hooks.afterMove) await hooks.afterMove(move);
    }
    if (!journal.completed.includes(move.source)) journal.completed.push(move.source);
    journal.movingSource = null;
    await saveJournal(journalFile, journal);
  }
  const databaseMove = moves.find(move => key(move.source) === key(manifest.database.source));
  if (databaseIdentity(databaseMove.destination) !== manifest.database.logicalSha256) throw new Error('Moved canonical database differs from its original logical content.');
  await preflight(manifest, journal, writes);
  journal.status = 'completed'; journal.completedAt = new Date().toISOString();
  await saveJournal(journalFile, journal);
  return { status: journal.status, journalPath: journalFile, moveRoots: moves.length, pendingFinalization: manifest.pendingFinalization };
}

export function parseCutoverOptions(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!['--mode', '--report', '--output', '--manifest', '--sha256', '--journal'].includes(name) || !args[index + 1] || args[index + 1].startsWith('--') || Object.hasOwn(values, name)) throw new Error('Use prepare --report/--output, or apply|rehearse --manifest/--sha256/--journal.');
    values[name] = args[index + 1];
  }
  const fields = values['--mode'] === 'prepare' ? ['--mode', '--report', '--output']
    : ['apply', 'rehearse'].includes(values['--mode']) ? ['--mode', '--manifest', '--sha256', '--journal'] : [];
  if (!fields.length || fields.some(name => !values[name]) || Object.keys(values).some(name => !fields.includes(name))) throw new Error('Supply exactly the arguments for prepare, explicit apply or isolated rehearse mode.');
  if (values['--mode'] !== 'prepare' && !/^[a-f0-9]{64}$/.test(values['--sha256'])) throw new Error('An exact lowercase SHA256 execution-manifest binding is required.');
  return values;
}

async function main(args) {
  const values = parseCutoverOptions(args);
  if (values['--mode'] === 'prepare') return prepareCutover(values['--report'], values['--output']);
  return applyCutover(values['--manifest'], values['--sha256'], values['--journal'], {}, values['--mode']);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error.message); process.exitCode = 1; });
