// Minimal Stremio addon-protocol client.
// Docs: https://github.com/Stremio/stremio-addon-sdk (protocol.md)
//
// All addon requests go through the streaming server's /api/addon proxy so the
// WebView never makes a cross-origin / mixed-content call itself.

import {apiUrl} from './config';

export interface Manifest {
  id: string;
  name: string;
  resources: (string | {name: string; types?: string[]})[];
  types: string[];
  catalogs: {
    type: string;
    id: string;
    name?: string;
    extra?: {name: string; isRequired?: boolean; options?: string[]}[];
  }[];
}

export interface MetaPreview {
  id: string;
  type: string;
  name: string;
  poster?: string;
  imdbRating?: string;
  releaseInfo?: string;
  year?: string | number;
}

export interface MetaDetail extends MetaPreview {
  background?: string;
  description?: string;
  runtime?: string;
  videos?: {id: string; title?: string; season?: number; episode?: number}[];
}

export interface Stream {
  url?: string;
  ytId?: string;
  infoHash?: string;
  title?: string;
  name?: string;
  description?: string;
}

export interface Subtitle {
  id: string;
  url: string;
  lang: string;
}

function addonBase(manifestUrl: string): string {
  return manifestUrl.replace(/\/manifest\.json$/, '');
}

async function proxyGet<T>(fullUrl: string): Promise<T> {
  const res = await fetch(apiUrl('addon', {u: fullUrl}));
  if (!res.ok) throw new Error(`addon ${res.status} for ${fullUrl}`);
  return (await res.json()) as T;
}

export function getManifest(manifestUrl: string): Promise<Manifest> {
  return proxyGet<Manifest>(manifestUrl);
}

export function getCatalog(
  manifestUrl: string,
  type: string,
  id: string,
  extra?: Record<string, string>,
): Promise<{metas: MetaPreview[]}> {
  const base = addonBase(manifestUrl);
  const extraPath =
    extra && Object.keys(extra).length
      ? '/' + Object.entries(extra).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
      : '';
  return proxyGet(`${base}/catalog/${type}/${id}${extraPath}.json`);
}

export function getMeta(manifestUrl: string, type: string, id: string): Promise<{meta: MetaDetail}> {
  const base = addonBase(manifestUrl);
  return proxyGet(`${base}/meta/${type}/${encodeURIComponent(id)}.json`);
}

export function getStreams(manifestUrl: string, type: string, id: string): Promise<{streams: Stream[]}> {
  const base = addonBase(manifestUrl);
  return proxyGet(`${base}/stream/${type}/${encodeURIComponent(id)}.json`);
}

export function getSubtitles(manifestUrl: string, type: string, id: string): Promise<{subtitles: Subtitle[]}> {
  const base = addonBase(manifestUrl);
  return proxyGet(`${base}/subtitles/${type}/${encodeURIComponent(id)}.json`);
}

/** Does a manifest declare a given resource (catalog/meta/stream)? */
export function hasResource(m: Manifest, resource: string, type?: string): boolean {
  return (m.resources || []).some((r) => {
    if (typeof r === 'string') return r === resource;
    return r.name === resource && (!type || !r.types || r.types.includes(type));
  });
}
