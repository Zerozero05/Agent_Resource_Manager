type ClockSample = { wall: number; monotonic: number; offset: number; zone: string };
type ClockObserver = { listeners: Set<() => void>; stop: () => void };

const observers = new WeakMap<Document, ClockObserver>();
const CHECK_INTERVAL_MS = 60_000;

function sample(win: Window): ClockSample {
  const wall = Date.now();
  return { wall, monotonic: win.performance.now(), offset: new Date(wall).getTimezoneOffset(), zone: new Intl.DateTimeFormat().resolvedOptions().timeZone };
}

// Boundary timers handle ordinary time progression. This shared, visible-window
// observer only reports an independent wall-clock/time-zone change; it never reads state.
export function observeMaintenanceClock(doc: Document, win: Window, onChange: () => void): () => void {
  let observer = observers.get(doc);
  if (!observer) {
    const listeners = new Set<() => void>();
    let timer: number | undefined, previous = sample(win), stopped = false;
    const cancel = () => { if (timer !== undefined) win.clearTimeout(timer); timer = undefined; };
    const schedule = () => { if (!stopped && !doc.hidden && timer === undefined) timer = win.setTimeout(check, CHECK_INTERVAL_MS); };
    const check = () => {
      timer = undefined;
      if (stopped || doc.hidden) return;
      const current = sample(win);
      const changed = Math.abs((current.wall - previous.wall) - (current.monotonic - previous.monotonic)) >= 1000
        || current.offset !== previous.offset || current.zone !== previous.zone;
      previous = current;
      if (changed) for (const listener of [...listeners]) listener();
      schedule();
    };
    // Existing focus/visibility handlers immediately reconcile the settings.
    // Reset this detector too, without producing a duplicate backend read.
    const reschedule = () => { cancel(); previous = sample(win); schedule(); };
    doc.addEventListener('visibilitychange', reschedule);
    win.addEventListener('focus', reschedule);
    observer = { listeners, stop: () => { stopped = true; cancel(); doc.removeEventListener('visibilitychange', reschedule); win.removeEventListener('focus', reschedule); } };
    observers.set(doc, observer);
    schedule();
  }
  const listener = () => onChange();
  const currentObserver = observer;
  let subscribed = true;
  currentObserver.listeners.add(listener);
  return () => {
    if (!subscribed) return;
    subscribed = false;
    currentObserver.listeners.delete(listener);
    if (!currentObserver.listeners.size) { currentObserver.stop(); observers.delete(doc); }
  };
}
