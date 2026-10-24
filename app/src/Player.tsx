// Player: plays a selected stream through the server's /api/stream endpoint,
// which probes the codec and either redirects (passthrough) or transcodes.
// A plain <video> element — the WebView decodes H.264/HEVC/etc. natively.
//
// Adds subtitle <track>s (proxied + converted to WebVTT by /api/subtitle) with
// a language chooser, and resume support: it seeks to `startAt` on load and
// reports playback position back up so "Continue watching" can resume.

import {useEffect, useRef, useState} from 'react';
import {apiUrl, subtitleUrl} from './config';
import type {Stream, Subtitle} from './addon';

export function Player({
  stream,
  subtitles = [],
  startAt = 0,
  onProgress,
  onClose,
}: {
  stream: Stream;
  subtitles?: Subtitle[];
  startAt?: number;
  onProgress?: (position: number, duration: number) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Index into `subtitles` for the active track, or -1 for "Off".
  const [activeSub, setActiveSub] = useState(-1);
  const lastReport = useRef(0);

  // Only direct http(s) streams go through the transcoder. Torrent (infoHash)
  // and ytId streams are out of scope for this build.
  const src = stream.url ? apiUrl('stream', {url: stream.url}) : null;

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.focus();
    const onMeta = () => {
      if (startAt > 0 && startAt < (v.duration || Infinity)) v.currentTime = startAt;
    };
    const onTime = () => {
      // Throttle progress reports to ~once every 5s.
      const now = Date.now();
      if (onProgress && now - lastReport.current > 5000 && v.currentTime > 0) {
        lastReport.current = now;
        onProgress(v.currentTime, v.duration || 0);
      }
    };
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('timeupdate', onTime);
    void v.play().catch(() => {/* autoplay may need a key press */});
    return () => {
      // Report final position on unmount so a quick exit still saves progress.
      if (onProgress && v.currentTime > 0) onProgress(v.currentTime, v.duration || 0);
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('timeupdate', onTime);
    };
    // Re-bind only when the source changes.
  }, [src, startAt, onProgress]);

  // Apply the chosen subtitle track (native textTracks mode).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const tracks = v.textTracks;
    for (let i = 0; i < tracks.length; i++) {
      tracks[i].mode = i === activeSub ? 'showing' : 'disabled';
    }
  }, [activeSub, subtitles.length]);

  if (!src) {
    return (
      <div className="player-overlay">
        <p>This stream type (torrent/YouTube) is not supported in this build.</p>
        <button onClick={onClose}>Back</button>
      </div>
    );
  }

  return (
    <div className="player-overlay">
      <video
        ref={videoRef}
        src={src}
        controls
        autoPlay
        crossOrigin="anonymous"
        style={{width: '100%', height: '100%', background: '#000'}}
      >
        {subtitles.map((s, i) => (
          <track
            key={s.id}
            kind="subtitles"
            srcLang={s.lang}
            label={s.lang.toUpperCase()}
            src={subtitleUrl(s.url)}
            default={i === activeSub}
          />
        ))}
      </video>

      {subtitles.length > 0 && (
        <div className="sub-picker">
          <label>
            Subtitles{' '}
            <select value={activeSub} onChange={(e) => setActiveSub(Number(e.target.value))}>
              <option value={-1}>Off</option>
              {subtitles.map((s, i) => (
                <option key={s.id} value={i}>
                  {s.lang.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
