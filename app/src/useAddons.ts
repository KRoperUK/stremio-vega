// Persisted addon list: the two builtins (toggleable, not deletable) plus any
// user-added addon URLs. Stored in localStorage.

import {useCallback, useEffect, useState} from 'react';
import {AddonDef, DEFAULT_ADDONS} from './config';

const KEY = 'vega.addons.v1';

function load(): AddonDef[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_ADDONS;
    const saved = JSON.parse(raw) as AddonDef[];
    // Merge: keep builtins (preserve their enabled flag if present), append customs.
    const byId = new Map(saved.map((a) => [a.id, a]));
    const builtins = DEFAULT_ADDONS.map((b) => ({...b, enabled: byId.get(b.id)?.enabled ?? b.enabled}));
    const customs = saved.filter((a) => !a.builtin);
    return [...builtins, ...customs];
  } catch {
    return DEFAULT_ADDONS;
  }
}

export function useAddons() {
  const [addons, setAddons] = useState<AddonDef[]>(load);

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(addons));
  }, [addons]);

  const toggle = useCallback((id: string) => {
    setAddons((prev) => prev.map((a) => (a.id === id ? {...a, enabled: !a.enabled} : a)));
  }, []);

  const add = useCallback((name: string, manifestUrl: string) => {
    setAddons((prev) => {
      const id = 'custom:' + manifestUrl;
      if (prev.some((a) => a.id === id)) return prev;
      return [...prev, {id, name: name || manifestUrl, manifestUrl, builtin: false, enabled: true}];
    });
  }, []);

  const remove = useCallback((id: string) => {
    setAddons((prev) => prev.filter((a) => a.builtin || a.id !== id));
  }, []);

  return {addons, toggle, add, remove, enabled: addons.filter((a) => a.enabled)};
}
