// Outbound-request hardening for the Vega streaming server.
//
// Every caller-supplied URL (addon proxy, subtitle proxy, stream/probe target)
// passes through assertSafeUrl() before we touch the network: only http/https,
// no embedded credentials, and the host must resolve exclusively to public IP
// space. Redirect targets are re-validated, so a public URL cannot bounce us
// at an internal address. Bodies are size-capped and stalled upstreams fail
// fast instead of hanging a handler forever.

import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';

export const MAX_JSON_BYTES = 8 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 15000;
export const MAX_REDIRECTS = 5;

function ipv4Blocked(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return true;
  const n = parts.map(Number);
  if (n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const [a, b, c] = n;
  if (a === 10) return true; // RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 0) return true; // "this network"
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function ipv6Blocked(ip) {
  let low = ip.toLowerCase();
  // IPv4-mapped / translated forms carry a dotted quad — judge the quad.
  const dot = low.lastIndexOf(':') >= 0 ? low.slice(low.lastIndexOf(':') + 1) : low;
  if (dot.includes('.')) return ipv4Blocked(dot);
  low = low.replace(/^\[(.*)\]$/, '$1');
  if (low === '::' || low === '::1') return true;
  if (low.startsWith('fe80:') || low.startsWith('fec0:')) return true; // link-local / site-local
  if (low.startsWith('fc') || low.startsWith('fd')) return true; // unique-local fc00::/7
  if (low.startsWith('ff')) return true; // multicast
  if (low.startsWith('2001:db8')) return true; // documentation
  if (low === '::ffff:0:0' || low.startsWith('::ffff:0:0:')) return true;
  return false;
}

/** True when a literal IP address (v4 or v6) is outside public unicast space. */
export function ipIsBlocked(ip) {
  const family = isIP(ip);
  if (family === 4) return ipv4Blocked(ip);
  if (family === 6) return ipv6Blocked(ip);
  return true; // not parseable as an IP at all
}

/**
 * Throw unless `host` resolves exclusively to public IP space.
 * Hosts that resolve to nothing, or to a mix containing a blocked address,
 * are refused.
 */
export async function assertHostSafe(host, resolve = lookup) {
  const clean = host.replace(/^\[(.*)\]$/, '$1');
  if (isIP(clean)) {
    if (ipIsBlocked(clean)) throw new Error(`blocked address: ${host}`);
    return;
  }
  let records;
  try {
    records = await resolve(clean, {all: true});
  } catch {
    throw new Error(`cannot resolve host: ${host}`);
  }
  if (!records?.length) throw new Error(`cannot resolve host: ${host}`);
  for (const r of records) {
    if (ipIsBlocked(r.address)) throw new Error(`blocked address for host: ${host}`);
  }
}

/** Throw unless `raw` is an http(s) URL without credentials and with a safe host. */
export async function assertSafeUrl(raw, resolve = lookup) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error('url must be an http(s) URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('url must be an http(s) URL');
  }
  if (u.username || u.password) throw new Error('credentials in url are not allowed');
  await assertHostSafe(u.hostname, resolve);
  return u;
}

/** Read a WHATWG stream to text, throwing if it exceeds `maxBytes`. */
export async function readCappedText(body, maxBytes = MAX_JSON_BYTES) {
  if (!body) return '';
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`response exceeds ${maxBytes} byte cap`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * Fetch a URL that passed assertSafeUrl, following up to MAX_REDIRECTS
 * redirects with each hop re-validated (a public URL must not bounce us at
 * an internal address). Stalled/slow upstreams fail via timeout.
 */
export async function safeFetch(rawUrl, {timeoutMs = FETCH_TIMEOUT_MS, headers = {}} = {}) {
  let current = String(rawUrl);
  let res = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeUrl(current);
    res = await fetch(current, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status < 300 || res.status > 399) return res;
    const next = res.headers.get('location');
    await res.body?.cancel().catch(() => {});
    if (!next) throw new Error('redirect without location');
    current = new URL(next, current).toString();
  }
  throw new Error('too many redirects');
}

/**
 * Open a streaming upstream response (for media passthrough) with an SSRF
 * guard on the initial URL and every redirect hop. Header fetches are bounded
 * by `headerTimeoutMs`; the caller must enforce its own idle watchdog while
 * piping the body, because a media stream legitimately runs far longer than
 * any total timeout.
 */
export async function openUpstreamStream(rawUrl, {headerTimeoutMs = FETCH_TIMEOUT_MS, headers = {}} = {}) {
  let current = String(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeUrl(current);
    const res = await fetch(current, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(headerTimeoutMs),
    });
    if (res.status < 300 || res.status > 399) return res;
    const next = res.headers.get('location');
    await res.body?.cancel().catch(() => {});
    if (!next) throw new Error('redirect without location');
    current = new URL(next, current).toString();
  }
  throw new Error('too many redirects');
}

/**
 * Inject the server token into served index.html. The placeholder (quotes
 * included) is replaced with a JSON string literal via function replacement,
 * so tokens containing `$` patterns, quotes, or backslashes survive
 * literally and cannot break out of the inline script.
 */
export function injectToken(html, token) {
  return html.replace(/'__VEGA_TOKEN__'/g, () => JSON.stringify(token).replace(/</g, '\\u003c'));
}

/** Fetch JSON with SSRF guard, timeout, and a body cap. */
export async function fetchJsonCapped(rawUrl, opts = {}) {
  const res = await safeFetch(rawUrl, opts);
  const text = await readCappedText(res.body, opts.maxBytes ?? MAX_JSON_BYTES);
  return {status: res.status, text};
}
