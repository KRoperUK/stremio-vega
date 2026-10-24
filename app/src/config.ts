// Runtime config. In production the app is served from the streaming server's
// own origin, so SERVER_BASE is '' (same origin) and the token is injected at
// serve time into window.__VEGA_CONFIG__ (see server static serving / index.html
// placeholder). For local dev, point at a running server.

declare global {
  interface Window {
    __VEGA_CONFIG__?: {serverBase?: string; token?: string};
  }
}

const injected = typeof window !== 'undefined' ? window.__VEGA_CONFIG__ : undefined;

export const SERVER_BASE: string =
  injected?.serverBase ?? import.meta.env.VITE_SERVER_BASE ?? '';

export const SERVER_TOKEN: string =
  injected?.token ?? import.meta.env.VITE_SERVER_TOKEN ?? '';

// Build an /api URL on the streaming server with the token attached.
export function apiUrl(path: string, params: Record<string, string> = {}): string {
  const url = new URL(
    `${SERVER_BASE}/api/${path.replace(/^\//, '')}`,
    SERVER_BASE || window.location.origin,
  );
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (SERVER_TOKEN) url.searchParams.set('t', SERVER_TOKEN);
  return url.toString();
}

// Build the token-gated /api/subtitle URL that proxies + converts a subtitle
// file to WebVTT for a <track>.
export function subtitleUrl(fileUrl: string): string {
  return apiUrl('subtitle', {url: fileUrl});
}

// Default addons: toggleable, user cannot delete these two but can disable them.
export interface AddonDef {
  id: string;
  name: string;
  manifestUrl: string;
  builtin: boolean;
  enabled: boolean;
}

export const DEFAULT_ADDONS: AddonDef[] = [
  {
    id: 'cinemeta',
    name: 'Cinemeta (catalogs & metadata)',
    manifestUrl: 'https://v3-cinemeta.strem.io/manifest.json',
    builtin: true,
    enabled: true,
  },
  {
    id: 'archive-public-domain',
    name: 'Archive.org Public Domain',
    // Stream-only addon (resources: ['stream']): serves direct archive.org MP4
    // links for public-domain films keyed by the IMDb id that Cinemeta
    // provides. Verified live Oct 2026 (Night of the Living Dead, Metropolis,
    // Dracula all resolve to H.264/AAC MP4 — Vega-native, so they pass through
    // the server without transcoding).
    manifestUrl: 'https://dev.nebulawp.org/stremio/archive.org-addon/manifest.json',
    builtin: true,
    enabled: true,
  },
  {
    id: 'opensubtitles-v3',
    name: 'OpenSubtitles v3 (subtitles)',
    // Subtitle-only addon (resources: ['subtitles']): serves SRT files keyed by
    // the same IMDb id. The server's /api/subtitle route proxies and converts
    // them to WebVTT for the <track>. Verified live Oct 2026 (69 subs for
    // Night of the Living Dead).
    manifestUrl: 'https://opensubtitles-v3.strem.io/manifest.json',
    builtin: true,
    enabled: true,
  },
];
