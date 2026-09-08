import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const extension = new URL('../../../../default/chromium/extensions/theme-sync/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', extension), 'utf8'));
const scripts = Object.fromEntries(['background', 'content', 'page-api'].map((name) =>
  [name, readFileSync(new URL(name === 'background' ? manifest.background.service_worker : `${name}.js`, extension), 'utf8')]));
const colors = { background: '#112233', foreground: '#ddeeff', accent: '#445566' };
const url = 'https://wallpapers.hel1.your-objectstorage.com/test.png';

function bridge() {
  const document = new EventTarget();
  document.documentElement = { style: { length: 0 }, dataset: {} };
  const window = {};
  const handlers = [], nativeHandlers = [], posts = [], runtimeMessages = [], fetches = [];
  const timers = new Map();
  let timerId = 0;
  const globals = {
    Event, CustomEvent, URL, Uint8Array, AbortController, btoa,
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  const storage = { local: { get: async () => ({}), set: async () => {} } };
  const sender = { origin: 'https://omarchy.org', frameId: 0 };
  const port = {
    onMessage: { addListener: (handler) => nativeHandlers.push(handler) },
    onDisconnect: { addListener: () => {} },
    postMessage: (message) => posts.push(JSON.parse(JSON.stringify(message))),
  };
  vm.runInNewContext(scripts.background, {
    ...globals,
    fetch: async (source, options) => {
      fetches.push({ source, options });
      return new Response(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), { headers: { 'content-type': 'image/png' } });
    },
    chrome: {
      runtime: {
        connectNative: () => port,
        onMessage: { addListener: (handler) => handlers.push(handler) },
        onStartup: { addListener: () => {} }, onInstalled: { addListener: () => {} },
      },
      storage, tabs: { query: (_query, callback) => callback([]), sendMessage: () => {} },
    },
  });
  vm.runInNewContext(scripts.content, {
    ...globals, document,
    chrome: {
      storage,
      runtime: {
        onMessage: { addListener: () => {} },
        sendMessage: (message, callback) => {
          // Chromium uses JSON serialization, so undefined optional fields disappear.
          const serialized = JSON.parse(JSON.stringify(message));
          runtimeMessages.push(serialized);
          for (const handler of handlers) handler(serialized, sender, callback);
        },
      },
    },
  });
  vm.runInNewContext(scripts['page-api'], { ...globals, document, window });
  return {
    api: window.omarchy, document, posts, runtimeMessages, fetches, timers,
    finish: () => {
      const last = posts.at(-1);
      assert.ok(last, 'install request reached the native transport');
      for (const handler of nativeHandlers) handler({ type: 'theme-result', id: last.id, ok: true, name: last.name, error: '' });
    },
  };
}

test('the real page API and content bridge preserve every supported installation field', async () => {
  const b = bridge();
  const spec = { name: 'Bridge', colors, backgroundUrls: [url, url + '?second'],
    mode: 'light', iconsTheme: 'Yaru-blue', previewUrl: url + '?preview',
    previewUnlockUrl: url + '?preview-unlock', unlockUrl: url + '?unlock' };
  const request = b.api.installTheme(spec);
  await new Promise(setImmediate);
  assert.deepEqual(b.runtimeMessages.find((message) => message.type === 'omarchy-install-theme'), {
    type: 'omarchy-install-theme', ...spec,
  });
  const payload = b.posts[0];
  assert.equal(payload.backgrounds.length, 2);
  assert.equal(payload.mode, spec.mode);
  assert.equal(payload.iconsTheme, spec.iconsTheme);
  for (const field of ['preview', 'previewUnlock', 'unlock']) assert.ok(payload[field]);
  assert.equal(Object.hasOwn(payload, 'background'), false);
  assert.equal(b.fetches.length, 5);
  b.finish();
  assert.equal((await request).ok, true);
  assert.equal(b.timers.size, 0);
});

for (const spec of [{ name: 'Legacy', colors, backgroundUrl: url }, { name: 'Palette', colors }]) {
  test(`the real bridge retains ${spec.backgroundUrl ? 'legacy backgroundUrl' : 'palette-only'} support`, async () => {
    const b = bridge();
    const request = b.api.installTheme(spec);
    await new Promise(setImmediate);
    assert.equal(b.posts[0].backgrounds.length, spec.backgroundUrl ? 1 : 0);
    b.finish();
    assert.equal((await request).ok, true);
    assert.equal(b.timers.size, 0);
  });
}

test('unsupported file maps are refused by both the public API and direct DOM bridge', async () => {
  const b = bridge();
  assert.equal((await b.api.installTheme({ name: 'Unsafe', colors, files: { 'hyprland.lua': 'code' } })).ok, false);
  let result;
  b.document.addEventListener('__omarchy_response', (event) => { result = JSON.parse(event.detail).result; });
  b.document.dispatchEvent(new CustomEvent('__omarchy_request', {
    detail: JSON.stringify({ id: 'raw', kind: 'install', name: 'Unsafe', colors, files: { '../escape': 'data' } }),
  }));
  assert.equal(result.ok, false);
  assert.equal(b.runtimeMessages.some((message) => message.type === 'omarchy-install-theme'), false);
  assert.equal(b.fetches.length, 0);
  assert.equal(b.posts.length, 0);
});
