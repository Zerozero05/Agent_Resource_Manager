import { Component, type ReactNode, type RefObject } from 'react';
import { nearestSurvivingId } from './library-reading';
import { paneScrollScale } from './workspace';

export type LibraryReadingBoundaryProps = {
  root: RefObject<HTMLElement | null>; scope: string; items: readonly { id: string }[]; children: ReactNode;
};
type ReadingSnapshot = {
  scroller: HTMLElement; previousIds: string[];
  anchor: { id: string; offset: number } | null;
  focus: { id: string; node: HTMLElement } | null;
};

/** Capture before React mutates rows; user navigation scopes never restore an older position. */
export class LibraryReadingBoundary extends Component<LibraryReadingBoundaryProps, object, ReadingSnapshot | null> {
  getSnapshotBeforeUpdate(previous: LibraryReadingBoundaryProps): ReadingSnapshot | null {
    if (previous.scope !== this.props.scope || previous.items === this.props.items) return null;
    const panel = this.props.root.current?.querySelector<HTMLElement>('.library-panel');
    const scroller = panel?.closest<HTMLElement>('[data-pane-scroll]');
    if (!panel || !scroller) return null;
    const rows = [...panel.querySelectorAll<HTMLElement>('[data-skill-id]')];
    const viewport = scroller.getBoundingClientRect();
    const firstVisible = rows.find(row => { const rect = row.getBoundingClientRect(); return rect.bottom > viewport.top && rect.top < viewport.bottom; });
    const active = panel.ownerDocument.activeElement as HTMLElement | null;
    const focusedRow = active?.closest<HTMLElement>('[data-skill-id]');
    return {
      scroller, previousIds: previous.items.map(item => item.id),
      anchor: firstVisible ? { id: firstVisible.dataset.skillId!, offset: firstVisible.getBoundingClientRect().top - viewport.top } : null,
      focus: active && focusedRow && panel.contains(focusedRow) ? { id: focusedRow.dataset.skillId!, node: active } : null,
    };
  }

  componentDidUpdate(_previous: LibraryReadingBoundaryProps, _state: object, snapshot: ReadingSnapshot | null) {
    if (!snapshot) return;
    const root = this.props.root.current, panel = root?.querySelector<HTMLElement>('.library-panel');
    if (!root || !panel || !snapshot.scroller.isConnected || !root.contains(snapshot.scroller)) return;
    const rows = new Map([...panel.querySelectorAll<HTMLElement>('[data-skill-id]')].map(row => [row.dataset.skillId!, row]));
    const currentIds = this.props.items.map(item => item.id).filter(id => rows.has(id));
    if (snapshot.anchor) {
      const id = nearestSurvivingId(snapshot.previousIds, currentIds, snapshot.anchor.id), row = rows.get(id);
      if (row) {
        const viewport = snapshot.scroller.getBoundingClientRect();
        const scale = paneScrollScale(viewport.height, snapshot.scroller.offsetHeight);
        const delta = (row.getBoundingClientRect().top - viewport.top - snapshot.anchor.offset) / scale;
        if (delta) snapshot.scroller.scrollTop = Math.max(0, Math.min(snapshot.scroller.scrollHeight - snapshot.scroller.clientHeight, snapshot.scroller.scrollTop + delta));
      }
    }
    if (snapshot.focus && !snapshot.focus.node.isConnected) {
      const document = root.ownerDocument, active = document.activeElement;
      // Another control may intentionally receive focus during this same commit.
      if (active && active !== document.body && active !== document.documentElement && active.isConnected) return;
      const id = nearestSurvivingId(snapshot.previousIds, currentIds, snapshot.focus.id);
      const target = rows.get(id) || panel.querySelector<HTMLElement>('input[aria-label="搜索 Skill"]');
      if (target) {
        if (!target.hasAttribute('tabindex') && !target.matches('input,button,select,textarea,a[href]')) target.tabIndex = -1;
        target.focus({ preventScroll: true });
      }
    }
  }

  render() { return <>{this.props.children}</>; }
}
