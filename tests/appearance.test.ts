import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAppearance, DEFAULT_APPEARANCE, effectiveMotion, normalizeAppearance, observeMotion, revealNearest } from '../src/appearance.ts';

test('legacy and invalid settings get appearance defaults without changing saved typography', () => {
  const legacy = { uiTheme: 'eye', uiFontSize: 20, uiZoom: 125 };
  assert.deepEqual(normalizeAppearance(legacy), DEFAULT_APPEARANCE);
  assert.deepEqual(legacy, { uiTheme: 'eye', uiFontSize: 20, uiZoom: 125 });
  assert.deepEqual(normalizeAppearance({ uiAccent: 'unknown', uiDensity: 'unknown', uiMotion: 'unknown' }), DEFAULT_APPEARANCE);
  assert.deepEqual(normalizeAppearance({ uiAccent: 'teal', uiDensity: 'comfortable', uiMotion: 'none' }), { uiAccent: 'teal', uiDensity: 'comfortable', uiMotion: 'none' });
});

test('system, explicit motion, background and basic mode have unambiguous precedence', () => {
  assert.equal(effectiveMotion('system', true, true), 'none');
  assert.equal(effectiveMotion('system', false, true), 'light');
  assert.equal(effectiveMotion('light', true, true), 'light');
  assert.equal(effectiveMotion('none', false, true), 'none');
  for (const choice of ['system', 'light', 'none'] as const) {
    assert.equal(effectiveMotion(choice, false, false), 'none');
    assert.equal(effectiveMotion(choice, false, true, true), 'none');
  }
});

test('appearance changes only its root attributes and motion subscriptions clean up', () => {
  const root = { dataset: { theme: 'eye' }, style: { fontSize: '20px', zoom: '1.25' } };
  applyAppearance(root as unknown as HTMLElement, { uiAccent: 'blue', uiDensity: 'comfortable', uiMotion: 'system' });
  assert.deepEqual(root.dataset, { theme: 'eye', accent: 'blue', density: 'comfortable' });
  assert.deepEqual(root.style, { fontSize: '20px', zoom: '1.25' });
  const media = Object.assign(new EventTarget(), { matches: false });
  let focused = true;
  const doc = Object.assign(new EventTarget(), { documentElement: root, hidden: false, hasFocus: () => focused });
  const win = Object.assign(new EventTarget(), { matchMedia: () => media });
  const stop = observeMotion(doc as unknown as Document, win as unknown as Window, 'system');
  const motion = () => (root.dataset as Record<string, string>).motion;
  assert.equal(motion(), 'light');
  media.matches = true; media.dispatchEvent(new Event('change'));
  assert.equal(motion(), 'none');
  media.matches = false; media.dispatchEvent(new Event('change'));
  assert.equal(motion(), 'light');
  focused = false; win.dispatchEvent(new Event('blur'));
  assert.equal(motion(), 'none');
  focused = true; win.dispatchEvent(new Event('focus'));
  assert.equal(motion(), 'light');
  doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(motion(), 'none');
  stop();
  doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange')); win.dispatchEvent(new Event('focus'));
  assert.equal(motion(), 'none', 'unmounted settings must not leave active window listeners');
});

test('revealing a target uses the current motion of its own window on each invocation', () => {
  const dataset: { motion?: string } = {};
  const calls: ScrollIntoViewOptions[] = [];
  const element = {
    ownerDocument: { documentElement: { dataset } },
    scrollIntoView: (options: ScrollIntoViewOptions) => calls.push(options),
  } as unknown as Element;
  revealNearest(null);
  revealNearest(element);
  dataset.motion = effectiveMotion('light', true, true);
  revealNearest(element);
  dataset.motion = effectiveMotion('system', true, true);
  revealNearest(element);
  assert.deepEqual(calls, [
    { block: 'nearest', behavior: 'instant' },
    { block: 'nearest', behavior: 'smooth' },
    { block: 'nearest', behavior: 'instant' },
  ]);
});
