// "Continue watching" history, persisted in localStorage. We record a light
// entry whenever the user starts a stream, keyed by meta id (+ episode for
// series), most-recent-first, capped so the list never grows unbounded.

import {useCallback, useEffect, useState} from 'react';
import type {MetaPreview} from './addon';

const KEY = 'vega.recent.v1';
const MAX = 20;

export interface RecentItem {
  type: string;
  id: string; // meta id (movie) — series use the base meta id
  name: string;
  poster?: string;
  videoId?: string; // specific episode id for series
  label?: string; // e.g. "S1E3" for display
  position?: number; // last playback position in seconds
  duration?: number; // media duration in seconds, when known
  at: number; // epoch ms, for ordering
}

function load(): RecentItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as RecentItem[]) : [];
  } catch {
    return [];
  }
}

// Stable key for one playable item (movie, or a specific series episode).
export function recentKey(type: string, id: string, videoId?: string): string {
  return `${type}:${id}:${videoId ?? ''}`;
}

export function useRecent() {
  const [recent, setRecent] = useState<RecentItem[]>(load);

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(recent));
  }, [recent]);

  // Record (or bump) an item to the front. Dedupe on type+id+videoId.
  const record = useCallback((item: Omit<RecentItem, 'at'>) => {
    setRecent((prev) => {
      const key = recentKey(item.type, item.id, item.videoId);
      const existing = prev.find((r) => recentKey(r.type, r.id, r.videoId) === key);
      const rest = prev.filter((r) => recentKey(r.type, r.id, r.videoId) !== key);
      // Preserve a previously-saved position unless the caller supplies one.
      const merged = {...existing, ...item, at: Date.now()} as RecentItem;
      return [merged, ...rest].slice(0, MAX);
    });
  }, []);

  // Update just the playback position for an item already in the list.
  const setPosition = useCallback((key: string, position: number, duration?: number) => {
    setRecent((prev) =>
      prev.map((r) =>
        recentKey(r.type, r.id, r.videoId) === key ? {...r, position, duration} : r,
      ),
    );
  }, []);

  // Look up a saved position for resuming.
  const positionFor = useCallback(
    (key: string): number => recent.find((r) => recentKey(r.type, r.id, r.videoId) === key)?.position ?? 0,
    [recent],
  );

  const clear = useCallback(() => setRecent([]), []);

  return {recent, record, setPosition, positionFor, clear};
}

// Convenience: build the MetaPreview a Grid expects from a RecentItem.
export function recentToPreview(r: RecentItem): MetaPreview {
  return {type: r.type, id: r.id, name: r.name, poster: r.poster};
}
