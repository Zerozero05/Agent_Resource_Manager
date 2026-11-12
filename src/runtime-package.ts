import type { Resource } from './resources';

export type PackageRecipe = 'agentReachWheelV1' | 'edgeMcpNpmV1';
export type PackagePhase = 'prepare' | 'download' | 'resume' | 'materialize' | 'commit';
export const packageNames: Record<PackageRecipe, string> = { agentReachWheelV1: 'Agent Reach', edgeMcpNpmV1: 'Playwright MCP' };
const statuses = ['preparing', 'resolved', 'prepareFailed', 'downloading', 'downloaded', 'downloadInterrupted', 'materializing', 'materialized', 'materializationIncomplete', 'failed'];
export type PackageSession = { id: string; revision: number; recipe: PackageRecipe; version: string; resourceId: string | null; destinationPath: string; downloadDirectory: string; workingDirectory: string; status: string; error: string | null; downloadComplete: boolean; materialized: boolean; executionVerified: false; createdAt: string; updatedAt: string };
export type PackageAsset = { name: string; filename: string; source: string; bytes: number | null; digest: string | null };
export type PackagePreview = { id: string; phase: PackagePhase; kind: string; canApply: boolean; recipe: PackageRecipe; sessionId?: string; sessionRevision?: number; resourceId: string | null; version?: string; targetPath?: string; workingDirectory?: string; downloadDirectory?: string; bytesPerSecond?: number; downloadBytes?: number | null; maximumArtifactBytes?: number; mode?: 'register' | 'candidate'; files?: PackageReceipt['files']; assets: PackageAsset[]; licenses: string[]; warnings: string[]; effects: string[]; hosts: string[]; networkPurpose?: string; resolverMayDownload?: boolean; resolverRateLimited?: boolean; partialFiles: { path: string; complete: boolean; bytes: number | null; error: string | null }[] };
export type PackageReceipt = { recipe: PackageRecipe; root: string; files: { path: string; role: string; installedSha256: string }[]; complete: boolean; dependencyCheckPassed: boolean; executionVerified: false; error: string | null; createdPaths: string[]; temporaryPaths: string[] };
export type PackageResult = { session: PackageSession; complete: boolean; executionVerified: false; receipt: PackageReceipt | null; registered: boolean; resource?: Resource };
export type PackageCommitResult = { receipt: PackageReceipt; complete: boolean; ownershipSaved: boolean; registered: boolean; staged: boolean; switched: false; executionVerified: false; error: string | null; resource?: Resource };
type ObjectValue = Record<string, any>;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f]/.test(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const optionalText = (value: unknown): value is string | null => value === null || typeof value === 'string';
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{64}$/i.test(value);
export const isPackageRecipe = (value: unknown): value is PackageRecipe => value === 'agentReachWheelV1' || value === 'edgeMcpNpmV1';
function invalid(): never { throw new Error('软件包准备结果格式不完整，请刷新记录核对；未取得新的执行许可。'); }
function fingerprint(value: unknown): value is ObjectValue { return object(value) && count(value.bytes) && digest(value.sha256) && typeof value.modified === 'string'; }
function binding(value: unknown, name?: string): PackageAsset {
  if (!object(value) || !text(value.path) || !fingerprint(value.file) || !object(value.origin)) invalid();
  const origin = value.origin;
  let label: string, source: string;
  if (origin.kind === 'githubRelease' && object(origin.source) && text(origin.source.repository) && text(origin.source.version)) { label = origin.source.repository; source = `${origin.source.repository} · ${origin.source.version}`; }
  else if (origin.kind === 'npmRegistry' && text(origin.package) && text(origin.version) && text(origin.tarball)) { label = origin.package; source = origin.tarball; }
  else if (origin.kind === 'pyPiWheel' && text(origin.package) && text(origin.version) && text(origin.url)) { label = origin.package; source = origin.url; }
  else invalid();
  return { name: name || label!, filename: value.path.split(/[\\/]/).at(-1)!, source: source!, bytes: value.file.bytes, digest: value.file.sha256 };
}
function remote(value: unknown): PackageAsset {
  if (!object(value) || !text(value.package) || !text(value.filename) || !text(value.url) || !(value.bytes === null || count(value.bytes)) || !(value.sha256 === null || digest(value.sha256)) || !(value.sha512 === null || typeof value.sha512 === 'string' && /^sha512-[A-Za-z\d+/]+={0,2}$/.test(value.sha512)) || !value.sha256 && !value.sha512) invalid();
  return { name: value.package, filename: value.filename, source: value.url, bytes: value.bytes, digest: value.sha256 || value.sha512 };
}
export function packageSession(value: unknown): PackageSession {
  if (!object(value) || !text(value.id) || !count(value.revision) || value.revision < 1 || !isPackageRecipe(value.recipe) || !text(value.version) || !(value.resourceId === null || text(value.resourceId)) || ![value.destinationPath, value.downloadDirectory, value.workingDirectory].every(text) || !statuses.includes(value.status) || !optionalText(value.error) || typeof value.downloadComplete !== 'boolean' || typeof value.materialized !== 'boolean' || value.executionVerified !== false || !text(value.createdAt) || !text(value.updatedAt)) invalid();
  return value as PackageSession;
}
export function packageSessions(value: unknown): PackageSession[] {
  if (!object(value) || !Array.isArray(value.sessions)) invalid();
  const sessions = value.sessions.map(packageSession);
  if (new Set(sessions.map(item => item.id)).size !== sessions.length) invalid();
  return sessions;
}
export function samePackagePath(left: string, right: string): boolean {
  const normalized = (path: string) => { const plain = path.replace(/^\\\\\?\\(?=[a-z]:\\)/i, '').replace(/\\/g, '/').replace(/\/$/, ''); return /^[a-z]:\//i.test(plain) ? plain.toLowerCase() : plain; };
  return normalized(left) === normalized(right);
}
function download(value: ObjectValue, plan: PackagePreview) {
  if (value.kind !== 'runtimePackageDownload' || !isPackageRecipe(value.recipe) || !text(value.directory) || !count(value.bytesPerSecond) || !Array.isArray(value.artifacts) || !(value.downloadBytes === null || count(value.downloadBytes)) || !count(value.maximumArtifactBytes) || !digest(value.planHash) || value.installsFiles !== false || value.executesCode !== false || typeof value.warning !== 'string') invalid();
  plan.recipe = value.recipe; plan.downloadDirectory = value.directory; plan.bytesPerSecond = value.bytesPerSecond; plan.assets = value.artifacts.map(remote); plan.downloadBytes = value.downloadBytes; plan.maximumArtifactBytes = value.maximumArtifactBytes; plan.warnings = [value.warning];
}
export function packagePreview(value: unknown, phase: PackagePhase, session?: PackageSession): PackagePreview {
  if (!object(value) || !text(value.id) || typeof value.canApply !== 'boolean' || !(value.resourceId === null || text(value.resourceId))) invalid();
  const plan: PackagePreview = { id: value.id, kind: value.kind, phase, canApply: value.canApply, recipe: 'agentReachWheelV1', resourceId: value.resourceId, assets: [], licenses: [], warnings: [], effects: [], hosts: [], partialFiles: [] };
  if (phase !== 'prepare') {
    if (!session || value.sessionId !== session.id || value.sessionRevision !== session.revision || value.resourceId !== session.resourceId) invalid();
    plan.sessionId = value.sessionId; plan.sessionRevision = value.sessionRevision;
  }
  if (phase === 'prepare') {
    if (value.kind !== 'runtimePackagePreparation' || !isPackageRecipe(value.recipe) || ![value.version, value.targetPath, value.workingDirectory, value.downloadDirectory].every(text) || !count(value.bytesPerSecond) || value.installsFiles !== false || value.executionVerified !== false || !object(value.network) || !strings(value.network.hosts) || typeof value.network.purpose !== 'string' || typeof value.warning !== 'string') invalid();
    plan.recipe = value.recipe; plan.version = value.version; plan.targetPath = value.targetPath; plan.workingDirectory = value.workingDirectory; plan.downloadDirectory = value.downloadDirectory; plan.bytesPerSecond = value.bytesPerSecond; plan.hosts = value.network.hosts; plan.networkPurpose = value.network.purpose; plan.warnings = [value.warning];
    if (value.recipe === 'agentReachWheelV1') {
      if (value.network.resolverMayDownloadWheels !== true || value.network.resolverDownloadsRateLimited !== false || !text(value.network.temporaryCacheParent)) invalid();
      plan.assets = [binding(value.source)]; plan.resolverMayDownload = true; plan.resolverRateLimited = false;
    } else if (value.source !== null || value.network.downloadsArchives !== false) invalid();
  } else if (phase === 'download') download(value, plan);
  else if (phase === 'resume') {
    if (value.kind !== 'runtimePackageResume' || !object(value.plan) || !Array.isArray(value.transfers) || value.willReplayInstall !== false) invalid();
    download(value.plan, plan);
    plan.partialFiles = value.transfers.map((transfer: unknown) => {
      if (!object(transfer) || !text(transfer.package) || !text(transfer.target) || !optionalText(transfer.partial) || !(transfer.observed === null || fingerprint(transfer.observed)) || typeof transfer.complete !== 'boolean' || !optionalText(transfer.error)) invalid();
      return { path: transfer.partial || transfer.target, complete: transfer.complete, bytes: transfer.observed?.bytes ?? null, error: transfer.error };
    });
  } else if (phase === 'commit') {
    if (!session?.materialized || value.kind !== 'resourcePackageCommit' || value.recipe !== session.recipe || value.version !== session.version || !text(value.targetPath) || value.mode !== (session.resourceId === null ? 'register' : 'candidate') || !Array.isArray(value.files) || !strings(value.warnings)) invalid();
    validateFiles(value.files); plan.recipe = value.recipe; plan.version = value.version; plan.targetPath = value.targetPath; plan.mode = value.mode; plan.files = value.files; plan.warnings = value.warnings;
    plan.licenses = value.files.filter((file: PackageReceipt['files'][number]) => file.role === 'license').map((file: PackageReceipt['files'][number]) => file.path);
  } else {
    if (!isPackageRecipe(value.recipe) || !text(value.targetPath) || !digest(value.planHash) || value.executionVerified !== false) invalid();
    plan.recipe = value.recipe; plan.targetPath = value.targetPath;
    if (value.kind === 'pythonRuntimeMaterialization' && value.recipe === 'agentReachWheelV1' && Array.isArray(value.artifacts) && text(value.workingPath) && strings(value.sideEffects)) {
      plan.assets = value.artifacts.map((item: unknown) => binding(item)); plan.workingDirectory = value.workingPath; plan.effects = value.sideEffects;
    } else if (value.kind === 'npmRuntimeMaterialization' && value.recipe === 'edgeMcpNpmV1' && object(value.artifacts) && object(value.files) && strings(value.warnings) && count(value.nodeMajorMinimum)) {
      plan.assets = Object.entries(value.artifacts).map(([name, artifact]) => binding(artifact, name)); plan.warnings = value.warnings;
      for (const [name, contents] of Object.entries(value.files)) {
        if (!object(contents) || !Array.isArray(contents.files) || !count(contents.unpackedBytes)) invalid();
        for (const file of contents.files) { if (!object(file) || !text(file.path) || !count(file.bytes) || !digest(file.sha256) || typeof file.license !== 'boolean') invalid(); if (file.license) plan.licenses.push(`${name} · ${file.path}`); }
      }
    } else invalid();
  }
  if (session && (plan.recipe !== session.recipe || plan.targetPath && !samePackagePath(plan.targetPath, session.destinationPath) || plan.downloadDirectory && !samePackagePath(plan.downloadDirectory, session.downloadDirectory))) invalid();
  return plan;
}
function validateFiles(files: unknown[]): void {
  for (const file of files) if (!object(file) || !text(file.path) || !['runtime', 'privateDependency', 'configuration', 'userData', 'cache', 'localModification', 'license'].includes(file.role) || !digest(file.installedSha256)) invalid();
}
function receipt(value: unknown): PackageReceipt {
  if (!object(value) || !isPackageRecipe(value.recipe) || !text(value.root) || !Array.isArray(value.files) || typeof value.complete !== 'boolean' || typeof value.dependencyCheckPassed !== 'boolean' || value.executionVerified !== false || !optionalText(value.error) || !strings(value.createdPaths) || !strings(value.temporaryPaths)) invalid();
  validateFiles(value.files);
  return value as PackageReceipt;
}
function resource(value: unknown): value is Resource {
  return object(value) && text(value.id) && text(value.name) && text(value.rootPath) && ['cli', 'mcp', 'portable'].includes(value.kind) && count(value.revision) && value.revision > 0 && typeof value.enabled === 'boolean' && Array.isArray(value.actions) && Array.isArray(value.capabilities) && typeof value.alias === 'string' && typeof value.notes === 'string' && text(value.managementScope) && ['external', 'managed', 'managedFiles'].includes(value.ownership) && typeof value.createdAt === 'string' && typeof value.updatedAt === 'string';
}
export function packageResult(value: unknown, phase: Exclude<PackagePhase, 'commit'>): PackageResult {
  if (!object(value) || typeof value.complete !== 'boolean' || value.executionVerified !== false || value.registered !== undefined && value.registered !== false) invalid();
  const session = packageSession(value.session), result: PackageResult = { session, complete: value.complete, executionVerified: false, receipt: value.receipt == null ? null : receipt(value.receipt), registered: value.registered === true };
  if (result.receipt && (result.receipt.recipe !== session.recipe || !samePackagePath(result.receipt.root, session.destinationPath))) invalid();
  if (phase === 'materialize' && result.complete && (!result.receipt?.complete || !result.receipt.dependencyCheckPassed)) invalid();
  return result;
}
export function packageCommitResult(value: unknown, preview: PackagePreview, session: PackageSession): PackageCommitResult {
  if (!object(value) || preview.phase !== 'commit' || preview.sessionId !== session.id || preview.sessionRevision !== session.revision || preview.resourceId !== session.resourceId || typeof value.complete !== 'boolean' || typeof value.ownershipSaved !== 'boolean' || typeof value.registered !== 'boolean' || typeof value.staged !== 'boolean' || value.switched !== false || value.executionVerified !== false || value.error !== undefined && !optionalText(value.error)) invalid();
  const actualReceipt = receipt(value.receipt);
  if (actualReceipt.recipe !== session.recipe || !samePackagePath(actualReceipt.root, session.destinationPath) || !samePackagePath(preview.targetPath!, session.destinationPath)) invalid();
  const result: PackageCommitResult = { receipt: actualReceipt, complete: value.complete, ownershipSaved: value.ownershipSaved, registered: value.registered, staged: value.staged, switched: false, executionVerified: false, error: value.error || null };
  if (result.registered && result.staged || result.registered && preview.mode !== 'register' || result.staged && preview.mode !== 'candidate' || !result.complete && (result.registered || result.staged)) invalid();
  if (result.complete) {
    if (!actualReceipt.complete || !actualReceipt.dependencyCheckPassed || !result.ownershipSaved || !(result.registered || result.staged) || !resource(value.resource) || value.resource.kind !== (session.recipe === 'agentReachWheelV1' ? 'cli' : 'mcp') || (result.registered ? !samePackagePath(value.resource.rootPath, session.destinationPath) : value.resource.id !== session.resourceId)) invalid();
    result.resource = value.resource;
  }
  return result;
}
export function packageSessionLabel(session: PackageSession): string {
  if (session.error || ['prepareFailed', 'failed', 'downloadInterrupted', 'materializationIncomplete'].includes(session.status)) return '未完成';
  if (session.materialized) return '目录已准备';
  return session.status === 'materializing' ? '运行目录准备尚未结束' : session.status === 'downloading' ? '下载尚未结束' : session.downloadComplete ? '文件已下载' : session.status === 'preparing' ? '准备尚未结束' : '待下载';
}
export const packageBytes = (value: number | null | undefined): string => value == null ? '未知' : value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MiB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${value} B`;
