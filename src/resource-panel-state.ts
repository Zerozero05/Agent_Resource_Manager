import type { Resource, ResourceKind } from './resources';

export type ResourceEditorFields = { name: string; kind: ResourceKind; rootPath: string; repository: string; version: string; alias: string; notes: string };
export type ResourcePanelDraft = {
  query: string; kind: '' | ResourceKind; selectedId: string | null; resourceOrder: string[];
  editor: { resourceId: string | null; expectedRevision: number | null; fields: ResourceEditorFields } | null;
  lastFocusRequest: { resourceId: string; request: number } | null;
};

export function resourceEditorFields(resource?: Resource): ResourceEditorFields {
  return resource ? { name: resource.name, kind: resource.kind, rootPath: resource.rootPath, repository: resource.repository || '', version: resource.version || '', alias: resource.alias, notes: resource.notes }
    : { name: '', kind: 'cli', rootPath: '', repository: '', version: '', alias: '', notes: '' };
}

/** Restore identity order using only current records; saved drafts never authorize actions. */
export function restoreResourceOrder(order: readonly string[], resources: readonly Resource[]): Resource[] {
  const remaining = new Map(resources.map(resource => [resource.id, resource]));
  const restored: Resource[] = [];
  for (const id of order) { const resource = remaining.get(id); if (resource) { restored.push(resource); remaining.delete(id); } }
  return [...restored, ...remaining.values()];
}
