import { createContext, useContext, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ChevronDown } from 'lucide-react';
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, type SettingsSectionKey } from './settings-sections.ts';
import { outlineId } from './workspace';
import './settings.css';

type SectionProps = { sectionKey: SettingsSectionKey; children: ReactNode };
const SettingsContext = createContext<{ paneId: string; activeSection: SettingsSectionKey } | null>(null);
const panelId = (paneId: string, key: SettingsSectionKey) => `settings-${encodeURIComponent(paneId)}-${encodeURIComponent(key)}`;

/** One functional group at a time, using the existing Home scroller. */
export function SettingsLayout({ paneId, scopeRef, expanded, onExpandedChange, activeSection, onActiveSectionChange, children }: {
  paneId: string; scopeRef: RefObject<HTMLElement | null>; expanded: boolean;
  onExpandedChange: (expanded: boolean) => void; activeSection: SettingsSectionKey;
  onActiveSectionChange: (section: SettingsSectionKey) => void; children: ReactNode;
}) {
  const current = SETTINGS_SECTIONS[activeSection];
  const [narrow, setNarrow] = useState(false);
  const shell = useRef<HTMLElement>(null), navigation = useRef<HTMLElement>(null), controls = useRef<HTMLElement>(null), toggle = useRef<HTMLButtonElement>(null);
  const navigationId = useId(), scrollPositions = useRef(new Map<SettingsSectionKey, number>()), previousSection = useRef(activeSection);

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
    if (previousSection.current !== activeSection) scroll.scrollTop = scrollPositions.current.get(activeSection) || 0;
    previousSection.current = activeSection;
    const remember = () => scrollPositions.current.set(activeSection, scroll.scrollTop);
    scroll.addEventListener('scroll', remember, { passive: true });
    return () => scroll.removeEventListener('scroll', remember);
  }, [scopeRef, activeSection]);

  function activate(key: SettingsSectionKey) {
    const scroll = scopeRef.current?.querySelector<HTMLElement>('[data-pane-scroll]') || scopeRef.current;
    if (scroll) scrollPositions.current.set(activeSection, scroll.scrollTop);
    onActiveSectionChange(key);
    if (narrow) { onExpandedChange(false); toggle.current?.focus({ preventScroll: true }); }
  }

  return <SettingsContext.Provider value={{ paneId, activeSection }}>
    <section ref={shell} className="settings-shell" data-narrow={narrow || undefined} data-expanded={expanded} aria-label="偏好设置">
      <header ref={controls} className="settings-navigation-heading" data-pane-sticky><button ref={toggle} type="button" className="settings-navigation-toggle" aria-label={`设置分类：${current.title}`} title={expanded ? '收起设置分类' : '展开设置分类'} aria-expanded={expanded} aria-controls={navigationId} onClick={() => onExpandedChange(!expanded)}><span>{current.title}</span><ChevronDown size={15} aria-hidden="true" /></button></header>
      <aside ref={navigation} className="settings-navigation" hidden={!expanded}>
        <nav id={navigationId} className="settings-navigation-items" aria-label="设置分类" hidden={!expanded} inert={!expanded} onKeyDown={event => { if (event.key === 'Escape' && narrow && expanded) { event.preventDefault(); event.stopPropagation(); onExpandedChange(false); toggle.current?.focus(); } }}>
          {SETTINGS_GROUPS.map(group => <div className="settings-navigation-group" role="group" aria-label={group.title} key={group.title}>
            <span className="settings-navigation-group-title" aria-hidden="true">{group.title}</span>
            {group.sections.map(key => <button type="button" key={key} aria-current={activeSection === key ? 'page' : undefined} aria-controls={panelId(paneId, key)} onClick={() => activate(key)}>{SETTINGS_SECTIONS[key].title}</button>)}
          </div>)}
        </nav>
      </aside>
      <div className="settings-content">{children}</div>
    </section>
  </SettingsContext.Provider>;
}

export function SettingsSection({ sectionKey, children }: SectionProps) {
  const setting = SETTINGS_SECTIONS[sectionKey], { title } = setting;
  const context = useContext(SettingsContext), section = useRef<HTMLElement>(null);
  const [needsHeading, setNeedsHeading] = useState(false);
  const paneId = context?.paneId || 'settings', active = !context || context.activeSection === sectionKey;
  const [visited, setVisited] = useState(active);
  useLayoutEffect(() => { if (active) setVisited(true); }, [active]);
  const headingId = outlineId(`${paneId}:settings`, 'anchorLabel' in setting ? setting.anchorLabel : title, 0, `settings:${sectionKey}`);
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
