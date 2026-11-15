// Serve a source media URL to the Fire Stick, transcoding only what it cannot
// decode. Three paths, cheapest first:
//
//   passthrough  — source is Vega-native in a browser-demuxable container:
//                  PROXY the bytes straight through (range-aware, zero CPU, no
//                  ffmpeg). We proxy rather than 302-redirect so the WebView
//                  only ever talks to this HTTPS origin — a redirect to a
//                  cross-origin (often HTTP) source fails on the Stick.
//   remux        — codecs are native but the container is not (e.g. AVI with
//                  H.264): ffmpeg -c copy into fragmented MP4 (no re-encode).
//   transcode    — a codec the Stick cannot decode: re-encode only the
//                  offending track to H.264/AAC, copy the other, into fMP4.
//
// Output is fragmented MP4 piped over a chunked HTTP response, which the
// WebView <video>/MSE plays as a progressive stream.

import {spawn} from 'node:child_process';
import {probe, decide} from './codec.js';
import {assertSafeUrl, openUpstreamStream} from './guard.js';

// A stalled upstream must fail fast, not hang the <video> forever. While
// piping, the watchdog fires if no byte arrives within IDLE_TIMEOUT_MS.
const IDLE_TIMEOUT_MS = Number(process.env.UPSTREAM_IDLE_TIMEOUT_MS) || 20000;

const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';

// Encoder tuning for the OCI A1 (ARM, no GPU) — software x264, fast preset,
// capped so one stream cannot saturate CPU/uplink.
const VIDEO_ENCODE = [
  '-c:v', 'libx264',
  '-preset', process.env.X264_PRESET || 'veryfast',
  '-crf', process.env.X264_CRF || '23',
  '-maxrate', process.env.MAX_BITRATE || '8M',
  '-bufsize', '16M',
  '-vf', `scale='min(1920,iw)':-2`,
  '-pix_fmt', 'yuv420p',
];
const AUDIO_ENCODE = ['-c:a', 'aac', '-b:a', '160k', '-ac', '2'];
// Fragmented MP4 so it streams progressively over a chunked response.
const FMP4_OUT = [
  '-movflags',
  'frag_keyframe+empty_moov+default_base_moof',
  '-f',
  'mp4',
];

function buildArgs(sourceUrl, plan) {
  const input = ['-i', sourceUrl];
  let codecArgs;
  if (plan.remuxOnly) {
    // Container only — copy both streams.
    codecArgs = ['-c', 'copy'];
  } else {
    const videoNative = plan.video && !plan.reason.includes(`video ${plan.video}`);
    const audioNative = plan.audio && !plan.reason.includes(`audio ${plan.audio}`);
    codecArgs = [
      ...(videoNative ? ['-c:v', 'copy'] : VIDEO_ENCODE),
      ...(audioNative ? ['-c:a', 'copy'] : AUDIO_ENCODE),
    ];
  }
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    ...input,
    ...codecArgs,
    ...FMP4_OUT,
    'pipe:1',
  ];
}

/**
 * Passthrough by PROXYING the bytes (range-aware), not a 302 redirect.
 *
 * A 302 would send the WebView's <video> straight at the source origin — which
 * on a Fire Stick fails for a cross-origin (often HTTP) host: mixed content,
 * missing CORS, or a media loader that will not follow a cross-origin redirect
 * (observed as net::ERR_FAILED against archive.org). Proxying keeps every byte
 * on this HTTPS origin while still spending zero CPU (no ffmpeg), and forwards
 * Range so the <video> can seek.
 */
async function proxyPassthrough(sourceUrl, req, res) {
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  const upstream = await openUpstreamStream(sourceUrl, {headers});
  // The stream route serves media only: refuse anything that is not an
  // audio/video payload so the endpoint cannot be used to launder files.
  const contentType = upstream.headers.get('content-type') || '';
  if (!/^(audio|video)\//.test(contentType)) {
    await upstream.body?.cancel().catch(() => {});
    if (!res.headersSent) res.status(502).json({error: `refusing non-media content-type: ${contentType || 'none'}`});
    return;
  }
  // Mirror status (200 or 206 for range) and the headers a <video> needs.
  res.status(upstream.status);
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!upstream.body) {
    res.end();
    return;
  }
  // Pipe the web stream to the Node response, aborting if the client leaves
  // and failing fast if the upstream stalls mid-body.
  const reader = upstream.body.getReader();
  let stalled = false;
  const watchdog = () => {
    stalled = true;
    reader.cancel().catch(() => {});
  };
  let timer = setTimeout(watchdog, IDLE_TIMEOUT_MS);
  req.on('close', () => {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  });
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      clearTimeout(timer);
      timer = setTimeout(watchdog, IDLE_TIMEOUT_MS);
      if (!res.write(Buffer.from(value))) {
        await new Promise((r) => res.once('drain', r));
      }
    }
  } catch {
    /* client went away, upstream stalled, or upstream aborted */
  } finally {
    clearTimeout(timer);
    if (stalled && !res.headersSent) {
      res.status(504).json({error: 'upstream stalled'});
    } else {
      res.end();
    }
  }
}

/**
 * Express handler: GET /stream?url=<source>
 * Probes, then proxies (passthrough) or pipes an ffmpeg-produced fMP4.
 */
export async function streamHandler(req, res) {
  const sourceUrl = req.query.url;
  if (!sourceUrl || !/^https?:\/\//.test(sourceUrl)) {
    res.status(400).json({error: 'url query param (http/https) required'});
    return;
  }
  try {
    await assertSafeUrl(sourceUrl);
  } catch (e) {
    res.status(400).json({error: 'refusing unsafe url: ' + e.message});
    return;
  }

  let plan;
  try {
    const info = await probe(sourceUrl);
    plan = decide(info);
  } catch (e) {
    // If we cannot probe, fall back to passthrough — better to let the Stick
    // try than to fail outright. Proxy the bytes (not a redirect) for the same
    // cross-origin reasons as below.
    res.setHeader('X-Vega-Decision', 'probe-failed-passthrough');
    try {
      await proxyPassthrough(sourceUrl, req, res);
    } catch (err) {
      if (!res.headersSent) res.status(502).json({error: 'passthrough failed: ' + err.message});
      else res.destroy();
    }
    return;
  }

  res.setHeader('X-Vega-Decision', plan.passthrough ? 'passthrough' : plan.remuxOnly ? 'remux' : 'transcode');
  res.setHeader('X-Vega-Source-Video', plan.video || 'none');
  res.setHeader('X-Vega-Source-Audio', plan.audio || 'none');

  if (plan.passthrough) {
    try {
      await proxyPassthrough(sourceUrl, req, res);
    } catch (err) {
      if (!res.headersSent) res.status(502).json({error: 'passthrough failed: ' + err.message});
      else res.destroy();
    }
    return;
  }

  const args = buildArgs(sourceUrl, plan);
  const ff = spawn(FFMPEG, args, {stdio: ['ignore', 'pipe', 'pipe']});

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-store');

  ff.stdout.pipe(res);
  let errTail = '';
  ff.stderr.on('data', (d) => {
    errTail = (errTail + d.toString()).slice(-2000);
  });
  ff.on('error', (e) => {
    if (!res.headersSent) res.status(502).json({error: 'ffmpeg spawn failed: ' + e.message});
    else res.destroy();
  });
  ff.on('close', (code) => {
    if (code && code !== 0 && code !== 255) {
      // 255 = SIGKILL from client disconnect; not an error.
      console.error(`[stream] ffmpeg exit ${code}: ${errTail.slice(-400)}`);
    }
    res.end();
  });
  // Kill ffmpeg if the client goes away.
  req.on('close', () => {
    if (!ff.killed) ff.kill('SIGKILL');
  });
}

/** GET /probe?url=<source> — returns the codec decision without streaming. */
export async function probeHandler(req, res) {
  const sourceUrl = req.query.url;
  if (!sourceUrl || !/^https?:\/\//.test(sourceUrl)) {
    res.status(400).json({error: 'url query param (http/https) required'});
    return;
  }
  try {
    await assertSafeUrl(sourceUrl);
  } catch (e) {
    res.status(400).json({error: 'refusing unsafe url: ' + e.message});
    return;
  }
  try {
    const info = await probe(sourceUrl);
    res.json(decide(info));
  } catch (e) {
    // Probe failed (slow origin, timeout, unprobeable container). Mirror the
    // stream path: report that we would fall back to direct passthrough rather
    // than failing, so a slow origin does not surface as an error.
    res.json({
      passthrough: true,
      reason: `probe-failed-fallback: ${e.message}`,
      video: null,
      audio: null,
      container: '',
      remuxOnly: false,
    });
  }
}
