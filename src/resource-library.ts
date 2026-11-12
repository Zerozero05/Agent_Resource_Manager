import { changeReason, displayStatus, needsAttention, queryLibrary, type LibraryItem } from './library.ts';
import { queryResources, resourceKinds, type Resource } from './resources.ts';
import type { LibraryReading } from './library-reading.ts';

export type ResourceLibraryKind = 'all' | 'skills' | 'tools';
export type ResourceLibraryDraft = {
  query: string; kind: ResourceLibraryKind; category: string; attention: boolean;
  page: number; pageSize: 20 | 50 | 100; refresh: number; reading: LibraryReading | null;
};
export type ResourceLibrarySkill = LibraryItem & { version?: string | null };
export type ResourceLibraryEntry = {
  id: string; resourceId: string; owner: 'skill' | 'tool'; name: string; originalName: string;
  description: string; location: string; version?: string | null; categoryId?: string | null;
  type: string; status: string; tone: string; statusDetail: string;
};
const collator = new Intl.Collator('zh-Hans', { numeric: true, sensitivity: 'base' });
const failedCapability = (resource: Resource) => resource.capabilities.find(capability => ['failed', 'unavailable', 'needs_login'].includes(capability.status));

export function resourceLibraryEntries(skills: readonly ResourceLibrarySkill[], tools: readonly Resource[]): ResourceLibraryEntry[] {
  const skillEntries = skills.map(skill => {
    const status = displayStatus(skill);
    return {
      id: `skill:${skill.id}`, resourceId: skill.id, owner: 'skill' as const,
      name: skill.alias || skill.displayName || skill.name, originalName: skill.name,
      description: skill.description || '', location: skill.localPath || [skill.repo, skill.remotePath].filter(Boolean).join('/'),
      version: skill.version, categoryId: skill.categoryId, type: 'Skill', status: status.label,
      tone: status.tone, statusDetail: needsAttention(skill) ? changeReason(skill) : status.detail,
    };
  });
  const toolEntries = tools.map(resource => {
    const problem = failedCapability(resource);
    const state = !resource.enabled ? '已停用' : resource.effectiveEnabled === false ? '场景未启用' : problem ? '能力需处理' : '已登记';
    return {
      id: `tool:${resource.id}`, resourceId: resource.id, owner: 'tool' as const,
      name: resource.alias || resource.name, originalName: resource.name, description: resource.notes,
      location: resource.rootPath, version: resource.version, type: resource.kind === 'skill' ? 'Skill · 工具登记' : resourceKinds[resource.kind],
      status: state, tone: resource.enabled && problem ? 'amber' : 'neutral',
      statusDetail: problem?.reason || (problem ? `${problem.label}需要核对` : state),
    };
  });
  return [...skillEntries, ...toolEntries].sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id));
}

export function queryResourceLibrary(skills: readonly ResourceLibrarySkill[], tools: readonly Resource[], draft: ResourceLibraryDraft): ResourceLibraryEntry[] {
  const selectedSkills = draft.kind === 'tools' ? [] : queryLibrary(skills, {
    query: draft.query, categoryFilter: draft.category, statusFilter: draft.attention ? 'attention' : 'all',
  });
  // A selected Skill category narrows an all-resource search to that category.
  const selectedTools = draft.kind === 'skills' || draft.kind === 'all' && draft.category !== 'all' ? [] : queryResources(tools, draft.query, '').filter(resource => !draft.attention || resource.enabled && !!failedCapability(resource));
  return resourceLibraryEntries(selectedSkills, selectedTools);
}

export function resourceLibraryDraft(value?: Partial<ResourceLibraryDraft>): ResourceLibraryDraft {
  const page = value?.page ?? 1;
  const refresh = value?.refresh ?? 0;
  return {
    query: typeof value?.query === 'string' ? value.query : '',
    kind: value?.kind === 'skills' || value?.kind === 'tools' ? value.kind : 'all',
    category: typeof value?.category === 'string' ? value.category : 'all', attention: value?.attention === true,
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: value?.pageSize === 50 || value?.pageSize === 100 ? value.pageSize : 20,
    refresh: Number.isSafeInteger(refresh) ? refresh : 0,
    reading: value?.reading && typeof value.reading.key === 'string' && Array.isArray(value.reading.ids) ? { key: value.reading.key, ids: value.reading.ids.filter(id => typeof id === 'string') } : null,
  };
}
