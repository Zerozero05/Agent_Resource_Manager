import type { LibraryMode, LibrarySort, LibrarySourceFilter, LibraryStatusFilter } from './library.ts';
import type { ResourceKind } from './resources.ts';

export type SkillViewFilters = {
  query: string; sourceFilter: LibrarySourceFilter; statusFilter: LibraryStatusFilter;
  categoryFilter: string; sort: LibrarySort; mode: LibraryMode; pageSize: 20 | 50 | 100;
};
export type ToolViewFilters = { query: string; kind: '' | ResourceKind };
export type SkillAnnotation = { skillId: string; revision: number; alias: string; notes: string };
export type SavedView = { id: string; revision: number; name: string } & (
  { view: 'skills'; filters: SkillViewFilters } | { view: 'tools'; filters: ToolViewFilters }
);
export type ManagementData = { revision: number; skillAnnotations: SkillAnnotation[]; savedViews: SavedView[] };
export type ManagementAction = (label: string, action: string, args: Record<string, unknown>) => Promise<ManagementData>;
export type ManagementDataSnapshot = { data: ManagementData | null; loaded: boolean; stale: boolean; loading: boolean; error: string | null };

/** One window's shared display cache. Importing or invalidating never starts I/O. */
export function createManagementDataCache() {
  let snapshot: ManagementDataSnapshot = { data: null, loaded: false, stale: true, loading: false, error: null };
  let watermark = 0, accepted = 0;
  let pending: Promise<ManagementData> | null = null;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<ManagementDataSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const accept = (data: ManagementData) => {
    if (snapshot.data && data.revision < snapshot.data.revision) return;
    const stale = data.revision < watermark;
    if (snapshot.data === data && snapshot.loaded && snapshot.stale === stale && snapshot.error === null) return;
    accepted++;
    publish({ data, loaded: true, stale, error: null });
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    invalidate(managementRevision: number) {
      if (managementRevision <= watermark) return;
      watermark = managementRevision;
      if (!snapshot.data || snapshot.data.revision < watermark) publish({ stale: true });
    },
    accept,
    read(load: () => Promise<ManagementData>): Promise<ManagementData> {
      if (pending) return pending;
      if (snapshot.data && !snapshot.stale) return Promise.resolve(snapshot.data);
      const startedAt = accepted;
      pending = Promise.resolve().then(load).then(data => {
        accept(data);
        return snapshot.data!;
      }, cause => {
        // A failed old read must not replace a successful write's newer status.
        if (accepted === startedAt) publish({ error: cause instanceof Error ? cause.message : String(cause), stale: true });
        throw cause;
      }).finally(() => { pending = null; publish({ loading: false }); });
      publish({ loading: true, error: null });
      return pending;
    },
  };
}

export const managementDataCache = createManagementDataCache();
export const managementConflict = (cause: unknown) => /conflict|revision|changed|过期|变化|更改|冲突|并发|重新读取|重新加载/i.test(String(cause));
