// Builds the <script> injected at the very top of a replayed page's <head>.
// It runs BEFORE the site's own scripts and patches fetch / XMLHttpRequest so
// that data requests resolve from responses recorded during the crawl instead
// of hitting the network (which fails offline / cross-origin from localhost).
// This lets the site's real JavaScript run against real data, keeping
// client-side interactivity (tab switches, filters, etc.) working offline.

export function buildReplayShim(recordings, mediaMap = {}) {
  // Map keyed by pathname+search, with a pathname-only fallback index, so the
  // shim can match requests even when cache-busting query params differ.
  const byKey = {};
  const byPath = {};
  for (const r of recordings) {
    byKey[r.key] = { status: r.status, contentType: r.contentType, body: r.bodyBase64 };
    // Last one wins for the path fallback — fine, these are same-resource variants.
    byPath[r.pathname] = r.key;
  }

  const data = JSON.stringify({ byKey, byPath });
  const media = JSON.stringify(mediaMap);

  // The shim is deliberately self-contained and defensive: anything it can't
  // match falls through to the original fetch/XHR so nothing is made worse.
  return `(function(){
  var DB = ${data};
  var MEDIA = ${media};

  // The app builds image/media URLs at runtime (often absolute CDN URLs). We
  // can't intercept <img> loads via fetch/XHR, so we watch the DOM and rewrite
  // any src/srcset we have a local copy of (matched by pathname) to the local
  // path. Images we didn't capture are left alone (they'll load if online).
  function localForUrl(raw){
    if (!raw) return null;
    var path;
    try { path = new URL(raw, location.href).pathname; } catch(e){ return null; }
    return MEDIA[path] || null;
  }
  function fixEl(el){
    try {
      if (el.tagName === "IMG" || el.tagName === "SOURCE") {
        var src = el.getAttribute("src");
        var local = localForUrl(src);
        if (local && src !== local) el.setAttribute("src", local);
        var ss = el.getAttribute("srcset");
        if (ss) {
          var fixed = ss.split(",").map(function(part){
            var seg = part.trim().split(/\\s+/);
            var l = localForUrl(seg[0]);
            if (l) seg[0] = l;
            return seg.join(" ");
          }).join(", ");
          if (fixed !== ss) el.setAttribute("srcset", fixed);
        }
      }
    } catch(e){}
  }
  function scan(root){
    try {
      if (root.tagName === "IMG" || root.tagName === "SOURCE") fixEl(root);
      if (root.querySelectorAll) root.querySelectorAll("img,source").forEach(fixEl);
    } catch(e){}
  }
  if (typeof MutationObserver !== "undefined") {
    new MutationObserver(function(muts){
      muts.forEach(function(m){
        if (m.type === "attributes") { fixEl(m.target); return; }
        m.addedNodes && m.addedNodes.forEach(function(n){ if (n.nodeType === 1) scan(n); });
      });
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "srcset"] });
  }
  if (document.readyState !== "loading") scan(document);
  else document.addEventListener("DOMContentLoaded", function(){ scan(document); });

  function b64ToBytes(b64){
    var bin = atob(b64), len = bin.length, bytes = new Uint8Array(len);
    for (var i=0;i<len;i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function lookup(rawUrl){
    var path, search="";
    try {
      var u = new URL(rawUrl, location.href);
      path = u.pathname; search = u.search;
    } catch(e){
      var q = String(rawUrl).split("?"); path = q[0]; search = q[1]?("?"+q[1]):"";
    }
    var key = path + search;
    if (DB.byKey[key]) return DB.byKey[key];
    if (DB.byPath[path] && DB.byKey[DB.byPath[path]]) return DB.byKey[DB.byPath[path]];
    return null;
  }
  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function(input, init){
    try {
      var url = (typeof input === "string") ? input : (input && input.url);
      var method = (init && init.method) || (input && input.method) || "GET";
      if (String(method).toUpperCase() === "GET") {
        var rec = lookup(url);
        if (rec) {
          var bytes = b64ToBytes(rec.body);
          var blob = new Blob([bytes], { type: rec.contentType });
          return Promise.resolve(new Response(blob, {
            status: rec.status || 200,
            statusText: "OK",
            headers: { "Content-Type": rec.contentType }
          }));
        }
      }
    } catch(e){}
    return realFetch ? realFetch(input, init) : Promise.reject(new Error("offline"));
  };

  var RealXHR = window.XMLHttpRequest;
  function ShimXHR(){
    var xhr = new RealXHR();
    var _open = xhr.open, _send = xhr.send;
    var _method = "GET", _url = null, _rec = null;
    xhr.open = function(method, url){
      _method = method; _url = url;
      return _open.apply(xhr, arguments);
    };
    xhr.send = function(){
      try {
        if (String(_method).toUpperCase() === "GET") _rec = lookup(_url);
      } catch(e){ _rec = null; }
      if (!_rec) return _send.apply(xhr, arguments);
      // Serve the recorded response without touching the network.
      var text = "";
      try { text = new TextDecoder("utf-8").decode(b64ToBytes(_rec.body)); } catch(e){}
      var self = xhr;
      setTimeout(function(){
        try {
          Object.defineProperty(self, "readyState", { value: 4, configurable: true });
          Object.defineProperty(self, "status", { value: _rec.status || 200, configurable: true });
          Object.defineProperty(self, "responseText", { value: text, configurable: true });
          Object.defineProperty(self, "response", { value: text, configurable: true });
          Object.defineProperty(self, "responseURL", { value: _url, configurable: true });
        } catch(e){}
        if (typeof self.onreadystatechange === "function") self.onreadystatechange();
        if (typeof self.onload === "function") self.onload();
        self.dispatchEvent(new Event("readystatechange"));
        self.dispatchEvent(new Event("load"));
        self.dispatchEvent(new Event("loadend"));
      }, 0);
    };
    return xhr;
  }
  ShimXHR.prototype = RealXHR.prototype;
  ShimXHR.UNSENT=0; ShimXHR.OPENED=1; ShimXHR.HEADERS_RECEIVED=2; ShimXHR.LOADING=3; ShimXHR.DONE=4;
  window.XMLHttpRequest = ShimXHR;
})();`;
}
