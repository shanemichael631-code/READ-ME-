/* Retires the offline cache. A private (live) report always loads fresh: a cached copy could hide an
 * expired sign-in and keep showing last week's numbers. Deploy this file AS sw.js on live reports
 * (the public demo keeps sw.js). Browsers fetch sw.js on every visit, find this version, run it once,
 * and it deletes the saved copies, removes itself and reloads the page. */
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.registration.unregister(); })
      .then(function () { return self.clients.matchAll({ type: "window" }); })
      .then(function (list) { list.forEach(function (c) { c.navigate(c.url); }); })
  );
});
