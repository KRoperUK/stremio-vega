// Codec probing and the Vega-native capability decision.
//
// Vega OS (Fire TV) hardware decode support, per Amazon's WebView/media docs:
//   video: H.264 (avc), H.265/HEVC (hevc), VP8, VP9, AV1
//   audio: AAC, MP3, AC-3/E-AC-3 (Dolby), Opus, FLAC, Vorbis
// Anything else (MPEG-2, VC-1, Xvid/MPEG-4 part 2, DTS, TrueHD, ...) must be
// transcoded, because the WebView has no bypass to a software decoder.
//
// We also only pass through containers a browser <video>/MSE can demux
// directly: mp4/mov, webm/mkv (matroska), and HLS. Other containers (avi, ts,
// flv, ogg) get remuxed/transcoded even when their codecs are fine.

import {spawn} from 'node:child_process';

export const NATIVE_VIDEO = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1']);
export const NATIVE_AUDIO = new Set([
  'aac',
  'mp3',
  'ac3',
  'eac3',
  'opus',
  'flac',
  'vorbis',
]);
// Containers the WebView can demux without a remux.
export const NATIVE_CONTAINERS = new Set([
  'mov,mp4,m4a,3gp,3g2,mj2',
  'matroska,webm',
  'hls',
  'mpegts', // many HLS/progressive TS streams play; borderline, see note
]);

const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe';

// How long ffprobe may run before we give up. Kept short so a slow origin
// fails fast (and the stream path falls back to direct passthrough) rather
// than stalling past the edge proxy's idle timeout. Override with
// PROBE_TIMEOUT_MS.
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS) || 8000;

/**
 * Probe a media URL with ffprobe. Returns { container, video, audio, raw } or
 * throws. Only reads the header (analyzeduration/probesize bounded) so it does
 * not download the whole file.
 */
export function probe(url, {timeoutMs = PROBE_TIMEOUT_MS} = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '-analyzeduration',
      '5000000',
      '-probesize',
      '5000000',
      url,
    ];
    const ff = spawn(FFPROBE, args, {stdio: ['ignore', 'pipe', 'pipe']});
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      ff.kill('SIGKILL');
      reject(new Error('ffprobe timed out'));
    }, timeoutMs);

    ff.stdout.on('data', (d) => (out += d));
    ff.stderr.on('data', (d) => (err += d));
    ff.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    ff.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`ffprobe exited ${code}: ${err.slice(0, 300)}`));
        return;
      }
      try {
        const json = JSON.parse(out);
        const streams = json.streams || [];
        const video = streams.find((s) => s.codec_type === 'video');
        const audio = streams.find((s) => s.codec_type === 'audio');
        resolve({
          container: json.format?.format_name || '',
          video: video?.codec_name || null,
          audio: audio?.codec_name || null,
          raw: json,
        });
      } catch (e) {
        reject(new Error(`ffprobe parse failed: ${e.message}`));
      }
    });
  });
}

/**
 * Decide whether a probed stream can be handed to the Fire Stick as-is.
 * Returns { passthrough: boolean, reason, video, audio, container }.
 */
export function decide(info) {
  const videoOk = info.video ? NATIVE_VIDEO.has(info.video) : true;
  const audioOk = info.audio ? NATIVE_AUDIO.has(info.audio) : true;
  const containerOk = [...NATIVE_CONTAINERS].some((c) =>
    info.container.split(',').some((f) => c.split(',').includes(f)),
  );

  const passthrough = videoOk && audioOk && containerOk;
  const reasons = [];
  if (!videoOk) reasons.push(`video ${info.video} not native`);
  if (!audioOk) reasons.push(`audio ${info.audio} not native`);
  if (!containerOk) reasons.push(`container ${info.container} needs remux`);

  return {
    passthrough,
    reason: passthrough ? 'native' : reasons.join('; '),
    video: info.video,
    audio: info.audio,
    container: info.container,
    // What to do when NOT passthrough: remux only (copy streams) if codecs are
    // fine but container is not, else transcode the offending track(s).
    remuxOnly: videoOk && audioOk && !containerOk,
  };
}
