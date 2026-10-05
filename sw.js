/* Offline cache so the demo still opens with no signal (e.g. in a customer's garage). */
var CACHE = "owner-report-v3";
var FILES = ["./", "index.html", "styles.css", "data.js", "report.js", "icon.svg"];
var NETWORK_WAIT_MS = 2500; // on one bar of signal, show the cached copy instead of a blank page
self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
// Network first (so updates show up), cache as the fallback when offline, slow, or erroring.
self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  function fromCache() {
    return caches.match(req, { ignoreSearch: true }).then(function (r) {
      return r || (req.mode === "navigate" ? caches.match("index.html") : undefined);
    });
  }
  // Only good same-origin responses go into the cache, so one bad response can't replace a good copy.
  var net = fetch(req).then(function (res) {
    if (!res.ok || res.type !== "basic") return fromCache().then(function (r) { return r || res; });
    var copy = res.clone();
    return caches.open(CACHE).then(function (c) { return c.put(req, copy); }).then(function () { return res; }, function () { return res; });
  });
  e.waitUntil(net.catch(function () {}));
  var timeout = new Promise(function (resolve) { setTimeout(resolve, NETWORK_WAIT_MS); }).then(fromCache);
  e.respondWith(Promise.race([net.catch(fromCache), timeout]).then(function (r) {
    // Timer won but nothing is cached yet: keep waiting for the network.
    return r || net.catch(fromCache).then(function (r2) { return r2 || Response.error(); });
  }));
});
