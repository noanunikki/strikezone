/* StrikeZone service worker. BUILD_ID is stamped by build.py, so every changed build is a byte-different sw.js and triggers an update.
   Strategy:  app shell (index.html + manifest + icons) = precache, cache-first, versioned cache name (old ones deleted on activate)
              cdnjs three.js / peerjs and Google Fonts = runtime cache (immutable URLs: cache-first; font CSS: stale-while-revalidate)
              everything else (PeerJS signaling over HTTP, anything unknown) = untouched network. WebSockets never pass through a worker.
   Updates:   a new worker WAITS (no skipWaiting on install). The page shows a toast in the menu and posts SKIP_WAITING on user click,
              so a running match is never replaced underneath the player. */
'use strict';
const BUILD_ID = '2026-10-12.7d9c974b5a';
const SHELL = 'sfz-shell-' + BUILD_ID, RT = 'sfz-rt-v1';
const PRECACHE = ["index.html", "apple-touch-icon.png", "favicon.svg", "icon-192.png", "icon-32.png", "icon-512.png", "icon-maskable-512.png", "logo.png", "manifest.webmanifest", "wordmark.png"];
const LIBS = ['https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.2/peerjs.min.js'];
const FONTS_CSS = 'https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Orbitron:wght@600;800;900&display=swap';
const IMMUTABLE_HOSTS = ['cdnjs.cloudflare.com', 'fonts.gstatic.com'];
const MATCH = { ignoreSearch: true, ignoreVary: true };

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await shell.addAll(PRECACHE.map(u => new Request(u, { cache: 'reload' }))); /* atomic: a failed shell download fails the install and the old worker keeps serving */
    const rt = await caches.open(RT);
    const grab = async u => { if (await rt.match(u, MATCH)) return null; const r = await fetch(u, { mode: 'cors', credentials: 'omit' }); if (r.ok) await rt.put(u, r.clone()); return r; };
    await Promise.allSettled(LIBS.map(grab)); /* best effort */
    if (FONTS_CSS) await Promise.allSettled([(async () => { /* font CSS + only the latin subset files (covers Finnish); other subsets are cached when the page first asks */
      const r = await fetch(FONTS_CSS, { mode: 'cors', credentials: 'omit' }); if (!r.ok) return; await rt.put(FONTS_CSS, r.clone());
      const urls = [...(await r.text()).matchAll(/\/\*\s*latin\s*\*\/\s*@font-face\s*\{[^}]*?url\((https:[^)]+)\)/g)].map(m => m[1]);
      await Promise.allSettled(urls.map(grab));
    })()]);
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('sfz-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => { if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting(); });

const putSafe = async (cache, req, res) => { try { if (res && (res.ok || res.type === 'opaque')) await cache.put(req, res.clone()); } catch (_) { /* quota: ignore */ } };

async function navigate(req) {
  const shell = await caches.open(SHELL);
  const u = new URL(req.url), root = new URL('./', self.registration.scope).href;
  const isApp = u.href.split(/[?#]/)[0] === root || /\/(index|strike-force)\.html$/.test(u.pathname);
  if (isApp) { const hit = await shell.match('index.html', MATCH) || await shell.match(root, MATCH); if (hit) return hit; }
  try { return await fetch(req); } catch (err) { const hit = await shell.match('index.html', MATCH); if (hit) return hit; throw err; }
}

async function cacheFirst(req, cacheName, cors) {
  const c = await caches.open(cacheName), hit = await c.match(req, MATCH); if (hit) return hit;
  const res = await fetch(cors ? new Request(req.url, { mode: 'cors', credentials: 'omit' }) : req); await putSafe(c, req, res); return res;
}

async function staleWhileRevalidate(req) {
  const c = await caches.open(RT), hit = await c.match(req, MATCH);
  const net = fetch(new Request(req.url, { mode: 'cors', credentials: 'omit' })).then(async r => { await putSafe(c, req, r); return r; });
  if (hit) { net.catch(() => { }); return hit; }
  return net;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const u = new URL(req.url);
  if (u.origin === self.location.origin) {
    if (req.mode === 'navigate') return e.respondWith(navigate(req));
    return e.respondWith((async () => (await (await caches.open(SHELL)).match(req, MATCH)) || fetch(req))());
  }
  if (IMMUTABLE_HOSTS.includes(u.hostname)) return e.respondWith(cacheFirst(req, RT, req.mode !== 'no-cors').catch(() => fetch(req)));
  if (u.hostname === 'fonts.googleapis.com') return e.respondWith(staleWhileRevalidate(req).catch(() => fetch(req)));
  /* PeerJS broker (0.peerjs.com) and anything unknown: no respondWith => plain network */
});
