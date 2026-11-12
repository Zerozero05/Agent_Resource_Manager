import { useEffect, useRef, useState } from 'react';
import { templateParameterAllowed, type Resource, type ResourceActionDefinition } from './resources';

type Action = <T>(label: string, action: string, args: Record<string, unknown>) => Promise<T>;
export type InvocationTemplate = { id: string; revision: number; name: string; resourceId: string; actionId: string; parameterNames: string[]; compatible: boolean; reason?: string };
export type InvocationTemplateList = { templates: InvocationTemplate[]; resourceRevision: number; templateId?: string };
type PreparedTemplate = { parameters: Record<string, string | number>; resourceRevision: number; actionId: string; templateId: string };
export type InvocationTemplatesProps = {
  resource: Resource; definition: ResourceActionDefinition; parameters: Record<string, string>; action: Action;
  onApply: (parameters: Record<string, string | number>) => void; readOnly?: boolean; disabled?: boolean;
  onBusyChange?: (busy: boolean) => void; initialExpanded?: boolean;
};

export function InvocationTemplates(props: InvocationTemplatesProps) {
  return <TemplateEditor key={`${props.resource.id}:${props.resource.revision}:${props.definition.id}`} {...props} />;
}

function TemplateEditor({ resource, definition, parameters, action, onApply, readOnly = false, disabled = false, onBusyChange, initialExpanded = false }: InvocationTemplatesProps) {
  const [expanded, setExpanded] = useState(initialExpanded), [list, setList] = useState<InvocationTemplateList | null>(null), [selectedId, setSelectedId] = useState('');
  const [editing, setEditing] = useState<{ id?: string; revision: number; name: string; names: string[] } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const alive = useRef(true), lock = useRef(false), current = useRef({ resourceId: resource.id, revision: resource.revision, actionId: definition.id, disabled, readOnly });
  current.current = { resourceId: resource.id, revision: resource.revision, actionId: definition.id, disabled, readOnly };
  const actionRef = useRef(action); actionRef.current = action;
  const busyRef = useRef(onBusyChange); busyRef.current = onBusyChange;
  const selected = list?.templates.find(item => item.id === selectedId);
  const allowed = definition.parameters.filter(templateParameterAllowed);
  const stale = !!list && list.resourceRevision !== resource.revision;
  useEffect(() => { alive.current = true; return () => { alive.current = false; if (lock.current) busyRef.current?.(false); }; }, []);
  async function request<T>(label: string, command: string, args: Record<string, unknown>, success: (result: T) => void) {
    if (lock.current || disabled || (readOnly && command !== 'resource_templates')) return;
    lock.current = true; setBusy(true); setError(''); busyRef.current?.(true);
    const identity = { ...current.current };
    try {
      const result = await actionRef.current<T>(label, command, args);
      const now = current.current;
      if (alive.current && identity.resourceId === now.resourceId && identity.revision === now.revision && identity.actionId === now.actionId && !(now.readOnly && command !== 'resource_templates') && !now.disabled) success(result);
    } catch (cause) { if (alive.current) setError(String(cause)); }
    finally { lock.current = false; if (alive.current) { setBusy(false); busyRef.current?.(false); } }
  }
  function reload() { void request<InvocationTemplateList>('读取常用模板', 'resource_templates', { id: resource.id, actionId: definition.id }, value => { setList(value); setNotice(''); }); }
  useEffect(() => { if (expanded && !disabled && !list && !error) reload(); }, [expanded, disabled]);
  function begin(existing?: InvocationTemplate) {
    if (readOnly || disabled || busy || stale) return;
    setEditing({ ...(existing ? { id: existing.id } : {}), revision: existing?.revision || 0, name: existing?.name || '', names: [] }); setError(''); setNotice('');
  }
  function prepare() {
    if (readOnly || !selected || !selected.compatible || stale || editing) return;
    void request<PreparedTemplate>('读取模板参数', 'resource_template_prepare', { id: resource.id, actionId: definition.id, templateId: selected.id, expectedRevision: selected.revision, expectedResourceRevision: resource.revision }, value => {
      if (value.resourceRevision !== resource.revision || value.actionId !== definition.id || value.templateId !== selected.id) { setError('动作信息已变化，请重新选择并核对模板。'); return; }
      const values = Object.fromEntries(Object.entries(value.parameters).filter(([name]) => allowed.some(parameter => parameter.name === name)));
      onApply(values); setNotice('已填入参数；核对后点击执行。');
    });
  }
  function save() {
    if (readOnly || !editing || !editing.name.trim() || [...editing.name.trim()].length > 80 || stale) return;
    const values: Record<string, string | number> = {};
    for (const parameter of allowed) {
      if (!editing.names.includes(parameter.name)) continue;
      const value = parameters[parameter.name] ?? '';
      values[parameter.name] = parameter.kind === 'integer' && value !== '' ? Number(value) : value;
    }
    void request<InvocationTemplateList>('保存常用模板', 'resource_template_save', { id: resource.id, actionId: definition.id, expectedResourceRevision: resource.revision,
      ...(editing.id ? { templateId: editing.id } : {}), expectedRevision: editing.revision, name: editing.name.trim(), parameters: values }, value => {
      setList(value); setSelectedId(value.templateId || editing.id || ''); setEditing(null); setNotice('模板已保存。');
    });
  }
  function remove() {
    if (readOnly || !selected || editing) return;
    void request<InvocationTemplateList>('删除常用模板', 'resource_template_remove', { id: resource.id, actionId: definition.id, templateId: selected.id, expectedRevision: selected.revision }, value => {
      setList(value); setSelectedId(''); setNotice('模板已删除。');
    });
  }
  return <section className="invocation-templates" aria-label={`${definition.label}常用模板`} onKeyDown={event => { if (event.key === 'Enter' && (event.target as HTMLElement).matches('input,select,textarea')) { event.preventDefault(); event.stopPropagation(); } }}>
    <button className="button" type="button" aria-expanded={expanded} disabled={busy || disabled} onClick={() => setExpanded(value => !value)}>常用模板</button>
    {expanded && <div className="invocation-template-content">
      {list && <><div className="resource-detail-actions"><select aria-label="调用模板" value={selected?.id || ''} disabled={busy || !!editing} onChange={event => { setSelectedId(event.target.value); setNotice(''); }}><option value="">{list.templates.length ? '选择常用模板' : '暂无常用模板'}</option>{list.templates.map(item => <option key={item.id} value={item.id}>{item.name}{item.compatible ? '' : ' · 需重新核对'}</option>)}</select>
        {!readOnly && <><button className="button" type="button" disabled={busy || disabled || stale || !selected?.compatible || !!editing} onClick={prepare}>填入参数</button><button className="button" type="button" disabled={busy || disabled || stale || !!editing} onClick={() => begin()}>保存当前为模板</button></>}
        <button className="button" type="button" disabled={busy || disabled || !!editing} onClick={reload}>刷新模板</button></div>
        {selected && <><p className="muted">{selected.compatible ? '可套用；执行前仍需核对。' : selected.reason || '动作定义已变化，请重新核对。'} 已记录参数：{selected.parameterNames.join('、') || '无'}</p>{!readOnly && <div className="resource-detail-actions"><button className="button" type="button" disabled={busy || disabled || stale || !!editing} onClick={() => begin(selected)}>编辑模板</button><button className="button" type="button" disabled={busy || disabled || !!editing} onClick={remove}>删除模板</button></div>}</>}
      </>}
      {!list && !error && <p className="muted">正在读取模板…</p>}
      {stale && <p role="alert">工具信息已变化，请重新打开动作并核对。</p>}
      {editing && !readOnly && <div className="invocation-template-editor">
        <label>模板名称<input aria-label="模板名称" value={editing.name} disabled={busy || disabled} onChange={event => setEditing({ ...editing, name: event.target.value })} /></label>
        <p className="muted">仅保存明确勾选的参数。{editing.id ? '本次勾选会替换原模板参数。' : '未勾选时只保存调用入口。'}</p>
        {allowed.length ? allowed.map(parameter => <label className="resource-checkbox" key={parameter.name}><input type="checkbox" aria-label={`保存参数：${parameter.label}`} checked={editing.names.includes(parameter.name)} disabled={busy || disabled} onChange={event => setEditing({ ...editing, names: event.target.checked ? [...editing.names, parameter.name] : editing.names.filter(name => name !== parameter.name) })} />{parameter.label}</label>) : <p className="muted">此动作未声明可记录参数；可保存不含参数的入口模板。</p>}
        <div className="resource-detail-actions"><button className="button" type="button" disabled={busy || disabled || stale || !editing.name.trim() || [...editing.name.trim()].length > 80} onClick={save}>{editing.id ? '保存并替换模板' : '保存模板'}</button><button className="button" type="button" disabled={busy} onClick={() => { setEditing(null); setError(''); }}>取消编辑模板</button></div>
      </div>}
      {error && <div role="alert" className="resource-error">{error}{!list && <button className="button" type="button" disabled={busy || disabled} onClick={reload}>重试读取模板</button>}</div>}
      {notice && <p role="status" className="muted">{notice}</p>}
    </div>}
  </section>;
}
