import {useCallback, useEffect, useState} from 'react';
import {useAddons} from './useAddons';
import {
  getCatalog,
  getManifest,
  getMeta,
  getStreams,
  getSubtitles,
  hasResource,
  type Manifest,
  type MetaDetail,
  type MetaPreview,
  type Stream,
  type Subtitle,
} from './addon';
import {Player} from './Player';
import {useSpatialNav, focusFirst} from './useSpatialNav';
import {useRecent, recentToPreview, recentKey} from './useRecent';
import type {AddonDef} from './config';

type View =
  | {name: 'home'}
  | {name: 'search'}
  | {name: 'detail'; type: string; id: string}
  | {name: 'addons'};

// Resolve each enabled addon's manifest once, cache it.
function useManifests(addons: AddonDef[]) {
  const [manifests, setManifests] = useState<Record<string, Manifest>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        addons.map(async (a) => {
          try {
            return [a.manifestUrl, await getManifest(a.manifestUrl)] as const;
          } catch {
            return null;
          }
        }),
      );
      if (!cancelled) {
        setManifests(Object.fromEntries(entries.filter(Boolean) as [string, Manifest][]));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [addons.map((a) => a.manifestUrl).join(',')]);
  return manifests;
}

// Tell the Vega WebView wrapper to exit the app (it listens for this message
// and calls BackHandler.exitApp()). No-op in a plain browser.
function requestAppExit() {
  try {
    (window as unknown as {ReactNativeWebView?: {postMessage: (m: string) => void}}).ReactNativeWebView?.postMessage(
      'EXIT_APP',
    );
  } catch {
    /* not in the WebView */
  }
}

export function App() {
  const {addons, toggle, add, remove, enabled} = useAddons();
  const manifests = useManifests(enabled);
  // View history stack — the bottom is always Home, so Back pops one level and
  // only exits the app when already at the root.
  const [stack, setStack] = useState<View[]>([{name: 'home'}]);
  const [playing, setPlaying] = useState<{
    stream: Stream;
    subtitles: Subtitle[];
    resumeKey: string;
    startAt: number;
  } | null>(null);
  const {recent, record, setPosition, positionFor} = useRecent();

  const view = stack[stack.length - 1];

  // D-pad / remote focus navigation (arrow keys move focus, Enter activates).
  useSpatialNav();

  // When the view changes (or the player closes), move focus to the first
  // actionable element so the remote always has a starting point. Deferred a
  // tick so the new view has rendered. While the player is open we leave focus
  // on the <video> (the Player focuses it itself).
  useEffect(() => {
    if (playing) return;
    const id = setTimeout(() => focusFirst(document.querySelector('.content') ?? document), 60);
    return () => clearTimeout(id);
  }, [view.name, view.name === 'detail' ? view.id : '', playing]);

  const go = useCallback((next: View) => {
    setStack((s) => {
      // Opening a detail page pushes onto the stack (so Back returns to where
      // you were). Top-nav targets (home/search/addons) replace the stack with
      // [home] (+ the target), so Back from a top-level view exits rather than
      // cycling through the other tabs.
      if (next.name === 'detail') return [...s, next];
      const top = s[s.length - 1];
      if (top.name === next.name) return s;
      return next.name === 'home' ? [{name: 'home'}] : [{name: 'home'}, next];
    });
  }, []);

  // Single back action, used by the on-screen buttons and the remote Back key.
  const back = useCallback(() => {
    if (playing) {
      setPlaying(null);
      return;
    }
    setStack((s) => {
      if (s.length > 1) return s.slice(0, -1);
      requestAppExit(); // already at root
      return s;
    });
  }, [playing]);

  // Remote Back / keyboard Escape pops the stack. Capture phase so it runs
  // before the page's default handling. back() closes the player first when
  // one is open, so a single press never both closes the player and pops a
  // view (the Player has no key listener of its own).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'GoBack' || e.key === 'Escape' || e.keyCode === 27) {
        e.preventDefault();
        back();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [back]);

  const catalogAddons = enabled.filter((a) => manifests[a.manifestUrl] && hasResource(manifests[a.manifestUrl], 'catalog'));

  // Start a stream and record it in "Continue watching". Carries subtitles and
  // resumes from the saved position for this exact item.
  const playStream = useCallback(
    (
      s: Stream,
      ctx: {
        meta: {id: string; type: string; name: string; poster?: string} | null;
        videoId?: string;
        label?: string;
        subtitles?: Subtitle[];
      },
    ) => {
      let resumeKey = '';
      let startAt = 0;
      if (ctx.meta) {
        resumeKey = recentKey(ctx.meta.type, ctx.meta.id, ctx.videoId);
        startAt = positionFor(resumeKey);
        record({
          type: ctx.meta.type,
          id: ctx.meta.id,
          name: ctx.meta.name,
          poster: ctx.meta.poster,
          videoId: ctx.videoId,
          label: ctx.label,
        });
      }
      setPlaying({stream: s, subtitles: ctx.subtitles ?? [], resumeKey, startAt});
    },
    [record, positionFor],
  );

  return (
    <div className="app">
      <nav className="topbar">
        <span className="brand">Vega Stream</span>
        <button onClick={() => go({name: 'home'})}>Home</button>
        <button onClick={() => go({name: 'search'})}>Search</button>
        <button onClick={() => go({name: 'addons'})}>Addons</button>
      </nav>

      <main className="content">
        {view.name === 'home' && (
          <Home
            catalogAddons={catalogAddons}
            manifests={manifests}
            recent={recent.map(recentToPreview)}
            onOpen={(t, id) => go({name: 'detail', type: t, id})}
          />
        )}
        {view.name === 'search' && (
          <Search catalogAddons={catalogAddons} manifests={manifests} onOpen={(t, id) => go({name: 'detail', type: t, id})} />
        )}
        {view.name === 'detail' && (
          <Detail
            type={view.type}
            id={view.id}
            addons={enabled}
            manifests={manifests}
            onPlay={playStream}
            onBack={back}
          />
        )}
        {view.name === 'addons' && (
          <Addons addons={addons} toggle={toggle} add={add} remove={remove} />
        )}
      </main>

      {playing && (
        <Player
          stream={playing.stream}
          subtitles={playing.subtitles}
          startAt={playing.startAt}
          onProgress={(pos, dur) => {
            if (playing.resumeKey) setPosition(playing.resumeKey, pos, dur);
          }}
          onClose={() => setPlaying(null)}
        />
      )}
    </div>
  );
}

function Grid({metas, onOpen}: {metas: MetaPreview[]; onOpen: (t: string, id: string) => void}) {
  return (
    <div className="grid">
      {metas.map((m) => (
        <button key={m.type + m.id} className="card" onClick={() => onOpen(m.type, m.id)}>
          {m.poster ? <img src={m.poster} alt={m.name} loading="lazy" /> : <div className="noposter" />}
          <span className="card-title">{m.name}</span>
        </button>
      ))}
    </div>
  );
}

function Home({
  catalogAddons,
  manifests,
  recent,
  onOpen,
}: {
  catalogAddons: AddonDef[];
  manifests: Record<string, Manifest>;
  recent: MetaPreview[];
  onOpen: (t: string, id: string) => void;
}) {
  const [rows, setRows] = useState<{title: string; metas: MetaPreview[]}[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    (async () => {
      const out: {title: string; metas: MetaPreview[]}[] = [];
      let sawCatalog = false;
      let anyError = false;
      for (const a of catalogAddons) {
        const m = manifests[a.manifestUrl];
        for (const cat of (m.catalogs || []).slice(0, 4)) {
          // skip search-only catalogs here
          if ((cat.extra || []).some((e) => e.name === 'search' && e.isRequired)) continue;
          sawCatalog = true;
          try {
            const {metas} = await getCatalog(a.manifestUrl, cat.type, cat.id);
            if (metas?.length) out.push({title: `${cat.name || cat.id} (${cat.type})`, metas: metas.slice(0, 20)});
          } catch {
            anyError = true;
          }
        }
      }
      if (cancelled) return;
      setRows(out);
      setStatus(out.length === 0 && anyError && sawCatalog ? 'error' : 'ready');
    })();
    return () => {
      cancelled = true;
    };
  }, [catalogAddons.map((a) => a.manifestUrl).join(','), manifests, attempt]);

  return (
    <div className="rows">
      {recent.length > 0 && (
        <section>
          <h2>Continue watching</h2>
          <Grid metas={recent} onOpen={onOpen} />
        </section>
      )}

      {status === 'loading' && rows.length === 0 && <Spinner label="Loading catalogs…" />}
      {status === 'error' && (
        <ErrorBox label="Couldn't load catalogs." onRetry={() => setAttempt((n) => n + 1)} />
      )}
      {status === 'ready' && rows.length === 0 && recent.length === 0 && (
        <p className="hint">Nothing to show yet — enable an addon with catalogs in the Addons tab.</p>
      )}

      {rows.map((r, i) => (
        <section key={i}>
          <h2>{r.title}</h2>
          <Grid metas={r.metas} onOpen={onOpen} />
        </section>
      ))}
    </div>
  );
}

function Search({
  catalogAddons,
  manifests,
  onOpen,
}: {
  catalogAddons: AddonDef[];
  manifests: Record<string, Manifest>;
  onOpen: (t: string, id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [metas, setMetas] = useState<MetaPreview[]>([]);
  const run = useCallback(async () => {
    if (!q.trim()) return;
    const seen = new Set<string>();
    const results: MetaPreview[] = [];
    for (const a of catalogAddons) {
      const m = manifests[a.manifestUrl];
      for (const cat of m.catalogs || []) {
        if (!(cat.extra || []).some((e) => e.name === 'search')) continue;
        try {
          const {metas: r} = await getCatalog(a.manifestUrl, cat.type, cat.id, {search: q});
          for (const it of r || []) {
            const k = it.type + it.id;
            if (!seen.has(k)) {
              seen.add(k);
              results.push(it);
            }
          }
        } catch {
          /* skip */
        }
      }
    }
    setMetas(results);
  }, [q, catalogAddons, manifests]);

  return (
    <div className="search">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search movies & series…" />
        <button type="submit">Go</button>
      </form>
      <Grid metas={metas} onOpen={onOpen} />
    </div>
  );
}

function Detail({
  type,
  id,
  addons,
  manifests,
  onPlay,
  onBack,
}: {
  type: string;
  id: string;
  addons: AddonDef[];
  manifests: Record<string, Manifest>;
  onPlay: (
    s: Stream,
    ctx: {meta: MetaDetail | null; videoId?: string; label?: string; subtitles?: Subtitle[]},
  ) => void;
  onBack: () => void;
}) {
  const [meta, setMeta] = useState<MetaDetail | null>(null);
  const [metaStatus, setMetaStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  // For series the user first picks an episode; selected holds its video id.
  const [selected, setSelected] = useState<{videoId: string; label: string} | null>(null);
  const [streams, setStreams] = useState<Stream[] | null>(null);
  const [streamStatus, setStreamStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  // Bumped by the Retry buttons to re-run the effects.
  const [attempt, setAttempt] = useState(0);

  const isSeries = type === 'series';

  // Fetch meta.
  useEffect(() => {
    let cancelled = false;
    setMetaStatus('loading');
    setMeta(null);
    setSelected(null);
    (async () => {
      let found: MetaDetail | null = null;
      let sawAddon = false;
      for (const a of addons) {
        const m = manifests[a.manifestUrl];
        if (m && hasResource(m, 'meta', type)) {
          sawAddon = true;
          try {
            const {meta} = await getMeta(a.manifestUrl, type, id);
            if (meta) {
              found = meta;
              break;
            }
          } catch {
            /* try next */
          }
        }
      }
      if (cancelled) return;
      setMeta(found);
      setMetaStatus(found || !sawAddon ? 'ready' : 'error');
    })();
    return () => {
      cancelled = true;
    };
  }, [type, id, addons.map((a) => a.manifestUrl).join(','), manifests, attempt]);

  // Fetch streams. For a movie, as soon as meta is ready; for a series, once an
  // episode is selected (streams are keyed by the episode's video id).
  const streamId = isSeries ? selected?.videoId : id;
  useEffect(() => {
    if (isSeries && !selected) {
      setStreams(null);
      setStreamStatus('idle');
      return;
    }
    if (!streamId) return;
    let cancelled = false;
    setStreamStatus('loading');
    setStreams(null);
    setSubtitles([]);
    (async () => {
      const all: Stream[] = [];
      let sawAddon = false;
      let anyError = false;
      for (const a of addons) {
        const m = manifests[a.manifestUrl];
        if (m && hasResource(m, 'stream', type)) {
          sawAddon = true;
          try {
            const {streams} = await getStreams(a.manifestUrl, type, streamId);
            for (const s of streams || []) all.push(s);
          } catch {
            anyError = true;
          }
        }
      }
      if (cancelled) return;
      setStreams(all);
      setStreamStatus(all.length === 0 && anyError && sawAddon ? 'error' : 'ready');

      // Subtitles are best-effort and must never block or error the stream UI.
      const subs: Subtitle[] = [];
      const seenLang = new Set<string>();
      for (const a of addons) {
        const m = manifests[a.manifestUrl];
        if (m && hasResource(m, 'subtitles', type)) {
          try {
            const {subtitles} = await getSubtitles(a.manifestUrl, type, streamId);
            for (const s of subtitles || []) {
              // One entry per language keeps the picker short.
              if (s.url && !seenLang.has(s.lang)) {
                seenLang.add(s.lang);
                subs.push(s);
              }
            }
          } catch {
            /* skip addon */
          }
        }
      }
      if (!cancelled) setSubtitles(subs);
    })();
    return () => {
      cancelled = true;
    };
  }, [streamId, isSeries, selected, type, addons.map((a) => a.manifestUrl).join(','), manifests, attempt]);

  const episodes = (meta?.videos || [])
    .slice()
    .sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));

  const epLabel = (v: {season?: number; episode?: number; title?: string}) =>
    v.season != null && v.episode != null ? `S${v.season}E${v.episode}` : v.title || 'Episode';

  return (
    <div className="detail">
      <button className="back" onClick={onBack}>
        ← Back
      </button>

      {metaStatus === 'loading' && <Spinner label="Loading…" />}
      {metaStatus === 'error' && (
        <ErrorBox label="Couldn't load details." onRetry={() => setAttempt((n) => n + 1)} />
      )}

      {meta && (
        <div className="detail-head" style={meta.background ? {backgroundImage: `url(${meta.background})`} : undefined}>
          <h1>{meta.name}</h1>
          {meta.runtime && <span>{meta.runtime}</span>}
          {meta.description && <p>{meta.description}</p>}
        </div>
      )}

      {isSeries && episodes.length > 0 && (
        <>
          <h2>Episodes</h2>
          <ul className="streams">
            {episodes.map((v) => {
              const label = epLabel(v);
              const active = selected?.videoId === v.id;
              return (
                <li key={v.id}>
                  <button
                    className={active ? 'episode active' : 'episode'}
                    onClick={() => setSelected({videoId: v.id, label})}
                  >
                    {label}
                    {v.title ? ` · ${v.title}` : ''}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {(!isSeries || selected) && (
        <>
          <h2>Streams{isSeries && selected ? ` · ${selected.label}` : ''}</h2>
          {streamStatus === 'loading' && <Spinner label="Finding streams…" />}
          {streamStatus === 'error' && (
            <ErrorBox label="Couldn't fetch streams." onRetry={() => setAttempt((n) => n + 1)} />
          )}
          {streamStatus === 'ready' && streams?.length === 0 && (
            <p className="hint">No streams from enabled addons.</p>
          )}
          <ul className="streams">
            {(streams || [])
              .filter((s) => s.url)
              .map((s, i) => (
                <li key={i}>
                  <button
                    onClick={() =>
                      onPlay(s, {meta, videoId: selected?.videoId, label: selected?.label, subtitles})
                    }
                  >
                    ▶ {s.name || s.title || s.description || `Stream ${i + 1}`}
                  </button>
                </li>
              ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Spinner({label}: {label: string}) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function ErrorBox({label, onRetry}: {label: string; onRetry: () => void}) {
  return (
    <div className="errorbox" role="alert">
      <span>{label}</span>
      <button onClick={onRetry}>Retry</button>
    </div>
  );
}

function Addons({
  addons,
  toggle,
  add,
  remove,
}: {
  addons: AddonDef[];
  toggle: (id: string) => void;
  add: (name: string, url: string) => void;
  remove: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  return (
    <div className="addons">
      <h2>Addons</h2>
      <ul>
        {addons.map((a) => (
          <li key={a.id}>
            <label>
              <input type="checkbox" checked={a.enabled} onChange={() => toggle(a.id)} /> {a.name}
            </label>
            {a.builtin ? <em> (built-in)</em> : <button onClick={() => remove(a.id)}>remove</button>}
          </li>
        ))}
      </ul>
      <h3>Add an addon</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) {
            add(name.trim(), url.trim());
            setName('');
            setUrl('');
          }
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (e.g. Debridio)" />
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/manifest.json" />
        <button type="submit">Add</button>
      </form>
      <p className="hint">Paste any Stremio addon manifest URL (Debridio, Torrentio, etc.).</p>
    </div>
  );
}
