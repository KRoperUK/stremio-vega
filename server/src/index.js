// Entry point. One origin serves:
//   /            -> the static custom web app (built into ./public)
//   /api/stream  -> codec-aware stream (passthrough / remux / transcode)
//   /api/probe   -> codec decision only (debug)
//   /api/addon   -> CORS-free proxy to a Stremio addon endpoint
//
// Everything under /api is gated by a secret token (SERVER_TOKEN) supplied as
// the `t` query param or an X-Token header, because the host is public and the
// transcoder must not be an open relay. The static app is public (it carries
// no secret itself; it reads the token from its own served config).

import express from 'express';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {streamHandler, probeHandler} from './stream.js';
import {fetchJsonCapped, injectToken, openUpstreamStream, readCappedText} from './guard.js';

const SUBTITLE_MAX_BYTES = 2 * 1024 * 1024;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.SERVER_TOKEN || '';

const app = express();

// Permissive CORS for the app's own fetches (it may be served from a different
// origin during local dev; in production it is same-origin).
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

// Health is ungated (liveness probes should not need the secret).
app.get('/api/health', (_req, res) => res.json({ok: true}));

// Token gate for the rest of /api.
app.use('/api', (req, res, next) => {
  if (!TOKEN) {
    next();
    return;
  }
  const t = req.query.t || req.get('X-Token');
  if (t !== TOKEN) {
    res.status(403).json({error: 'forbidden'});
    return;
  }
  next();
});

app.get('/api/probe', probeHandler);
app.get('/api/stream', streamHandler);

// Addon proxy: /api/addon?u=<full addon endpoint url>. Lets the WebView call
// http addons without CORS/mixed-content trouble, and keeps addon traffic on
// the same HTTPS origin. Internal/redirect targets are refused (SSRF guard),
// bodies are size-capped, and we always serve a JSON content type — never the
// upstream's — so a malicious addon cannot hand the WebView an executable.
app.get('/api/addon', async (req, res) => {
  const u = req.query.u;
  if (!u || !/^https?:\/\//.test(u)) {
    res.status(400).json({error: 'u query param (http/https) required'});
    return;
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const {status, text} = await fetchJsonCapped(u, {headers: {Accept: 'application/json'}});
    res.status(status);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(text);
  } catch (e) {
    const blocked = /blocked|redirect|resolve|credentials|http\(s\)/.test(e.message);
    res.status(blocked ? 400 : 502).json({error: 'addon fetch failed: ' + e.message});
  }
});

// Subtitle proxy + SRT->WebVTT conversion. A <track> element needs WebVTT, but
// Stremio subtitle addons almost always serve SRT (and from a cross-origin
// host). /api/subtitle?url=<srt-or-vtt url> fetches it, converts SRT to VTT if
// needed, and serves it as text/vtt from this origin.
app.get('/api/subtitle', async (req, res) => {
  const u = req.query.url;
  if (!u || !/^https?:\/\//.test(u)) {
    res.status(400).json({error: 'url query param (http/https) required'});
    return;
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const r = await openUpstreamStream(u);
    if (!r.ok) {
      await r.body?.cancel().catch(() => {});
      res.status(502).json({error: `subtitle fetch ${r.status}`});
      return;
    }
    let text = await readCappedText(r.body, SUBTITLE_MAX_BYTES);
    text = text.replace(/^\uFEFF/, ''); // strip BOM
    const isVtt = /^\s*WEBVTT/.test(text);
    if (!isVtt) {
      // SRT -> VTT: comma decimal separator becomes a dot; prepend the header.
      const body = text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
      text = 'WEBVTT\n\n' + body;
    }
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.send(text);
  } catch (e) {
    if (!res.headersSent) {
      const blocked = /blocked|redirect|resolve|credentials|http\(s\)|exceeds/.test(e.message);
      res.status(blocked ? 400 : 502).json({error: 'subtitle fetch failed: ' + e.message});
    } else {
      res.destroy();
    }
  }
});

// Static app (SPA fallback to index.html). index.html carries a __VEGA_TOKEN__
// placeholder that we rewrite with the real token at serve time, so the built
// app ships no secret and the token is only ever sent to a client that reached
// this origin (which, in production, is behind the tunnel).
import {readFileSync} from 'node:fs';

let indexHtml = '';
try {
  // See injectToken: JSON literal + function replacement so tokens with
  // quotes and dollar signs boot the app and authorize API calls.
  indexHtml = injectToken(readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'), TOKEN);
} catch {
  indexHtml = '';
}

function sendIndex(res) {
  if (indexHtml) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(indexHtml);
  } else {
    res.status(404).send('app not built');
  }
}

app.use(express.static(PUBLIC_DIR, {index: false}));
app.get('*', (_req, res) => sendIndex(res));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`stremio-vega-server on :${PORT} (token ${TOKEN ? 'required' : 'OFF'})`);
});
