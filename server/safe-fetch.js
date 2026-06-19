'use strict';

// safe-fetch.js — SSRF-guarded outbound HTTP for in-process function templates.
//
// The function templates run IN the control-plane process, which can reach the
// internal VPC (the cloud Postgres at 10.x, the cloud-metadata endpoint, other
// internal services). So user-influenced egress MUST be guarded. The rules:
//   - https:// only
//   - the host must be on the caller-supplied allow-list (secure default: an
//     empty list denies everything — the owner opts in per backend)
//   - reject IP-literal hosts and any host whose DNS resolves to a private,
//     loopback, link-local, ULA, carrier-NAT, or cloud-metadata address
//   - redirects are manual and EACH hop is re-validated (defeats redirect-to-
//     internal); capped count
//   - response size cap + wall-clock timeout
//
// Residual risk (documented, v1): DNS-rebinding TOCTOU between resolve and
// connect. Mitigated by the allow-list + per-hop revalidation; full pinning of
// the resolved IP at connect time is a v2 follow-up.

const dnsp = require('dns').promises;
const net = require('net');

function badReq(message) { const e = new Error(message); e.status = 400; e.code = 'fetch_blocked'; return e; }

// Is an IP literal (v4 or v6) in a non-public range we must refuse?
function isPrivateIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) {
    const lc = ip.toLowerCase();
    if (lc === '::1' || lc === '::') return true;                 // loopback / unspecified
    if (lc.startsWith('fe80')) return true;                       // link-local
    if (lc.startsWith('fc') || lc.startsWith('fd')) return true;  // unique-local fc00::/7
    // IPv4-mapped (::ffff:a.b.c.d) — check the embedded v4
    const m = lc.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateV4(m[1]);
    return false;
  }
  return false; // not an IP literal
}

function isPrivateV4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed → refuse
  const [a, b] = p;
  if (a === 10) return true;                       // 10.0.0.0/8
  if (a === 127) return true;                      // loopback
  if (a === 0) return true;                        // 0.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;// 172.16.0.0/12
  if (a === 192 && b === 168) return true;         // 192.168.0.0/16
  if (a === 169 && b === 254) return true;         // link-local + cloud metadata 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return true;// carrier-grade NAT 100.64.0.0/10
  if (a >= 224) return true;                       // multicast / reserved
  return false;
}

function normHost(h) { return String(h || '').toLowerCase().replace(/\.$/, ''); }

// Exact host match, or a subdomain of an allow-listed host (api.x.com ⊂ x.com).
function hostAllowed(host, allowedHosts) {
  const h = normHost(host);
  if (!h) return false;
  return (allowedHosts || []).map(normHost).filter(Boolean).some((a) => h === a || h.endsWith('.' + a));
}

// Validate a URL is safe to fetch. `lookup` is injectable for tests.
async function assertSafeUrl(rawUrl, allowedHosts, { lookup = dnsp.lookup } = {}) {
  let u;
  try { u = new URL(String(rawUrl)); } catch (_) { throw badReq('invalid URL'); }
  if (u.protocol !== 'https:') throw badReq('only https:// URLs are allowed');
  const host = u.hostname;
  if (net.isIP(host)) throw badReq('IP-literal hosts are not allowed; use a domain name');
  if (!hostAllowed(host, allowedHosts)) throw badReq(`host not allow-listed: ${host}`);
  let addrs;
  try { addrs = await lookup(host, { all: true }); } catch (_) { throw badReq(`DNS resolution failed for ${host}`); }
  const list = Array.isArray(addrs) ? addrs : [addrs];
  if (!list.length) throw badReq(`no addresses for ${host}`);
  for (const a of list) {
    const addr = (a && a.address) || a;
    if (isPrivateIp(addr)) throw badReq(`${host} resolves to a non-public address`);
  }
  return u;
}

function pickHeaders(h) {
  const out = {};
  for (const k of ['content-type', 'content-length', 'etag', 'last-modified']) {
    const v = h.get(k); if (v) out[k] = v;
  }
  return out;
}

// SSRF-guarded fetch. Returns { status, headers, buf, contentType }.
async function safeFetch(rawUrl, opts = {}) {
  const { method = 'GET', headers = {}, body = null, allowedHosts = [],
    timeoutMs = 10000, maxBytes = 5 * 1024 * 1024, maxRedirects = 3, lookup } = opts;
  let url = String(rawUrl), redirects = 0, m = method;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await assertSafeUrl(url, allowedHosts, { lookup });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, { method: m, headers, body: m === 'GET' || m === 'HEAD' ? undefined : body, redirect: 'manual', signal: ctrl.signal });
    } catch (e) {
      throw Object.assign(new Error(e.name === 'AbortError' ? `request timed out after ${timeoutMs}ms` : `request failed: ${e.message}`), { status: 502, code: 'fetch_failed' });
    } finally { clearTimeout(timer); }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) throw badReq('redirect without Location');
      if (++redirects > maxRedirects) throw badReq('too many redirects');
      url = new URL(loc, url).toString();          // resolve relative; next loop re-validates
      if (res.status === 303) m = 'GET';
      continue;
    }
    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxBytes) throw Object.assign(new Error(`response exceeds ${maxBytes} bytes`), { status: 502, code: 'response_too_large' });
    return { status: res.status, headers: pickHeaders(res.headers), buf: Buffer.from(ab), contentType: res.headers.get('content-type') || '' };
  }
}

module.exports = { safeFetch, assertSafeUrl, isPrivateIp, isPrivateV4, hostAllowed };
