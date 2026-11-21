import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';

assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.equal(process.env.ImageOS, 'win25-vs2026');
assert.equal(process.env.ImageVersion, '20261116.315.1');
const port = Number(process.argv[2]);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);

// The driver has already checked the loopback listener and the exact owned WebView process.
const response = await fetch(`http://127.0.0.1:${port}/json/list`, { redirect: 'error', signal: AbortSignal.timeout(1500) });
assert.ok(response.ok);
const pages = (await response.json()).filter(page => page.type === 'page');
assert.equal(pages.length, 1);
const page = new URL(pages[0].url);
const url = new URL(pages[0].webSocketDebuggerUrl);
assert.ok((['http:', 'https:'].includes(page.protocol) && page.hostname === 'tauri.localhost') ||
  (page.protocol === 'tauri:' && page.hostname === 'localhost'));
assert.equal(url.protocol, 'ws:');
assert.equal(url.hostname, '127.0.0.1');
assert.equal(Number(url.port), port);
assert.ok(url.pathname.startsWith('/devtools/page/'));

// The only CDP operation is this fixed expression. It never mutates the app or emulates a media feature.
const expression = `(() => {
  const root = document.documentElement;
  const select = document.querySelectorAll('select[aria-label="动效"]');
  return {
    preference: select.length === 1 ? select[0].value : null,
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    focused: document.hasFocus(),
    visibility: document.visibilityState,
    motion: root.dataset.motion ?? null,
    basic: root.dataset.basicMode ?? null,
    duration: getComputedStyle(root).getPropertyValue('--motion-duration').trim(),
  };
})()`;

const socket = new WebSocket(url);
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned CDP open timeout')), 3000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Owned CDP connection failed')); }, { once: true });
  });
  const requests = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let id = 0;
  console.log(JSON.stringify({ attached: true, target: pages[0].id }));
  for await (const request of requests) {
    if (request === 'close') break;
    assert.equal(request, 'snapshot');
    id += 1;
    const value = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.removeEventListener('message', onMessage);
        reject(new Error('Read-only motion snapshot timed out'));
      }, 3000);
      function onMessage(event) {
        const message = JSON.parse(event.data);
        if (message.id !== id) return;
        socket.removeEventListener('message', onMessage);
        clearTimeout(timer);
        if (message.error || message.result?.exceptionDetails) reject(new Error('Read-only motion expression failed'));
        else resolve(message.result.result.value);
      }
      socket.addEventListener('message', onMessage);
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
    console.log(JSON.stringify(value));
  }
  requests.close();
} finally {
  socket.close();
}
