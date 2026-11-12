import type { RemovalHistoryRecord } from './RemovalHistory';

export type ResourceKind = 'skill' | 'portable' | 'cli' | 'mcp';
export type ResourceParameter = { name: string; label: string; kind: 'text' | 'choice' | 'integer'; required?: boolean; maxLength?: number; choices?: string[]; min?: number; max?: number; templateAllowed?: boolean; sensitive?: boolean };
export function sensitiveResourceParameter(parameter: ResourceParameter): boolean {
  const name = parameter.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return parameter.sensitive === true || name === 'pwd' || ['password', 'passwd', 'passphrase', 'token', 'cookie', 'secret', 'auth', 'credential', 'apikey', 'privatekey', 'accesskey', 'sessionkey'].some(part => name.includes(part));
}
export function templateParameterAllowed(parameter: ResourceParameter): boolean { return parameter.templateAllowed === true && !sensitiveResourceParameter(parameter); }
export type ResourceActionDefinition = { id: string; label: string; mode: 'task' | 'service'; executable: string; workingDirectory: string; args: ({ type: 'literal'; value: string } | { type: 'parameter'; name: string })[]; parameters: ResourceParameter[]; timeoutSeconds?: number; cancellable?: boolean };
export type ResourceCapability = { id: string; label: string; status: string; verifiedAt?: string | null; reason?: string };
export type ResourceRun = { runId: string; resourceId: string; actionId: string; pid: number; mode: 'task' | 'service'; status: string; startedAt: string; finishedAt?: string | null; exitCode?: number | null; cancellable?: boolean; protocolSession?: boolean };
export type ResourceRunResult = { run: ResourceRun; stdout?: string; stderr?: string; outputTruncated?: boolean; capabilityEvidenceWarning?: string };
export function mergeResourceRuns(previous: readonly ResourceRun[], incoming: readonly ResourceRun[]): ResourceRun[] {
  const byId = new Map(previous.map(run => [run.runId, run]));
  for (const run of incoming) {
    const current = byId.get(run.runId);
    if (current && current.status !== 'running' && run.status === 'running') continue;
    if (current?.finishedAt && run.finishedAt && current.finishedAt > run.finishedAt) continue;
    byId.set(run.runId, run);
  }
  const all = [...byId.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return [...all.filter(run => run.status === 'running'), ...all.filter(run => run.status !== 'running').slice(0, 30)];
}
export type Resource = {
  id: string; name: string; kind: ResourceKind; rootPath: string;
  repository?: string | null; version?: string | null; alias: string; notes: string;
  enabled: boolean; ownership: 'external' | 'managed'; revision: number;
  sceneEligible?: boolean; sceneReason?: string; effectiveEnabled?: boolean;
  managementScope: string; actions: ResourceActionDefinition[]; capabilities: ResourceCapability[];
  installation?: { runtimePackage?: { recipe: 'agentReachWheelV1' | 'edgeMcpNpmV1' } | null; removalState?: RemovalHistoryRecord | null } | null;
  createdAt: string; updatedAt: string;
};
export const resourceKinds: Record<ResourceKind, string> = {
  skill: 'Skill', portable: '便携程序', cli: '命令行工具', mcp: 'MCP 服务',
};

export function queryResources(resources: readonly Resource[], query: string, kind: string): Resource[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return resources.filter(resource => {
    if (kind && resource.kind !== kind) return false;
    const text = [resource.name, resource.alias, resource.notes, resource.repository, resource.rootPath, resourceKinds[resource.kind], ...resource.actions.map(action => action.label), ...resource.capabilities.map(capability => capability.label)].filter(Boolean).join(' ').toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  });
}

// Refreshing metadata does not move the user's current row underneath the pointer.
export function preserveResourceOrder(previous: readonly Resource[], incoming: readonly Resource[]): Resource[] {
  const byId = new Map(incoming.map(item => [item.id, item]));
  const retained: Resource[] = [];
  for (const item of previous) {
    const replacement = byId.get(item.id);
    if (replacement) { retained.push(replacement); byId.delete(item.id); }
  }
  return [...retained, ...byId.values()];
}

export function repositoryHref(repository?: string | null): string | null {
  if (!repository) return null;
  try {
    const url = new URL(repository);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.port ? url.href : null;
  } catch { return null; }
}
