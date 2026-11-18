import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, X } from 'lucide-react';
import { commandShortcut, queryCommands, type Command } from './commands';
import './command-palette.css';

export function CommandPalette({ commands, active = true, loading = false, notice = '', onOpen, onOpenChange, onChoose }: {
  commands: readonly Command[] | (() => readonly Command[]); active?: boolean; loading?: boolean; notice?: string;
  onOpen?: () => void; onOpenChange?: (open: boolean) => void; onChoose: (command: Command) => void;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const input = useRef<HTMLInputElement>(null), panel = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null), composing = useRef(false);
  const activeRef = useRef(active); activeRef.current = active;
  const callbacks = useRef({ onOpen, onOpenChange, onChoose }); callbacks.current = { onOpen, onOpenChange, onChoose };
  const id = useId(), titleId = `${id}:title`, listId = `${id}:results`;
  const showing = active && open;
  const commandList = useMemo(() => {
    if (!showing) return undefined;
    return typeof commands === 'function' ? commands() : commands;
  }, [commands, showing]);
  const matches = useMemo(() => commandList ? queryCommands(commandList, query) : [], [commandList, query]);
  const visible = matches.slice(0, 60);
  const current = visible.find(command => command.id === selected) || visible[0];
  const currentIndex = current ? visible.indexOf(current) : -1;
  function show() { previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setQuery(''); setSelected(''); setOpen(true); callbacks.current.onOpen?.(); }
  function choose(command: Command) {
    if (!activeRef.current || command.disabledReason) return;
    setOpen(false); callbacks.current.onChoose(command);
  }
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  useEffect(() => { callbacks.current.onOpenChange?.(open); }, [open]);
  useEffect(() => {
    if (!active) return;
    const shortcut = (event: KeyboardEvent) => {
      if (!commandShortcut(event)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('textarea,[contenteditable]:not([contenteditable="false"]),input[type="password"],[data-command-shortcut="ignore"]')) return;
      if (!open && [...document.querySelectorAll('[aria-modal="true"]')].some(node => !node.closest('[hidden],[inert]'))) return;
      event.preventDefault();
      if (open) setOpen(false); else show();
    };
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  }, [active, open]);
  useLayoutEffect(() => {
    if (!open) return;
    composing.current = false; input.current?.focus({ preventScroll: true });
    return () => {
      if (!activeRef.current) return;
      const origin = previousFocus.current;
      if (origin?.isConnected && !origin.closest('[hidden],[inert]') && origin.getClientRects().length && getComputedStyle(origin).visibility !== 'hidden') origin.focus({ preventScroll: true });
      else if (trigger.current?.isConnected && trigger.current.getClientRects().length) trigger.current.focus({ preventScroll: true });
    };
  }, [open]);
  useEffect(() => {
    if (open && currentIndex >= 0) panel.current?.querySelector<HTMLElement>(`[data-command-index="${currentIndex}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, current?.id, currentIndex]);
  const popup = showing && <div className="command-palette-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
    <div className="command-palette" ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={event => {
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
      if (event.key === 'Tab') {
        const nodes = [...(panel.current?.querySelectorAll<HTMLElement>('input,button:not(:disabled)') || [])];
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="command-palette-heading"><h2 id={titleId}>快捷入口</h2><button className="command-palette-close" aria-label="关闭快捷入口" onClick={() => setOpen(false)}><X size={18} /></button></div>
      <label className="command-palette-search"><Search size={19} aria-hidden="true" /><input ref={input} value={query} placeholder="搜索资源、动作、能力或设置…" aria-label="搜索资源、动作、能力或设置" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-activedescendant={current ? `${id}:option:${currentIndex}` : undefined} autoComplete="off" spellCheck={false}
        onChange={event => { setQuery(event.target.value); setSelected(''); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => {
          if (event.defaultPrevented || (event.repeat && event.key === 'Enter') || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); if (visible.length) setSelected(visible[(currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length].id); }
          else if (event.key === 'Enter' && current) { event.preventDefault(); event.stopPropagation(); choose(current); }
        }} /></label>
      <div className="command-palette-status" role="status">{notice || (loading ? '正在读取工具目录；已有内容可继续搜索' : `${matches.length} 个入口`)}{matches.length > visible.length && ' · 显示前60项，请输入关键词缩小范围'}</div>
      <div className="command-palette-results" role="listbox" aria-label="快捷入口结果" id={listId}>
        {visible.map((command, index) => <div key={command.id} id={`${id}:option:${index}`} role="option" aria-selected={command.id === current?.id} aria-disabled={command.disabledReason ? true : undefined} className={`command-palette-option${command.id === current?.id ? ' selected' : ''}`} data-command-index={index} onPointerMove={() => setSelected(command.id)} onMouseDown={event => event.preventDefault()} onClick={() => choose(command)}><span className="command-palette-label">{command.label}</span><span className="command-palette-detail">{command.detail}</span>{command.disabledReason && <span className="command-palette-disabled-reason">{command.disabledReason}</span>}</div>)}
        {!visible.length && <p className="command-palette-empty">没有匹配的入口，请尝试资源名称、动作、别名、能力或设置名称。</p>}
      </div>
      <footer className="command-palette-footer"><span>↑ ↓ 选择 · Enter 打开 · Esc 关闭</span><span>动作需核对参数后执行</span></footer>
    </div>
  </div>;
  return <><button ref={trigger} type="button" className="command-palette-trigger" onClick={show} disabled={!active} title="快捷入口（Ctrl＋K）" aria-label="打开快捷入口" aria-keyshortcuts="Control+K"><Search size={16} /><span>快捷入口</span><kbd>Ctrl K</kbd></button>{popup && createPortal(popup, document.body)}</>;
}
