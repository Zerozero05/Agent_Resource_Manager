import type { Resource } from './resources';
import { SETTINGS_SECTIONS, SETTINGS_SECTION_KEYS, type SettingsSectionKey } from './settings-sections.ts';

export type CommandTarget =
  | { kind: 'skill'; id: string; section: 'docs' | 'files' }
  | { kind: 'tool'; id: string }
  | { kind: 'resource-action'; id: string; actionId: string; expectedRevision: number }
  | { kind: 'view'; view: 'dashboard' | 'resources' | 'skills' | 'tools' | 'changes' | 'clients' | 'settings' }
  | { kind: 'settings'; section: SettingsSectionKey }
  | { kind: 'history' };
export type Command = { id: string; label: string; detail: string; keywords: string; target: CommandTarget; disabledReason?: string };
export type CommandSkill = { id: string; name: string; displayName?: string; alias?: string; notes?: string; description?: string };

function capabilityText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  return ['id', 'name', 'label', 'description'].map(key => typeof record[key] === 'string' ? record[key] : '').join(' ');
}

/** Registered actions open their existing parameter forms; capability declarations are not actions. */
export function buildCommands(skills: readonly CommandSkill[], resources: readonly Resource[], options: { readOnly?: boolean } = {}): Command[] {
  const commands: Command[] = [
    ...([['dashboard', '总览', 'Dashboard 仪表盘 收藏 任务'], ['resources', '全部资源', '资源目录 Skills 工具 搜索'], ['skills', '技能库', 'Skills'], ['tools', '工具目录', '资源 CLI MCP 便携程序'], ['changes', '变化', '检查 更新 差异'], ['clients', '客户端', 'Codex Claude Cursor 连接']] as const).map(([view, label, keywords]) => ({ id: `view:${view}`, label: `打开${label}`, detail: '导航', keywords, target: { kind: 'view' as const, view } })),
    ...SETTINGS_SECTION_KEYS.map(section => {
      const { commandLabel, keywords } = SETTINGS_SECTIONS[section];
      return { id: `settings:${section}`, label: commandLabel, detail: '设置', keywords: `设置 ${keywords}`, target: { kind: 'settings' as const, section } };
    }),
    { id: 'history', label: '操作记录', detail: '查看任务及结果，不重新执行', keywords: '任务 历史 进度 结果', target: { kind: 'history' } },
  ];
  for (const skill of skills) {
    const label = skill.alias || skill.displayName || skill.name;
    const keywords = `${skill.name} ${skill.displayName || ''} ${skill.alias || ''} ${skill.notes || ''} ${skill.description || ''}`;
    commands.push({ id: `skill:${skill.id}:docs`, label, detail: 'Skill · 查看说明', keywords: `${keywords} 说明 docs`, target: { kind: 'skill', id: skill.id, section: 'docs' } });
    commands.push({ id: `skill:${skill.id}:files`, label: `${label} · 文件`, detail: 'Skill · 查看文件', keywords: `${keywords} 文件 files`, target: { kind: 'skill', id: skill.id, section: 'files' } });
  }
  for (const resource of resources) {
    const capabilities = (resource.capabilities || []).map(capabilityText).join(' ');
    commands.push({ id: `tool:${resource.id}`, label: resource.alias || resource.name, detail: `${resource.enabled ? '工具' : '已停用工具'} · 查看详情`, keywords: `${resource.name} ${resource.alias} ${resource.notes} ${resource.kind} ${capabilities}`, target: { kind: 'tool', id: resource.id } });
    for (const action of resource.actions) {
      commands.push({
        id: `action:${resource.id}:${action.id}`, label: `${action.label} · ${resource.alias || resource.name}`,
        detail: `${action.mode === 'service' ? '服务动作' : '工具动作'} · 打开参数表单，核对后执行`,
        keywords: `${resource.name} ${resource.alias} ${action.id} ${action.label} 动作 调用`,
        target: { kind: 'resource-action', id: resource.id, actionId: action.id, expectedRevision: resource.revision },
        disabledReason: options.readOnly ? '基本模式只读，暂不可调用' : !resource.enabled ? '工具已停用，启用后才能调用' : resource.sceneEligible === false ? resource.sceneReason || '当前场景未包含此工具' : undefined,
      });
    }
  }
  return commands;
}

export function queryCommands(commands: readonly Command[], query: string): Command[] {
  const text = query.trim().toLocaleLowerCase();
  if (!text) return [...commands];
  const terms = text.split(/\s+/);
  return commands.map((command, index) => ({ command, index, label: command.label.toLocaleLowerCase() }))
    .filter(({ command, label }) => terms.every(term => `${label} ${command.detail} ${command.keywords}`.toLocaleLowerCase().includes(term)))
    .map(item => ({ ...item, score: item.label === text ? 0 : item.label.startsWith(text) ? 1 : item.label.includes(text) ? 2 : 3 }))
    .sort((a, b) => a.score - b.score || a.index - b.index).map(item => item.command);
}

export function commandShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'keyCode' | 'defaultPrevented' | 'repeat'>): boolean {
  return !event.defaultPrevented && !event.repeat && !event.isComposing && event.keyCode !== 229 && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k';
}

export type ResourceCatalogueState = { resources: readonly Resource[]; loaded: boolean; stale: boolean; loading: boolean; error: string };
export class ResourceCommandCatalogue {
  private state: ResourceCatalogueState = { resources: [], loaded: false, stale: true, loading: false, error: '' };
  private listeners = new Set<() => void>();
  private revision = -1;
  private pendingUpdates: Map<string, Resource> | undefined;
  private pending: Promise<{ resources: Resource[] }> | undefined;
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<ResourceCatalogueState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  invalidate(revision: number) {
    if (revision <= this.revision) return;
    this.revision = revision;
    if (!this.state.stale) this.publish({ stale: true });
  }
  accept(resource: Resource) {
    const found = this.state.resources.find(item => item.id === resource.id);
    if (found && found.revision > resource.revision) return;
    this.pendingUpdates?.set(resource.id, resource);
    this.publish({ resources: found ? this.state.resources.map(item => item.id === resource.id ? resource : item) : [...this.state.resources, resource] });
  }
  read(load: () => Promise<{ resources: Resource[] }>): Promise<{ resources: Resource[] }> {
    if (this.pending) return this.pending;
    const revision = this.revision;
    const updates = new Map<string, Resource>();
    this.pendingUpdates = updates;
    this.publish({ loading: true, error: '' });
    const pending = Promise.resolve().then(load).then(result => {
      // Keep the complete list, then overlay only writes received during this read.
      // A registration absent from the earlier list is appended, never inferred deleted.
      const remaining = new Map(updates);
      const resources = result.resources.map(resource => {
        const updated = remaining.get(resource.id);
        remaining.delete(resource.id);
        return updated && updated.revision >= resource.revision ? updated : resource;
      });
      resources.push(...remaining.values());
      this.publish({ resources, loaded: true, stale: revision !== this.revision || updates.size > 0 });
      return { resources: [...this.state.resources] };
    }).catch(error => { this.publish({ error: String(error), stale: true }); throw error; })
      .finally(() => { if (this.pending === pending) { this.pending = undefined; this.pendingUpdates = undefined; this.publish({ loading: false }); } });
    this.pending = pending;
    return pending;
  }
}

// A browser window shares one catalogue across its panes. No timer, network or disk work at import.
export const resourceCommandCatalogue = new ResourceCommandCatalogue();
