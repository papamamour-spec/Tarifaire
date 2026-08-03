'use strict';
/*
 * Service worker (lot 3) : l'application se charge hors connexion, les appels d'API
 * restent réseau (les relevés hors connexion sont mis en file par l'application elle-même).
 */
const CACHE = 'tarifaire-v2';
const STATIQUES = ['/', '/index.html', '/app.js', '/styles.css', '/manifest.webmanifest', '/docs.html'];

self.addEventListener('install', evt => {
  evt.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIQUES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', evt => {
  evt.waitUntil(
    caches.keys()
      .then(cles => Promise.all(cles.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', evt => {
  const url = new URL(evt.request.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || evt.request.method !== 'GET') return;
  // Statiques : réseau d'abord (fraîcheur), cache en secours (hors connexion)
  evt.respondWith(
    fetch(evt.request)
      .then(rep => {
        const copie = rep.clone();
        caches.open(CACHE).then(c => c.put(evt.request, copie)).catch(() => {});
        return rep;
      })
      .catch(() => caches.match(evt.request, { ignoreSearch: true })
        .then(r => r || caches.match('/index.html')))
  );
});
