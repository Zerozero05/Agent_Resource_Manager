import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isWithin } from './prepare-formal-cutover.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const managerRoot = resolve(projectRoot, '..', '..');
const validationRoot = join(managerRoot, 'validation', 'manager-data');
const key = path => resolve(path).toLowerCase();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function ordinary(path) {
  let current = resolve(path);
  while (current) {
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || key(await realpath(current)) !== key(current)) throw new Error('Entrypoint validation refused a reparse path.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}

// This diagnostic describes state-path precedence only. It does not validate
// Rust's complete bootstrap schema or authorize a native launch.
export function legacyEffectiveData({ program, sidecar, bootstrap, expectedData }) {
  if (typeof sidecar !== 'string' || Buffer.byteLength(sidecar) > 4096) throw new Error('Legacy sidecar must contain a bounded UTF-8 path.');
  const line = sidecar.replace(/^\uFEFF/, '').replace(/\r?\n$/, '');
  if (!line.trim() || /[\r\n\0]/.test(line)) throw new Error('Legacy sidecar requires one nonempty line.');
  const requested = isAbsolute(line.trim()) ? resolve(line.trim()) : resolve(dirname(program), line.trim());
  let effective = requested;
  if (bootstrap !== undefined) {
    if (bootstrap?.formatVersion !== 1 || typeof bootstrap.config?.managedRoot !== 'string' || !isAbsolute(bootstrap.config.managedRoot) || bootstrap.pending) throw new Error('Legacy bootstrap is invalid or has a pending migration.');
    effective = bootstrap.config.overrides?.state || bootstrap.config.managedRoot;
    if (typeof effective !== 'string' || !isAbsolute(effective)) throw new Error('Legacy bootstrap state path must be absolute.');
  }
  if (key(requested) !== key(expectedData) || key(effective) !== key(expectedData)) throw new Error('Legacy bootstrap or sidecar conflicts with the chosen canonical database.');
  return { requested, effective: resolve(effective), bootstrapPresent: bootstrap !== undefined, diagnosticOnly: true };
}

export function planEntryChildEnvironment(environment, temporary, sentinel) {
  const result = { ...environment, TEMP: temporary, TMP: temporary };
  for (const name of Object.keys(result)) if (name.toUpperCase() === 'SKILL_MANAGER_DATA_DIR') delete result[name];
  // Future native acceptance can use the wrong-path sentinel in the parent,
  // then explicitly use the sanitized child environment for the application.
  return { planOnly: true, parent: { ...result, SKILL_MANAGER_DATA_DIR: sentinel }, child: result, expectedRemovedVariable: 'SKILL_MANAGER_DATA_DIR' };
}

export function legacyForwarder(executable) {
  if (!isAbsolute(executable) || /[%\r\n\0"]/u.test(executable)) throw new Error('The generated test launcher needs one literal absolute executable path.');
  return `@echo off\r\nstart "" "${executable}"\r\n`;
}

export function validateEntrypointDataset(dataset) {
  if (dataset?.format !== 'agent-resource-manager-native-entrypoints-v1' || dataset.syntheticOnly !== true || !isWithin(dataset.root, validationRoot)) throw new Error('Use the generated isolated entrypoint dataset.');
  const root = resolve(dataset.root), old = join(root, 'legacy', 'app', 'skill-manager.exe'), next = join(root, 'new', 'app', 'agent-resource-manager.exe');
  if (key(dataset.legacy.executable) !== key(old) || key(dataset.candidate.executable) !== key(next)
    || !/^[a-f0-9]{64}$/.test(dataset.legacy.sha256) || !/^[a-f0-9]{64}$/.test(dataset.candidate.sha256)) throw new Error('Entrypoint executable identities differ from their isolated paths.');
  if (dataset.phases?.length !== 3 || dataset.phases.map(item => item.name).join(',') !== 'legacy-sidecar,new-bootstrap,legacy-launcher-forwarding') throw new Error('All three exact entrypoint phases are required.');
  for (const phase of dataset.phases) {
    const legacy = phase.name === 'legacy-sidecar';
    if (key(phase.executable) !== key(legacy ? old : next) || key(phase.dataDirectory) !== key(join(root, legacy ? 'legacy-data' : 'new-data'))
      || key(phase.reportPath) !== key(join(root, `${phase.name}-driver.json`)) || phase.commandLineArguments?.length !== 0
      || phase.sha256 !== (legacy ? dataset.legacy.sha256 : dataset.candidate.sha256)
      || phase.removeDataDirectoryEnvironment !== true || phase.requireBackendStatus !== !legacy) throw new Error('A native phase escaped its fixed entry, data or no-argument scope.');
    if (phase.launcher && (phase.name !== 'legacy-launcher-forwarding' || key(phase.launcher) !== key(join(root, 'legacy', '启动 Skill Manager.cmd')))) throw new Error('The test launcher escaped its isolated path.');
  }
  if (!dataset.phases[2].launcher || key(dataset.sentinel) !== key(join(root, 'unused-environment-data')) || key(dataset.temporary) !== key(join(root, 'native-temp'))) throw new Error('Forwarding, temporary and environment sentinel paths are required.');
  return dataset;
}

function freshBootstrap(root) {
  return { formatVersion: 1, config: { managedRoot: join(root, 'new'), overrides: { state: join(root, 'new-data'), webview: join(root, 'new', 'cache', 'webview'), recovery: join(root, 'new', 'data', 'recovery'), receipts: join(root, 'new', 'data', 'receipts'), temp: join(root, 'new', 'cache', 'temp') } } };
}

export async function prepareEntrypoints({ candidate, buildInfo, legacy, legacySha256 }) {
  const candidatePath = resolve(candidate), legacyPath = resolve(legacy);
  const oldCanonical = join(dirname(managerRoot), 'skill_manager', 'skill-manager.exe');
  if (!isWithin(candidatePath, projectRoot) || !isWithin(resolve(buildInfo), projectRoot) || (!isWithin(legacyPath, projectRoot) && key(legacyPath) !== key(oldCanonical))) throw new Error('Use already available verified project candidates and the known previous runtime.');
  await ordinary(candidatePath); await ordinary(legacyPath); await ordinary(buildInfo);
  const infoBytes = await readFile(buildInfo), info = JSON.parse(infoBytes);
  const candidateBytes = await readFile(candidatePath), legacyBytes = await readFile(legacyPath);
  if (info.buildMode !== 'release' || info.diagnosticOnly === true || hash(candidateBytes) !== info.executableSha256 || key(info.executablePath) !== key(candidatePath)
    || !/^[a-f0-9]{64}$/.test(legacySha256) || hash(legacyBytes) !== legacySha256) throw new Error('Normal candidate or previous executable digest differs.');
  await ordinary(validationRoot);
  const root = await mkdtemp(join(validationRoot, 'native-entrypoints-'));
  const legacyExecutable = join(root, 'legacy', 'app', 'skill-manager.exe'), candidateExecutable = join(root, 'new', 'app', 'agent-resource-manager.exe');
  const legacyData = join(root, 'legacy-data'), newData = join(root, 'new-data'), sentinel = join(root, 'unused-environment-data'), temporary = join(root, 'native-temp');
  for (const path of [dirname(legacyExecutable), dirname(candidateExecutable), legacyData, newData, sentinel, temporary]) await mkdir(path, { recursive: true });
  await copyFile(legacyPath, legacyExecutable); await copyFile(candidatePath, candidateExecutable);
  if (hash(await readFile(legacyExecutable)) !== legacySha256 || hash(await readFile(candidateExecutable)) !== info.executableSha256) throw new Error('Prepared executable copies differ from their verified inputs.');
  await writeFile(join(dirname(legacyExecutable), 'data-directory.txt'), `${legacyData}\n`, { flag: 'wx' });
  await writeFile(join(dirname(candidateExecutable), 'data-directory.txt'), '.\n', { flag: 'wx' });
  const bootstrap = freshBootstrap(root);
  await writeFile(join(dirname(candidateExecutable), 'storage-paths.json'), `${JSON.stringify(bootstrap, null, 2)}\n`, { flag: 'wx' });
  const launcher = join(root, 'legacy', '启动 Skill Manager.cmd'); await writeFile(launcher, legacyForwarder(candidateExecutable), { flag: 'wx' });
  const phase = (name, executable, dataDirectory, sha256, requireBackendStatus, forwarded) => ({ name, executable, dataDirectory, sha256, commandLineArguments: [], removeDataDirectoryEnvironment: true, requireBackendStatus, reportPath: join(root, `${name}-driver.json`), ...(forwarded ? { launcher } : {}) });
  const dataset = { format: 'agent-resource-manager-native-entrypoints-v1', syntheticOnly: true, root, temporary, sentinel, preparedAt: new Date().toISOString(),
    legacy: { executable: legacyExecutable, sha256: legacySha256, source: legacyPath, expectedVersion: '0.2.11' },
    candidate: { executable: candidateExecutable, sha256: info.executableSha256, source: candidatePath, buildInfo: resolve(buildInfo), buildInfoSha256: hash(infoBytes) },
    phases: [phase('legacy-sidecar', legacyExecutable, legacyData, legacySha256, false), phase('new-bootstrap', candidateExecutable, newData, info.executableSha256, true), phase('legacy-launcher-forwarding', candidateExecutable, newData, info.executableSha256, true, true)],
    protections: ['No --data-dir argument', 'Child environment directory variable removed', 'Synthetic data only', 'Ordinary owned-window close, no forced stop'],
    compatibilityScope: 'Entrypoint paths only. Existing separate 12-table recovery/downgrade/reopen evidence remains required.' };
  validateEntrypointDataset(dataset);
  await writeFile(join(root, 'dataset.json'), `${JSON.stringify(dataset, null, 2)}\n`, { flag: 'wx' });
  return { status: 'prepared-no-gui-launched', root };
}

export async function inspectEntrypoints(root) {
  if (typeof root !== 'string' || !isAbsolute(root) || !isWithin(root, validationRoot)) throw new Error('Entrypoint fixture root is outside the approved validation tree.');
  await ordinary(root);
  if (!(await lstat(root)).isDirectory()) throw new Error('Entrypoint fixture root must be an ordinary directory.');
  const datasetPath = join(root, 'dataset.json');
  await ordinary(datasetPath);
  const datasetStat = await lstat(datasetPath);
  if (!datasetStat.isFile() || datasetStat.nlink !== 1) throw new Error('Entrypoint dataset must be an ordinary single-link file.');
  const dataset = validateEntrypointDataset(JSON.parse(await readFile(datasetPath)));
  if (key(root) !== key(dataset.root)) throw new Error('Entrypoint dataset root differs.');
  await ordinary(dataset.temporary); await ordinary(dataset.sentinel);
  const oldBootstrapPath = join(dirname(dataset.legacy.executable), 'storage-paths.json');
  for (const path of [oldBootstrapPath, join(dirname(dataset.legacy.executable), 'data-directory.txt'), join(dirname(dataset.candidate.executable), 'data-directory.txt'), join(dirname(dataset.candidate.executable), 'storage-paths.json'), dataset.phases[2].launcher]) await ordinary(path);
  try { await lstat(oldBootstrapPath); throw new Error('Unexpected legacy bootstrap appeared after preparation. Use a fresh fixture before native acceptance.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  legacyEffectiveData({ program: dataset.legacy.executable, sidecar: await readFile(join(dirname(dataset.legacy.executable), 'data-directory.txt'), 'utf8'), expectedData: dataset.phases[0].dataDirectory });
  const launcherBytes = await readFile(dataset.phases[2].launcher, 'utf8');
  if (launcherBytes !== legacyForwarder(dataset.candidate.executable)) throw new Error('The isolated old launcher no longer forwards only the canonical candidate.');
  const nextSidecar = await readFile(join(dirname(dataset.candidate.executable), 'data-directory.txt'), 'utf8');
  const nextBootstrap = JSON.parse(await readFile(join(dirname(dataset.candidate.executable), 'storage-paths.json')));
  if (nextSidecar !== '.\n' || JSON.stringify(nextBootstrap) !== JSON.stringify(freshBootstrap(dataset.root))) throw new Error('New entrypoint bootstrap differs from its isolated paths.');
  for (const phase of dataset.phases) {
    await ordinary(phase.executable); await ordinary(phase.reportPath); await ordinary(phase.dataDirectory);
    if (hash(await readFile(phase.executable)) !== phase.sha256) throw new Error('Isolated executable bytes changed.');
  }
  return { status: 'entrypoint-files-inspected-native-run-pending', root, guiRun: false, environmentCheck: 'plan-only-no-child-process-launched', phases: dataset.phases.map(phase => phase.name),
    pending: 'Existing native helper always supplies --data-dir and owns only its directly launched PID. Actual no-argument and .cmd forwarding tests require a coordinated extension or native desktop acceptance.' };
}

export function entryOptions(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!['--mode', '--candidate', '--build-info', '--legacy', '--legacy-sha256', '--fixture'].includes(name) || !args[index + 1] || Object.hasOwn(result, name.slice(2))) throw new Error('Use exact prepare options or inspect --fixture. No GUI run is implemented.');
    result[name.slice(2)] = args[index + 1];
  }
  if (!['prepare', 'inspect'].includes(result.mode)) throw new Error('Only preparation and file inspection are supported. No GUI run is implemented.');
  if (result.mode === 'prepare' && ['candidate', 'build-info', 'legacy', 'legacy-sha256'].some(name => !result[name])) throw new Error('Preparation requires candidate, build-info, legacy and legacy-sha256.');
  if (result.mode === 'inspect' && !result.fixture) throw new Error('Inspection requires the exact generated fixture.');
  return result;
}

async function main(args) {
  const options = entryOptions(args);
  return options.mode === 'prepare'
    ? prepareEntrypoints({ candidate: options.candidate, buildInfo: options['build-info'], legacy: options.legacy, legacySha256: options['legacy-sha256'] })
    : inspectEntrypoints(options.fixture);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
