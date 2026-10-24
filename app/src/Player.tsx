// Player: plays a selected stream through the server's /api/stream endpoint,
// which probes the codec and either redirects (passthrough) or transcodes.
// A plain <video> element — the WebView decodes H.264/HEVC/etc. natively.

import {useEffect, useRef} from 'react';
import {apiUrl} from './config';
import type {Stream} from './addon';

export function Player({stream, onClose}: {stream: Stream; onClose: () => void}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Only direct http(s) streams go through the transcoder. Torrent (infoHash)
  // and ytId streams are out of scope for this build.
  const src = stream.url ? apiUrl('stream', {url: stream.url}) : null;

  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      v.focus();
      void v.play().catch(() => {/* autoplay may need a key press */});
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'GoBack' || e.key === 'Escape' || e.keyCode === 27) onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

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
        style={{width: '100%', height: '100%', background: '#000'}}
      />
    </div>
  );
}
