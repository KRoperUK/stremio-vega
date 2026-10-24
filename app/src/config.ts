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
    manifestUrl: 'https://stremio-archive.vercel.app/manifest.json',
    builtin: true,
    enabled: true,
  },
];
