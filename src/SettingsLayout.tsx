import { Children, createContext, isValidElement, useContext, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react';
import { ChevronDown } from 'lucide-react';
import { outlineId } from './workspace';
import './settings.css';

type SectionProps = { sectionKey: string; title: string; children: ReactNode };
const SettingsContext = createContext<{ paneId: string; activeSection: string } | null>(null);
const originalLabels: Record<string, string> = { general: '使用偏好', display: '显示', storage: '保存位置', network: '网络', github: 'GitHub', maintenance: '自动维护', scenes: '场景' };
const panelId = (paneId: string, key: string) => `settings-${encodeURIComponent(paneId)}-${encodeURIComponent(key)}`;

/** One functional group at a time, using the existing Home scroller. */
export function SettingsLayout({ paneId, scopeRef, expanded, onExpandedChange, activeSection, onActiveSectionChange, children }: {
  paneId: string; scopeRef: RefObject<HTMLElement | null>; expanded: boolean;
  onExpandedChange: (expanded: boolean) => void; activeSection?: string;
  onActiveSectionChange?: (section: string) => void; children: ReactNode;
}) {
  const sections = Children.toArray(children).filter(child => isValidElement<SectionProps>(child) && child.type === SettingsSection).map(child => (child as ReactElement<SectionProps>).props);
  const [localSection, setLocalSection] = useState(sections[0]?.sectionKey || 'general');
  const requested = activeSection ?? localSection;
  const selected = sections.some(section => section.sectionKey === requested) ? requested : sections[0]?.sectionKey || 'general';
  const current = sections.find(section => section.sectionKey === selected);
  const [narrow, setNarrow] = useState(false);
  const shell = useRef<HTMLElement>(null), navigation = useRef<HTMLElement>(null), controls = useRef<HTMLElement>(null), toggle = useRef<HTMLButtonElement>(null);
  const navigationId = useId(), scrollPositions = useRef(new Map<string, number>()), previousSection = useRef(selected);

  useLayoutEffect(() => {
    const root = shell.current, nav = navigation.current, header = controls.current;
    const scroll = scopeRef.current?.querySelector<HTMLElement>('[data-pane-scroll]') || scopeRef.current;
    if (!root || !nav || !header || !scroll) return;
    let frame = 0;
    const measure = () => {
      const padding = Number.parseFloat(getComputedStyle(scroll).paddingTop) || 0;
      root.style.setProperty('--settings-scroll-padding', `${padding}px`);
      root.style.setProperty('--settings-navigation-height', `${header.offsetHeight}px`);
      root.dataset.navigationFits = String(nav.offsetHeight + header.offsetHeight + 16 <= scroll.clientHeight - padding * 2);
      if (root.clientWidth > 0) setNarrow(root.clientWidth < 720);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule); resize.observe(scroll); resize.observe(nav); resize.observe(header);
    const appearance = new MutationObserver(schedule);
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] });
    measure();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); appearance.disconnect(); };
  }, [scopeRef]);

  useLayoutEffect(() => {
    const scroll = scopeRef.current?.querySelector<HTMLElement>('[data-pane-scroll]') || scopeRef.current;
    if (!scroll) return;
    if (previousSection.current !== selected) scroll.scrollTop = scrollPositions.current.get(selected) || 0;
    previousSection.current = selected;
    const remember = () => scrollPositions.current.set(selected, scroll.scrollTop);
    scroll.addEventListener('scroll', remember, { passive: true });
    return () => scroll.removeEventListener('scroll', remember);
  }, [scopeRef, selected]);

  function activate(key: string) {
    const scroll = scopeRef.current?.querySelector<HTMLElement>('[data-pane-scroll]') || scopeRef.current;
    if (scroll) scrollPositions.current.set(selected, scroll.scrollTop);
    setLocalSection(key); onActiveSectionChange?.(key);
    if (narrow) { onExpandedChange(false); toggle.current?.focus({ preventScroll: true }); }
  }

  return <SettingsContext.Provider value={{ paneId, activeSection: selected }}>
    <section ref={shell} className="settings-shell" data-narrow={narrow || undefined} data-expanded={expanded} aria-label="偏好设置">
      <header ref={controls} className="settings-navigation-heading" data-pane-sticky><button ref={toggle} type="button" className="settings-navigation-toggle" aria-label={`设置分类：${current?.title || '设置'}`} title={expanded ? '收起设置分类' : '展开设置分类'} aria-expanded={expanded} aria-controls={navigationId} onClick={() => onExpandedChange(!expanded)}><span>{current?.title || '设置分类'}</span><ChevronDown size={15} aria-hidden="true" /></button></header>
      <aside ref={navigation} className="settings-navigation" hidden={!expanded}>
        <nav id={navigationId} className="settings-navigation-items" aria-label="设置分类" hidden={!expanded} inert={!expanded} onKeyDown={event => { if (event.key === 'Escape' && narrow && expanded) { event.preventDefault(); event.stopPropagation(); onExpandedChange(false); toggle.current?.focus(); } }}>
          {sections.map(section => <button type="button" key={section.sectionKey} aria-current={selected === section.sectionKey ? 'page' : undefined} aria-controls={panelId(paneId, section.sectionKey)} onClick={() => activate(section.sectionKey)}>{section.title}</button>)}
        </nav>
      </aside>
      <div className="settings-content">{children}</div>
    </section>
  </SettingsContext.Provider>;
}

export function SettingsSection({ sectionKey, title, children }: SectionProps) {
  const context = useContext(SettingsContext), section = useRef<HTMLElement>(null);
  const [needsHeading, setNeedsHeading] = useState(false);
  const paneId = context?.paneId || 'settings', active = !context || context.activeSection === sectionKey;
  const [visited, setVisited] = useState(active);
  useLayoutEffect(() => { if (active) setVisited(true); }, [active]);
  const headingId = outlineId(`${paneId}:settings`, originalLabels[sectionKey] || title, 0, `settings:${sectionKey}`);
  useLayoutEffect(() => {
    const decorate = () => {
      const root = section.current;
      if (!root) return;
      const contentHeading = root.querySelector<HTMLElement>('h2:not([data-settings-fallback]),h3');
      const fallback = root.querySelector<HTMLElement>('[data-settings-fallback]');
      setNeedsHeading(!contentHeading);
      const heading = contentHeading || fallback;
      if (!heading) return;
      if (contentHeading && fallback) { fallback.removeAttribute('id'); fallback.removeAttribute('data-outline-key'); }
      heading.dataset.outlineKey = `settings:${sectionKey}`;
      heading.dataset.outlineLabel = title;
      heading.dataset.outlineLevel = '1';
      for (const node of root.querySelectorAll<HTMLElement>('[data-outline-key]')) {
        const key = node.dataset.outlineKey!;
        const id = node === heading ? headingId : outlineId(`${paneId}:settings`, node.dataset.outlineLabel || node.textContent?.trim() || title, 0, key);
        if (node.id && node.id !== id && !node.id.startsWith(`pane-${encodeURIComponent(`${paneId}:settings`)}-`) && !node.dataset.workspaceOriginalId) node.dataset.workspaceOriginalId = node.id;
        node.id = id;
      }
      for (const card of root.querySelectorAll<HTMLElement>('.card,.panel')) card.dataset.outlineScrollStart = '';
    };
    decorate(); const observer = new MutationObserver(decorate);
    if (section.current) observer.observe(section.current, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [sectionKey, title, headingId, paneId]);
  return <section ref={section} id={panelId(paneId, sectionKey)} className="settings-section" data-settings-section={sectionKey} aria-labelledby={headingId} hidden={!active} inert={!active} aria-hidden={!active || undefined}>{needsHeading && <h2 className="settings-section-title" data-settings-fallback>{title}</h2>}{(active || visited) && children}</section>;
}
