import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Redo2, Undo2 } from 'lucide-react';

export type ManagementHistoryEntry = { available: boolean; label?: string; entryId?: string };
export type ManagementHistoryDirection = 'undo' | 'redo';
type Options = {
  undo?: ManagementHistoryEntry;
  redo?: ManagementHistoryEntry;
  active: boolean;
  shortcutActive?: boolean;
  readOnly: boolean;
  busy: boolean;
  modal: boolean;
  canApply: () => boolean;
  onApply: (direction: ManagementHistoryDirection, entryId: string, label: string) => Promise<void>;
};

export function useManagementHistory(options: Options) {
  const latest = useRef(options); latest.current = options;
  const lock = useRef(false), mounted = useRef(true);
  const [pending, setPending] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const allowed = useCallback((direction: ManagementHistoryDirection) => {
    const value = latest.current, entry = value[direction];
    return !lock.current && value.active && !value.readOnly && !value.busy && !value.modal
      && !document.querySelector('[aria-modal="true"]') && value.canApply() && entry?.available && !!entry.entryId;
  }, []);
  const apply = useCallback(async (direction: ManagementHistoryDirection, entryId?: string) => {
    if (!allowed(direction)) return;
    const value = latest.current, entry = value[direction]!;
    if (!entryId || entryId !== entry.entryId) return;
    lock.current = true; setPending(true);
    try { await value.onApply(direction, entryId, entry.label || '管理操作'); }
    finally { lock.current = false; if (mounted.current) setPending(false); }
  }, [allowed]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!(latest.current.shortcutActive ?? latest.current.active)) return;
      if (!event.ctrlKey || event.altKey || event.metaKey || event.isComposing || event.repeat || event.defaultPrevented) return;
      const key = event.key.toLowerCase();
      const direction = key === 'z' ? event.shiftKey ? 'redo' : 'undo' : key === 'y' && !event.shiftKey ? 'redo' : null;
      if (!direction || !allowed(direction)) return;
      const target = event.target instanceof Element ? event.target : document.activeElement;
      if (target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')) return;
      event.preventDefault(); void apply(direction, latest.current[direction]!.entryId);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [allowed, apply]);
  return { undo: options.undo, redo: options.redo, apply, disabled: pending || !options.active || options.readOnly || options.busy || options.modal };
}

export function ManagementHistoryControls({ history }: { history: ReturnType<typeof useManagementHistory> }) {
  const prefix = useId();
  return <div className="management-history" role="group" aria-label="管理操作历史">
    {(['undo', 'redo'] as const).map(direction => {
      const entry = history[direction], verb = direction === 'undo' ? '撤销' : '重做', Icon = direction === 'undo' ? Undo2 : Redo2;
      const available = entry?.available && !!entry.entryId;
      const label = available ? entry.label || '管理操作' : '暂无记录';
      const keys = direction === 'undo' ? 'Ctrl+Z' : 'Ctrl+Y / Ctrl+Shift+Z';
      return <button key={direction} type="button" className="button ghost management-history-action" aria-label={`${verb}管理操作`} aria-describedby={available ? `${prefix}-${direction}` : undefined} title={available ? `${verb}${label} (${keys})` : `暂无可${verb}的管理操作`} disabled={history.disabled || !available} onClick={() => void history.apply(direction, entry?.entryId)}>
        <Icon size={14} /><span><strong>{verb}</strong>{available && <small id={`${prefix}-${direction}`}>{label}</small>}</span>
      </button>;
    })}
  </div>;
}
