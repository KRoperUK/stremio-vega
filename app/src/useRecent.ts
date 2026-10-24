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

export function useRecent() {
  const [recent, setRecent] = useState<RecentItem[]>(load);

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(recent));
  }, [recent]);

  // Record (or bump) an item to the front. Dedupe on type+id+videoId.
  const record = useCallback((item: Omit<RecentItem, 'at'>) => {
    setRecent((prev) => {
      const key = `${item.type}:${item.id}:${item.videoId ?? ''}`;
      const rest = prev.filter((r) => `${r.type}:${r.id}:${r.videoId ?? ''}` !== key);
      return [{...item, at: Date.now()}, ...rest].slice(0, MAX);
    });
  }, []);

  const clear = useCallback(() => setRecent([]), []);

  return {recent, record, clear};
}

// Convenience: build the MetaPreview a Grid expects from a RecentItem.
export function recentToPreview(r: RecentItem): MetaPreview {
  return {type: r.type, id: r.id, name: r.name, poster: r.poster};
}
