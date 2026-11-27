export type UiAccent = 'violet' | 'blue' | 'teal' | 'rose';
export type UiDensity = 'compact' | 'comfortable';
export type UiMotion = 'system' | 'light' | 'none';
export type Appearance = { uiAccent: UiAccent; uiDensity: UiDensity; uiMotion: UiMotion };

export const ACCENTS: { id: UiAccent; label: string; swatch: string }[] = [
  { id: 'violet', label: '鸢尾紫', swatch: '#553486' },
  { id: 'blue', label: '湖蓝', swatch: '#244c85' },
  { id: 'teal', label: '青绿', swatch: '#155648' },
  { id: 'rose', label: '玫瑰', swatch: '#83334e' },
];
export const DEFAULT_APPEARANCE: Appearance = { uiAccent: 'violet', uiDensity: 'compact', uiMotion: 'system' };

// Old settings need no migration. Invalid values use the same defaults as a new install.
export function normalizeAppearance(value: { uiAccent?: unknown; uiDensity?: unknown; uiMotion?: unknown } = {}): Appearance {
  return {
    uiAccent: ACCENTS.some(accent => accent.id === value.uiAccent) ? value.uiAccent as UiAccent : DEFAULT_APPEARANCE.uiAccent,
    uiDensity: value.uiDensity === 'comfortable' ? 'comfortable' : 'compact',
    uiMotion: value.uiMotion === 'light' || value.uiMotion === 'none' ? value.uiMotion : 'system',
  };
}

export function effectiveMotion(choice: UiMotion, reduced: boolean, foreground: boolean, basicMode = false): 'light' | 'none' {
  return basicMode || !foreground || choice === 'none' || choice === 'system' && reduced ? 'none' : 'light';
}

export function applyAppearance(root: HTMLElement, value: Appearance) {
  root.dataset.accent = value.uiAccent;
  root.dataset.density = value.uiDensity;
}

export function revealNearest(element: Element | null | undefined) {
  if (!element) return;
  const motion = element.ownerDocument.documentElement.dataset.motion;
  element.scrollIntoView({ block: 'nearest', behavior: motion === 'light' ? 'smooth' : 'instant' });
}

// One subscription per window; no polling or per-resource animation work.
export function observeMotion(doc: Document, win: Window, choice: UiMotion): () => void {
  const query = win.matchMedia('(prefers-reduced-motion: reduce)');
  const refresh = () => {
    doc.documentElement.dataset.motion = effectiveMotion(choice, query.matches, !doc.hidden && doc.hasFocus(), doc.documentElement.dataset.basicMode === 'true');
  };
  query.addEventListener('change', refresh);
  doc.addEventListener('visibilitychange', refresh);
  win.addEventListener('focus', refresh);
  win.addEventListener('blur', refresh);
  refresh();
  return () => {
    query.removeEventListener('change', refresh);
    doc.removeEventListener('visibilitychange', refresh);
    win.removeEventListener('focus', refresh);
    win.removeEventListener('blur', refresh);
  };
}
