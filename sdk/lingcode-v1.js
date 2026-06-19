/*!
 * lingcode-js v1 — the official client SDK for a LingCode managed backend.
 *
 * Zero dependencies, no build step. Wraps the gateway REST endpoints
 * (/api/cloud/be/<id>/*) in a Supabase/Firebase-shaped client so apps write
 *   client.from('todos').eq('done', false).select()
 * instead of hand-rolled fetch().
 *
 * Loaded into generated/published apps via a <script> tag; the preview also
 * pre-injects `window.lingcode` already wired to the app's backend. Keeping the
 * two globals (window.LINGCODE_BACKEND_URL / _ANON_KEY) means raw-fetch apps
 * keep working — the SDK is purely additive.
 *
 * Versioned filename (lingcode-v1.js): bump to -v2 only on a BREAKING change so
 * the 4h CDN edge cache never strands an app on an incompatible build.
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else global.LingCode = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── small helpers ────────────────────────────────────────────────────
  function trimSlash(s) { return String(s || '').replace(/\/+$/, ''); }
  function lastSegment(u) { var p = trimSlash(u).split('/'); return p[p.length - 1] || ''; }

  function makeError(message, code, status) {
    var e = new Error(message || 'Request failed');
    e.code = code || null; e.status = status || 0; e.name = 'LingCodeError';
    return e;
  }

  // Base64-decode a JWT payload (no verification — purely to read sub/email
  // for getUser() after an OAuth round-trip where we only receive the token).
  function decodeJwt(token) {
    try {
      var part = String(token).split('.')[1];
      if (!part) return null;
      var b64 = part.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      return JSON.parse(decodeURIComponent(escape(atob(b64))));
    } catch (_) { return null; }
  }

  // Turn a File/Blob/ArrayBuffer/string into base64 for storage uploads.
  function toBase64(input) {
    function bytesToB64(bytes) {
      var binary = '', chunk = 0x8000;
      for (var i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    }
    if (typeof input === 'string') return Promise.resolve(btoa(unescape(encodeURIComponent(input))));
    if (input instanceof ArrayBuffer) return Promise.resolve(bytesToB64(new Uint8Array(input)));
    if (input && typeof input.arrayBuffer === 'function') {
      return input.arrayBuffer().then(function (buf) { return bytesToB64(new Uint8Array(buf)); });
    }
    return Promise.reject(makeError('upload() needs a File, Blob, ArrayBuffer or string', 'invalid_input'));
  }

  function lsGet(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; } }
  function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {} }
  function lsDel(key) { try { localStorage.removeItem(key); } catch (_) {} }

  // ── the client ───────────────────────────────────────────────────────
  function createClient(url, anonKey, options) {
    return new LingCodeClient(url, anonKey, options || {});
  }

  function LingCodeClient(url, anonKey, options) {
    this.url = trimSlash(url);
    this.anonKey = String(anonKey || '');
    this.backendId = lastSegment(this.url);
    this._sessionKey = 'lingcode.session.' + this.backendId;
    this._session = lsGet(this._sessionKey); // { user, token } | null

    this.auth = new AuthApi(this);
    this.storage = new StorageNamespace(this);
    this.functions = new FunctionsApi(this);
    this.vector = new VectorApi(this);
    this.search = new SearchApi(this);
    this.push = new PushApi(this);
    this.telemetry = new TelemetryApi(this, options.appVersion);
    this.config = new ConfigApi(this);

    // Finalize any OAuth / magic-link redirect sitting in the URL. `ready`
    // resolves once that's done so apps can `await client.ready` before reading
    // getUser(). Sync sources (lc_session) resolve immediately.
    this.ready = (options.detectSessionInUrl === false)
      ? Promise.resolve(this)
      : this._consumeUrlSession();
  }

  // The bearer to send: the signed-in user's JWT when present, else the anon key.
  LingCodeClient.prototype._token = function () {
    return (this._session && this._session.token) || this.anonKey;
  };

  LingCodeClient.prototype._setSession = function (data) {
    var token = data && (data.access_token || data.token);
    if (!token) return data;
    this._session = {
      user: data.user || decodeUserFromToken(token),
      token: token,
      // Keep the refresh token across rotations that don't return a fresh one.
      refresh_token: data.refresh_token || (this._session && this._session.refresh_token) || null,
      expires_at: data.expires_in ? (Date.now() + data.expires_in * 1000) : null,
    };
    lsSet(this._sessionKey, this._session);
    return data;
  };

  // Exchange the stored refresh token for a new access token (+ rotated refresh
  // token). De-duped so concurrent 401s trigger only one refresh. On failure
  // the local session is cleared (the user must sign in again).
  LingCodeClient.prototype._refresh = function () {
    var self = this;
    var rt = self._session && self._session.refresh_token;
    if (!rt) return Promise.reject(makeError('no refresh token', 'no_refresh'));
    if (self._refreshing) return self._refreshing;
    self._refreshing = fetch(self.url + '/auth/token/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + self.anonKey },
      body: JSON.stringify({ refresh_token: rt }),
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (json) {
        if (!res.ok || !json || json.ok === false) {
          self.auth.signOutLocal();
          throw makeError('session expired', 'refresh_failed', res.status);
        }
        self._setSession(json.data);
        return json.data;
      });
    });
    var clear = function () { self._refreshing = null; };
    self._refreshing.then(clear, clear);
    return self._refreshing;
  };

  // Core POST → unwrap { ok, data } → return data, or throw a normalized error.
  // On an expired user token, transparently refresh once and retry — so a short
  // server-side access-token TTL is invisible to app code.
  LingCodeClient.prototype._req = function (op, body, _retried) {
    var self = this;
    return fetch(self.url + '/' + op, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + self._token() },
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (json) {
        if (!res.ok || !json || json.ok === false) {
          var code = json && json.error;
          var expired = (res.status === 401) || (res.status === 403 && code === 'invalid_token');
          var isUserToken = self._session && self._session.token && self._session.token !== self.anonKey;
          if (!_retried && expired && isUserToken && self._session.refresh_token) {
            return self._refresh().then(function () { return self._req(op, body, true); });
          }
          throw makeError((json && (json.message || json.error)) || ('HTTP ' + res.status), code, res.status);
        }
        return json.data;
      });
    });
  };

  LingCodeClient.prototype._get = function (path) {
    var self = this;
    return fetch(self.url + path, { headers: { authorization: 'Bearer ' + self._token() } })
      .then(function (res) { return res.json().catch(function () { return null; }).then(function (j) { return { res: res, json: j }; }); });
  };

  LingCodeClient.prototype.from = function (table) { return new Query(this, table); };

  // Read the URL for a session handed back by an auth redirect, finalize it,
  // and strip the params so a refresh doesn't re-trigger.
  LingCodeClient.prototype._consumeUrlSession = function () {
    var self = this;
    if (typeof location === 'undefined' || typeof URLSearchParams === 'undefined') return Promise.resolve(self);
    var qs = new URLSearchParams(location.search);
    var done = function () {
      ['lc_session', 'lc_magic', 'lc_error'].forEach(function (k) { qs.delete(k); });
      try {
        var rest = qs.toString();
        var clean = location.pathname + (rest ? '?' + rest : '') + location.hash;
        history.replaceState(null, '', clean);
      } catch (_) {}
      return self;
    };
    var sess = qs.get('lc_session');
    if (sess) { self._setSession({ token: sess }); return Promise.resolve(done()); }
    var magic = qs.get('lc_magic');
    if (magic) {
      return self._req('auth/magiclink/verify', { token: magic })
        .then(function (d) { self._setSession(d); }).catch(function () {})
        .then(done);
    }
    // lc_error: leave it for the app to read via client.auth.lastError(), strip later.
    if (qs.get('lc_error')) { self._authError = qs.get('lc_error'); return Promise.resolve(done()); }
    return Promise.resolve(self);
  };

  function decodeUserFromToken(token) {
    var c = decodeJwt(token);
    if (!c) return null;
    return { id: c.sub || null, email: c.email || null };
  }

  // ── query builder: filters first, terminal op last ───────────────────
  // client.from('t').eq('done', false).order('created_at',{ascending:false}).limit(50).select()
  // client.from('t').eq('id', 1).update({ done: true })  // where is required
  // client.from('t').eq('id', 1).delete()
  // client.from('t').insert({ ... })  // or insert([ ...rows ])
  function Query(client, table) {
    this.c = client; this.table = table;
    this._where = {}; this._order = null; this._limit = null; this._offset = null;
  }
  function relOp(name) {
    return function (col, val) { this._where[col] = makeRel(this._where[col], name, val); return this; };
  }
  function makeRel(existing, op, val) {
    var node = (existing && typeof existing === 'object' && !Array.isArray(existing)) ? existing : {};
    node[op] = val; return node;
  }
  Query.prototype.eq = function (col, val) { this._where[col] = val; return this; };
  Query.prototype.neq = relOp('neq');
  Query.prototype.gt = relOp('gt');
  Query.prototype.gte = relOp('gte');
  Query.prototype.lt = relOp('lt');
  Query.prototype.lte = relOp('lte');
  Query.prototype.like = relOp('like');
  Query.prototype.ilike = relOp('ilike');
  Query.prototype.in = function (col, arr) { this._where[col] = { in: arr }; return this; };
  // .is(col, null) → IS NULL ; .is(col, 'not_null') → IS NOT NULL
  Query.prototype.is = function (col, val) { this._where[col] = (val === null) ? null : { is: val }; return this; };
  // .not(col, 'in', [1,2]) → NOT (col = ANY(...)) ; .not(col, 'is', 'not_null'), etc.
  Query.prototype.not = function (col, op, val) {
    var inner = {}; inner[op] = val;
    this._where[col] = makeRel(this._where[col], 'not', inner); return this;
  };
  // Array / jsonb containment. .contains(col, ['a']) → col @> ; .containedBy → col <@
  Query.prototype.contains = function (col, val) { this._where[col] = makeRel(this._where[col], 'cs', val); return this; };
  Query.prototype.containedBy = function (col, val) { this._where[col] = makeRel(this._where[col], 'cd', val); return this; };
  // Full-text filter on a text column. .textSearch('body', 'foo bar') → @@ websearch_to_tsquery
  Query.prototype.textSearch = function (col, query) { this._where[col] = makeRel(this._where[col], 'fts', query); return this; };
  // OR a set of filter objects: .or([{ a: 1 }, { b: { gt: 2 } }]) → ((a=..) OR (b>..))
  Query.prototype.or = function (filters) {
    this._where.or = (this._where.or || []).concat(filters || []); return this;
  };
  // Merge a plain object of equality filters (Supabase-style .match()).
  Query.prototype.match = function (obj) {
    for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) this._where[k] = obj[k];
    return this;
  };
  Query.prototype.order = function (col, opts) {
    this._order = { column: col, ascending: opts ? opts.ascending !== false : true }; return this;
  };
  Query.prototype.limit = function (n) { this._limit = n; return this; };
  Query.prototype.range = function (from, to) { this._offset = from; this._limit = (to - from + 1); return this; };

  function settle(promise) {
    return promise.then(function (data) { return { data: data, error: null }; },
      function (error) { return { data: null, error: error }; });
  }
  function hasWhere(w) { for (var k in w) if (Object.prototype.hasOwnProperty.call(w, k)) return true; return false; }

  Query.prototype.select = function () {
    return settle(this.c._req('select', {
      table: this.table, where: this._where, order: this._order,
      limit: this._limit, offset: this._offset,
    }));
  };
  Query.prototype.insert = function (rowOrRows) {
    return settle(this.c._req('insert', { table: this.table, row: rowOrRows }));
  };
  Query.prototype.update = function (patch) {
    if (!hasWhere(this._where)) return Promise.resolve({ data: null, error: makeError('update() requires a filter (.eq/.match) — refusing an unscoped update', 'where_required') });
    return settle(this.c._req('update', { table: this.table, where: this._where, patch: patch }));
  };
  Query.prototype.delete = function () {
    if (!hasWhere(this._where)) return Promise.resolve({ data: null, error: makeError('delete() requires a filter (.eq/.match) — refusing an unscoped delete', 'where_required') });
    return settle(this.c._req('delete', { table: this.table, where: this._where }));
  };

  // Live updates: client.from('todos').subscribe(cb) → returns an unsubscribe fn.
  // Each cb receives { table, type: 'INSERT'|'UPDATE'|'DELETE', row }. RLS is
  // enforced server-side, so a signed-in user only ever sees their own rows.
  Query.prototype.subscribe = function (cb, onError) {
    var es = new EventSource(this.c.url + '/realtime?table=' + encodeURIComponent(this.table)
      + '&apikey=' + encodeURIComponent(this.c._token()));
    es.addEventListener('change', function (e) {
      try { cb(JSON.parse(e.data)); } catch (_) {}
    });
    if (onError) es.onerror = onError; // EventSource auto-reconnects
    return function unsubscribe() { try { es.close(); } catch (_) {} };
  };

  // ── auth ─────────────────────────────────────────────────────────────
  function AuthApi(client) { this.c = client; }
  AuthApi.prototype.signUp = function (creds) { return settle(this._post('auth/signup', creds)); };
  AuthApi.prototype.signIn = AuthApi.prototype.signInWithPassword = function (creds) { return settle(this._post('auth/signin', creds)); };
  AuthApi.prototype._post = function (op, body) {
    var self = this;
    return this.c._req(op, body).then(function (d) { self.c._setSession(d); return d; });
  };
  // Social login is a TOP-LEVEL navigation (not fetch); on return the SDK reads
  // ?lc_session= and stores it automatically (see _consumeUrlSession).
  AuthApi.prototype.signInWithOAuth = function (provider, opts) {
    var redirect = (opts && opts.redirectTo) || location.href;
    location.href = this.c.url + '/auth/oauth/' + encodeURIComponent(provider)
      + '/start?redirect_url=' + encodeURIComponent(redirect);
  };
  // Which OAuth buttons to render — only show providers whose .available is true.
  AuthApi.prototype.getProviders = function () {
    return this.c._get('/auth/providers').then(function (r) {
      if (!r.res.ok || !r.json) throw makeError('providers probe failed', null, r.res.status);
      return r.json.providers || {};
    });
  };
  AuthApi.prototype.sendMagicLink = function (opts) {
    return settle(this.c._req('auth/magiclink/request', {
      email: opts.email, redirect_url: (opts && opts.redirectTo) || location.href,
    }));
  };
  AuthApi.prototype.verifyMagicLink = function (token) { return settle(this._post('auth/magiclink/verify', { token: token })); };
  AuthApi.prototype.sendOtp = function (opts) { return settle(this.c._req('auth/otp/request', { email: opts.email })); };
  AuthApi.prototype.verifyOtp = function (opts) { return settle(this._post('auth/otp/verify', { email: opts.email, code: opts.code })); };
  AuthApi.prototype.getUser = function () { return (this.c._session && this.c._session.user) || null; };
  AuthApi.prototype.getToken = function () { return (this.c._session && this.c._session.token) || null; };
  AuthApi.prototype.lastError = function () { return this.c._authError || null; };
  // Force a token refresh (normally automatic on expiry inside _req).
  AuthApi.prototype.refresh = function () { return settle(this.c._refresh()); };
  // Clear the local session without calling the server (used internally).
  AuthApi.prototype.signOutLocal = function () { this.c._session = null; lsDel(this.c._sessionKey); };
  // Revoke the refresh token server-side (opts.all → every session) then clear.
  AuthApi.prototype.signOut = function (opts) {
    var self = this, rt = self.c._session && self.c._session.refresh_token;
    var p = rt ? self.c._req('auth/signout', { refresh_token: rt, all: !!(opts && opts.all) }).catch(function () {}) : Promise.resolve();
    return p.then(function () { self.signOutLocal(); return { error: null }; });
  };

  // ── MFA (TOTP) ───────────────────────────────────────────────────────
  // enrollMfa() → { factorId, secret, otpauthUrl } (render the otpauthUrl as a
  // QR). verifyMfa({ code }) completes enrollment AND returns an aal2 session
  // (stored automatically), which is what a backend with MFA required needs.
  AuthApi.prototype.enrollMfa = function () { return settle(this.c._req('auth/mfa/enroll', {})); };
  AuthApi.prototype.verifyMfa = function (opts) {
    var self = this;
    return settle(this.c._req('auth/mfa/verify', { code: opts.code, factor_id: opts.factorId })
      .then(function (d) { self.c._setSession(d); return d; }));
  };
  // After sign-in (or an mfa_required error), which verified factors exist.
  AuthApi.prototype.challengeMfa = function () { return settle(this.c._req('auth/mfa/challenge', {})); };
  AuthApi.prototype.listFactors = function () {
    return this.c._get('/auth/mfa/factors').then(function (r) {
      if (!r.res.ok || !r.json) throw makeError('factors probe failed', r.json && r.json.error, r.res.status);
      return r.json.data || [];
    });
  };
  AuthApi.prototype.removeFactor = function (id) {
    var self = this;
    return fetch(self.c.url + '/auth/mfa/factors/' + encodeURIComponent(id), {
      method: 'DELETE', headers: { authorization: 'Bearer ' + self.c._token() },
    }).then(function (res) { return { error: res.ok ? null : makeError('remove failed', null, res.status) }; });
  };

  // ── storage ──────────────────────────────────────────────────────────
  function StorageNamespace(client) { this.c = client; }
  StorageNamespace.prototype.from = function (bucket) { return new Bucket(this.c, bucket || 'public'); };

  function Bucket(client, bucket) { this.c = client; this.bucket = bucket; }

  // Best-effort byte size of a File/Blob/ArrayBuffer/string, to choose the upload
  // path. Exact-enough for a 5 MB threshold decision.
  function fileByteSize(f) {
    if (f == null) return 0;
    if (typeof f === 'string') return f.length;
    if (f instanceof ArrayBuffer) return f.byteLength;
    if (typeof f.size === 'number') return f.size; // File / Blob
    if (typeof f.byteLength === 'number') return f.byteLength; // TypedArray
    return 0;
  }
  var DIRECT_UPLOAD_THRESHOLD = 5 * 1024 * 1024; // ≤ this → base64; above → direct-to-Spaces

  // Small files take the inline base64 path (one request, simple). Large files
  // (video/audio recordings, etc.) take the direct-to-Spaces presigned-PUT path
  // so the bytes never tunnel through the gateway as base64: create-upload-url →
  // PUT straight to object storage → finalize (server records true size/etag).
  Bucket.prototype.upload = function (path, file, opts) {
    var self = this;
    var contentType = (opts && opts.contentType) || (file && file.type) || 'application/octet-stream';
    if (fileByteSize(file) <= DIRECT_UPLOAD_THRESHOLD) {
      return settle(toBase64(file).then(function (data_b64) {
        return self.c._req('storage/upload', { bucket: self.bucket, path: path, content_type: contentType, data_b64: data_b64 });
      }));
    }
    return settle(
      self.c._req('storage/create-upload-url', { bucket: self.bucket, path: path, content_type: contentType })
        .then(function (signed) {
          return fetch(signed.uploadUrl, { method: signed.method || 'PUT', headers: signed.headers || {}, body: file })
            .then(function (res) {
              if (!res.ok) throw makeError('direct upload failed (HTTP ' + res.status + ')', 'upload_failed', res.status);
              return self.c._req('storage/finalize', { bucket: self.bucket, path: path });
            });
        })
    );
  };
  Bucket.prototype.getPublicUrl = function (path) {
    return this.c.url + '/storage/object?bucket=' + encodeURIComponent(this.bucket) + '&path=' + encodeURIComponent(path);
  };
  Bucket.prototype.download = function (path) {
    // Send the bearer token so the gateway can resolve a private object owned by
    // the signed-in user (per-user isolation). Harmless for public objects, which
    // 302 straight to the CDN. The token is forwarded to the redirect target only
    // by same-origin policy; the gateway uses it before redirecting.
    return fetch(this.getPublicUrl(path), { headers: { authorization: 'Bearer ' + this.c._token() } }).then(function (res) {
      if (!res.ok) return { data: null, error: makeError('object not found', 'object_not_found', res.status) };
      return res.blob().then(function (blob) { return { data: blob, error: null }; });
    });
  };
  // remove() lands with the S3/Spaces storage update; calls the route now so the
  // surface is stable (returns { error } until that route ships).
  Bucket.prototype.remove = function (path) {
    return settle(this.c._req('storage/remove', { bucket: this.bucket, path: path }));
  };

  // ── functions ────────────────────────────────────────────────────────
  function FunctionsApi(client) { this.c = client; }
  // The gateway reads req.body.input, so wrap the caller's payload.
  FunctionsApi.prototype.invoke = function (slug, body) { return settle(this.c._req('functions/' + slug, { input: body })); };

  // ── vector / semantic search ─────────────────────────────────────────
  function VectorApi(client) { this.c = client; }
  VectorApi.prototype.search = function (q) {
    return settle(this.c._req('vector/search', {
      table: q.table, column: q.column, embedding: q.embedding, limit: q.limit, metric: q.metric,
    }));
  };
  VectorApi.prototype.embed = function (input) { return settle(this.c._req('vector/embed', { input: input })); };

  // ── full-text + hybrid search ────────────────────────────────────────
  // search.text({ table, column, query })  → FTS-ranked rows (column is text,
  //   or set isTsvector:true for a generated tsvector column).
  // search.hybrid({ table, textColumn, vectorColumn, query, embedding }) → RRF
  //   fusion of full-text + vector similarity (embed the query first).
  function SearchApi(client) { this.c = client; }
  SearchApi.prototype.text = function (q) {
    return settle(this.c._req('search/text', {
      table: q.table, column: q.column, query: q.query, is_tsvector: q.isTsvector, limit: q.limit,
    }));
  };
  SearchApi.prototype.hybrid = function (q) {
    return settle(this.c._req('search/hybrid', {
      table: q.table, text_column: q.textColumn, vector_column: q.vectorColumn,
      query: q.query, embedding: q.embedding, id_column: q.idColumn,
      text_is_tsvector: q.textIsTsvector, metric: q.metric, limit: q.limit,
      full_text_weight: q.fullTextWeight, semantic_weight: q.semanticWeight, rrf_k: q.rrfK,
    }));
  };

  // ── push (Web Push) — server lands with the notifications update ──────
  function PushApi(client) { this.c = client; }
  PushApi.prototype.isSupported = function () {
    return typeof navigator !== 'undefined' && 'serviceWorker' in navigator
      && typeof window !== 'undefined' && 'PushManager' in window;
  };
  PushApi.prototype.subscribe = function (opts) {
    var self = this;
    if (!this.isSupported()) return Promise.resolve({ data: null, error: makeError('push not supported in this browser', 'unsupported') });
    var swUrl = (opts && opts.serviceWorker) || 'https://lingcode.dev/sdk/lingcode-sw.js';
    return navigator.serviceWorker.register(swUrl).then(function (reg) {
      return self.c._get('/push/vapid-public').then(function (r) {
        if (!r.res.ok || !r.json || !r.json.data) throw makeError('push not enabled for this backend', 'push_not_configured', r.res.status);
        return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(r.json.data.key || r.json.data) });
      });
    }).then(function (sub) {
      return self.c._req('push/subscribe', { subscription: sub.toJSON ? sub.toJSON() : sub });
    }).then(function (d) { return { data: d, error: null }; }, function (e) { return { data: null, error: e }; });
  };
  function urlBase64ToUint8Array(base64) {
    var pad = '='.repeat((4 - base64.length % 4) % 4);
    var b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(b64), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  // ── telemetry (Analytics / Crashlytics / Performance) ────────────────
  // Buffer events client-side and flush in small batches to keep request
  // volume low; crashes flush immediately; everything flushes on page hide.
  //
  // Identity is pseudonymous: a random client id (app-instance, in
  // localStorage) on every event, plus an opt-in setUserId() for tying to a
  // real app user. Sessions roll over after 30 min idle and auto-emit
  // session_start; first_open / app_update fire automatically. The server
  // folds events into a 90-day raw log + per-client first/last-seen, which is
  // what powers DAU/MAU, retention, funnels, and param breakdowns.
  var SESSION_TIMEOUT_MS = 30 * 60 * 1000;
  function _ls(op, k, v) {
    try {
      if (typeof localStorage === 'undefined') return null;
      if (op === 'get') return localStorage.getItem(k);
      if (op === 'set') { localStorage.setItem(k, v); return v; }
      if (op === 'del') { localStorage.removeItem(k); return null; }
    } catch (e) { /* private mode / no storage */ }
    return null;
  }
  function _uuid() {
    try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* noop */ }
    return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0, val = c === 'x' ? r : (r & 0x3 | 0x8); return val.toString(16);
    });
  }
  function TelemetryApi(client, appVersion) {
    this.c = client;
    this.appVersion = appVersion || 'unknown';
    this._buf = [];
    this._timer = null;
    // Pseudonymous client id (app-instance). New id ⇒ first run on this device.
    var hadClient = !!_ls('get', 'lc_cid');
    this._clientId = _ls('get', 'lc_cid') || _ls('set', 'lc_cid', _uuid());
    this._userId = _ls('get', 'lc_uid') || null;
    try { this._userProps = JSON.parse(_ls('get', 'lc_uprops') || 'null') || null; } catch (e) { this._userProps = null; }
    this._sessionId = _ls('get', 'lc_sid') || null;
    this._sessionTs = parseInt(_ls('get', 'lc_sid_ts') || '0', 10) || 0;
    // Engagement-time: accumulate foreground time, emit user_engagement on hide.
    this._engStart = (typeof document === 'undefined' || document.visibilityState !== 'hidden') ? Date.now() : 0;
    var self = this;
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('pagehide', function () { self._flushEngagement(); self.flush(); });
      window.addEventListener('visibilitychange', function () {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { self._flushEngagement(); self.flush(); }
        else { self._engStart = Date.now(); }
      });
    }
    // Auto events: first_open (new client) + app_update (version changed).
    if (!hadClient) { this.captureAcquisition(); this.logEvent('first_open'); }
    var lastVer = _ls('get', 'lc_ver');
    if (lastVer && lastVer !== this.appVersion) this.logEvent('app_update', { previous: lastVer });
    _ls('set', 'lc_ver', this.appVersion);
  }
  // Roll the session if idle > 30 min. Returns true when a NEW session began.
  TelemetryApi.prototype._ensureSession = function () {
    var now = Date.now();
    var fresh = false;
    if (!this._sessionId || (now - this._sessionTs) > SESSION_TIMEOUT_MS) {
      this._sessionId = _uuid();
      _ls('set', 'lc_sid', this._sessionId);
      fresh = true;
    }
    this._sessionTs = now;
    _ls('set', 'lc_sid_ts', String(now));
    return fresh;
  };
  TelemetryApi.prototype._stamp = function (ev) {
    ev.app_version = ev.app_version || this.appVersion;
    ev.client_id = this._clientId;
    if (this._userId) ev.user_id = this._userId;
    if (this._userProps) ev.user_props = this._userProps;
    ev.session_id = this._sessionId;
    if (!ev.ts) ev.ts = Date.now();
    return ev;
  };
  // Emit accumulated foreground time as a user_engagement event (≥1s only).
  TelemetryApi.prototype._flushEngagement = function () {
    if (!this._engStart) return;
    var ms = Date.now() - this._engStart;
    this._engStart = 0;
    if (ms >= 1000) this.logEvent('user_engagement', { engagement_msec: ms });
  };
  // Set user properties (segmentation). Merged + persisted; attached to events.
  TelemetryApi.prototype.setUserProperties = function (props) {
    if (!props || typeof props !== 'object') return;
    this._userProps = this._userProps || {};
    for (var k in props) { if (Object.prototype.hasOwnProperty.call(props, k)) this._userProps[k] = props[k]; }
    _ls('set', 'lc_uprops', JSON.stringify(this._userProps));
  };
  TelemetryApi.prototype._enqueue = function (ev) {
    var startedNew = this._ensureSession();
    // A brand-new session auto-emits session_start ahead of the triggering event.
    if (startedNew && ev.name !== 'session_start') {
      this._buf.push(this._stamp({ type: 'event', name: 'session_start' }));
    }
    this._buf.push(this._stamp(ev));
    if (this._buf.length >= 20) return this.flush();
    var self = this;
    if (!this._timer) this._timer = setTimeout(function () { self.flush(); }, 3000);
  };
  // Opt-in: tie analytics to a real app user. Pass null to clear.
  TelemetryApi.prototype.setUserId = function (id) {
    if (id == null || id === '') { this._userId = null; _ls('del', 'lc_uid'); }
    else { this._userId = String(id); _ls('set', 'lc_uid', this._userId); }
  };
  // First-touch acquisition: capture utm_* + referrer host on first run and
  // store as user properties (sticky + segmentable: prop:utm_source:google).
  TelemetryApi.prototype.captureAcquisition = function () {
    try {
      var props = {};
      var p = new URLSearchParams((typeof location !== 'undefined' && location.search) || '');
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(function (k) {
        var v = p.get(k); if (v) props[k] = v.slice(0, 100);
      });
      if (typeof document !== 'undefined' && document.referrer) {
        try { props.referrer = new URL(document.referrer).hostname; } catch (e) { /* ignore */ }
      }
      if (Object.keys(props).length) this.setUserProperties(props);
    } catch (e) { /* no URLSearchParams / no location — skip */ }
  };
  TelemetryApi.prototype.logEvent = function (name, params) {
    this._enqueue({ type: 'event', name: String(name || 'event'), params: params || null });
  };
  TelemetryApi.prototype.logScreen = function (name) {
    this.logEvent('screen_view', { screen: String(name || '') });
  };
  TelemetryApi.prototype.trace = function (name, ms) {
    this._enqueue({ type: 'perf', name: String(name || 'trace'), value_ms: Number(ms) || 0 });
  };
  TelemetryApi.prototype.recordError = function (err) {
    var e = err || {};
    this._enqueue({ type: 'crash', message: String(e.message || e || 'Error'), stack: String(e.stack || ''), platform: 'web' });
    return this.flush(); // surface crashes right away
  };
  TelemetryApi.prototype.flush = function () {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (!this._buf.length) return Promise.resolve({ data: null, error: null });
    var events = this._buf.splice(0, 100);
    return this.c._req('telemetry', { events: events })
      .then(function (d) { return { data: d, error: null }; }, function (e) { return { data: null, error: e }; });
  };

  // ── remote config + A/B testing ──────────────────────────────────────
  // Fetches this client's resolved config on init; get(key, default) reads a
  // value. Each experiment assignment is recorded as an exposure event AND
  // stored as a sticky user property (exp_<param>=variant) so variants are
  // segmentable in every report — that's how you measure A/B impact.
  function ConfigApi(client) {
    this.c = client;
    this._configs = {};
    this._loaded = false;
    this.ready = this._load();
  }
  ConfigApi.prototype._load = function () {
    var self = this;
    var cid = (this.c.telemetry && this.c.telemetry._clientId) || '';
    return fetch(this.c.url + '/config?client_id=' + encodeURIComponent(cid), {
      headers: { authorization: 'Bearer ' + this.c._token() },
    }).then(function (r) { return r.json(); }).then(function (j) {
      var d = (j && j.data) || {};
      self._configs = d.configs || {};
      self._loaded = true;
      (d.assignments || []).forEach(function (a) {
        var props = {}; props['exp_' + a.param] = a.variant;
        self.c.telemetry.setUserProperties(props);
        self.c.telemetry.logEvent('experiment_exposure', { experiment: a.experiment, param: a.param, variant: a.variant });
      });
      return self;
    }, function () { self._loaded = true; return self; });
  };
  ConfigApi.prototype.get = function (key, dflt) {
    if (Object.prototype.hasOwnProperty.call(this._configs, key)) return this._configs[key];
    return dflt === undefined ? null : dflt;
  };
  ConfigApi.prototype.all = function () { return this._configs; };

  return { createClient: createClient, version: '1.1.0' };
});
