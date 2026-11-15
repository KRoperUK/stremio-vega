import {useCallback, useEffect, useMemo, useState} from 'react';
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
import {useRecent, recentKey, type RecentItem} from './useRecent';
import type {AddonDef} from './config';

type View =
  | {name: 'home'}
  | {name: 'search'}
  | {name: 'detail'; type: string; id: string}
  | {name: 'browse'; manifestUrl: string; catType: string; catId: string; title: string}
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
  const {recent, record, setPosition, positionFor, remove: removeRecent} = useRecent();

  // Stable progress callback, re-created only when the playing item changes.
  // (An inline closure here would be a new function every render, re-binding
  // the Player's effect on each progress write — a render loop during
  // playback. Keying on the resume key keeps the effect bound once per stream.)
  const playingKey = playing?.resumeKey ?? '';
  const handleProgress = useCallback(
    (pos: number, dur: number) => {
      if (!playingKey) return;
      // Near the end (~95%): the item is effectively watched — drop it
      // from Continue watching rather than leaving it stuck at the end.
      if (dur > 0 && pos / dur >= 0.95) {
        removeRecent(playingKey);
      } else {
        setPosition(playingKey, pos, dur);
      }
    },
    [playingKey, removeRecent, setPosition],
  );

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
      if (next.name === 'detail' || next.name === 'browse') return [...s, next];
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
            recent={recent}
            onRemoveRecent={removeRecent}
            onOpen={(t, id) => go({name: 'detail', type: t, id})}
            onBrowse={(manifestUrl, catType, catId, title) =>
              go({name: 'browse', manifestUrl, catType, catId, title})
            }
          />
        )}
        {view.name === 'search' && (
          <Search catalogAddons={catalogAddons} manifests={manifests} onOpen={(t, id) => go({name: 'detail', type: t, id})} />
        )}
        {view.name === 'browse' && (
          <Browse
            manifestUrl={view.manifestUrl}
            catType={view.catType}
            catId={view.catId}
            title={view.title}
            manifests={manifests}
            onOpen={(t, id) => go({name: 'detail', type: t, id})}
            onBack={back}
          />
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
          onProgress={handleProgress}
          onClose={() => setPlaying(null)}
        />
      )}
    </div>
  );
}

function Grid({metas, onOpen}: {metas: MetaPreview[]; onOpen: (t: string, id: string) => void}) {
  return (
    <div className="grid">
      {metas.map((m) => {
        const year = m.year || m.releaseInfo;
        const rating = m.imdbRating && m.imdbRating.trim();
        return (
          <button key={m.type + m.id} className="card" onClick={() => onOpen(m.type, m.id)}>
            <span className="poster-wrap">
              {m.poster ? <img src={m.poster} alt={m.name} loading="lazy" /> : <div className="noposter" />}
              {rating && <span className="badge rating">★ {rating}</span>}
              {year && <span className="badge year">{year}</span>}
            </span>
            <span className="card-title">{m.name}</span>
          </button>
        );
      })}
    </div>
  );
}

// Continue-watching row: each card shows a resume progress bar and an X to
// remove it from the list.
function ContinueRow({
  items,
  onOpen,
  onRemove,
}: {
  items: RecentItem[];
  onOpen: (t: string, id: string) => void;
  onRemove: (key: string) => void;
}) {
  return (
    <div className="grid">
      {items.map((r) => {
        const key = recentKey(r.type, r.id, r.videoId);
        const pct =
          r.position && r.duration && r.duration > 0
            ? Math.min(100, Math.round((r.position / r.duration) * 100))
            : 0;
        return (
          <div key={key} className="card continue">
            <button className="card-main" onClick={() => onOpen(r.type, r.id)}>
              {r.poster ? <img src={r.poster} alt={r.name} loading="lazy" /> : <div className="noposter" />}
              {pct > 0 && (
                <span className="progress" aria-label={`${pct}% watched`}>
                  <span className="progress-fill" style={{width: `${pct}%`}} />
                </span>
              )}
              <span className="card-title">
                {r.name}
                {r.label ? ` · ${r.label}` : ''}
              </span>
            </button>
            <button
              className="remove"
              aria-label={`Remove ${r.name} from Continue watching`}
              title="Remove"
              onClick={() => onRemove(key)}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}

interface Row {
  key: string;
  manifestUrl: string;
  catType: string;
  catId: string;
  title: string;
  metas: MetaPreview[];
  skip: number; // items already loaded (for the next page)
  hasMore: boolean;
  supportsGenre: boolean;
  loadingMore: boolean;
}

const PAGE = 20;

function Home({
  catalogAddons,
  manifests,
  recent,
  onRemoveRecent,
  onOpen,
  onBrowse,
}: {
  catalogAddons: AddonDef[];
  manifests: Record<string, Manifest>;
  recent: RecentItem[];
  onRemoveRecent: (key: string) => void;
  onOpen: (t: string, id: string) => void;
  onBrowse: (manifestUrl: string, catType: string, catId: string, title: string) => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [genre, setGenre] = useState<string>(''); // '' = all

  // Union of genre options across catalogs that support a (non-required) genre
  // filter — used to render the genre chip bar.
  const genres = useMemo(() => {
    const set = new Set<string>();
    for (const a of catalogAddons) {
      for (const cat of manifests[a.manifestUrl]?.catalogs || []) {
        const g = (cat.extra || []).find((e) => e.name === 'genre' && !e.isRequired);
        for (const opt of g?.options || []) set.add(opt);
      }
    }
    return Array.from(set).slice(0, 24);
  }, [catalogAddons, manifests]);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    (async () => {
      // Ask every catalog at once (one round trip, not N sequential ones);
      // a failing addon settles rejected and never blocks the others.
      const tasks: {a: AddonDef; cat: NonNullable<Manifest['catalogs']>[number]; supportsGenre: boolean}[] = [];
      for (const a of catalogAddons) {
        const m = manifests[a.manifestUrl];
        for (const cat of (m?.catalogs || []).slice(0, 4)) {
          if ((cat.extra || []).some((e) => e.name === 'search' && e.isRequired)) continue;
          // A genre filter only applies to catalogs that advertise genre.
          const supportsGenre = (cat.extra || []).some((e) => e.name === 'genre');
          if (genre && !supportsGenre) continue;
          tasks.push({a, cat, supportsGenre});
        }
      }
      const sawCatalog = tasks.length > 0;
      const settled = await Promise.allSettled(
        tasks.map(async ({a, cat, supportsGenre}) => {
          const extra: Record<string, string> = {};
          if (genre && supportsGenre) extra.genre = genre;
          const {metas} = await getCatalog(a.manifestUrl, cat.type, cat.id, extra);
          const list = metas || [];
          const page = list.slice(0, PAGE);
          const row: Row = {
            key: `${a.manifestUrl}|${cat.type}|${cat.id}`,
            manifestUrl: a.manifestUrl,
            catType: cat.type,
            catId: cat.id,
            title: `${cat.name || cat.id} (${cat.type})`,
            metas: page,
            skip: page.length,
            hasMore: list.length >= PAGE,
            supportsGenre,
            loadingMore: false,
          };
          return row;
        }),
      );
      if (cancelled) return;
      const out: Row[] = [];
      let anyError = false;
      for (const s of settled) {
        if (s.status === 'fulfilled') {
          if (s.value.metas.length) out.push(s.value);
        } else {
          anyError = true;
        }
      }
      setRows(out);
      setStatus(out.length === 0 && anyError && sawCatalog ? 'error' : 'ready');
    })();
    return () => {
      cancelled = true;
    };
  }, [catalogAddons.map((a) => a.manifestUrl).join(','), manifests, attempt, genre]);

  // Load the next page for one row (skip = items already shown).
  const loadMore = useCallback(
    async (key: string) => {
      const row = rows.find((r) => r.key === key);
      if (!row || row.loadingMore || !row.hasMore) return;
      setRows((rs) => rs.map((r) => (r.key === key ? {...r, loadingMore: true} : r)));
      const extra: Record<string, string> = {skip: String(row.skip)};
      if (genre && row.supportsGenre) extra.genre = genre;
      try {
        const {metas} = await getCatalog(row.manifestUrl, row.catType, row.catId, extra);
        const next = metas || [];
        // Dedupe against what the row already holds.
        const seen = new Set(row.metas.map((m) => m.type + m.id));
        const added = next.filter((m) => !seen.has(m.type + m.id));
        setRows((rs) =>
          rs.map((r) =>
            r.key === key
              ? {
                  ...r,
                  metas: [...r.metas, ...added],
                  skip: r.skip + next.length,
                  hasMore: next.length >= PAGE,
                  loadingMore: false,
                }
              : r,
          ),
        );
      } catch {
        setRows((rs) => rs.map((r) => (r.key === key ? {...r, loadingMore: false, hasMore: false} : r)));
      }
    },
    [rows, genre],
  );

  return (
    <div className="rows">
      {recent.length > 0 && (
        <section>
          <h2>Continue watching</h2>
          <ContinueRow items={recent} onOpen={onOpen} onRemove={onRemoveRecent} />
        </section>
      )}

      {genres.length > 0 && (
        <div className="genre-bar" role="group" aria-label="Filter by genre">
          <button className={genre === '' ? 'genre active' : 'genre'} onClick={() => setGenre('')}>
            All
          </button>
          {genres.map((g) => (
            <button
              key={g}
              className={genre === g ? 'genre active' : 'genre'}
              onClick={() => setGenre(g === genre ? '' : g)}
            >
              {g}
            </button>
          ))}
        </div>
      )}

      {status === 'loading' && rows.length === 0 && <Spinner label="Loading catalogs…" />}
      {status === 'error' && (
        <ErrorBox label="Couldn't load catalogs." onRetry={() => setAttempt((n) => n + 1)} />
      )}
      {status === 'ready' && rows.length === 0 && recent.length === 0 && (
        <p className="hint">
          {genre ? `No ${genre} titles from enabled catalogs.` : 'Nothing to show yet — enable an addon with catalogs in the Addons tab.'}
        </p>
      )}

      {rows.map((r) => (
        <section key={r.key}>
          <div className="row-head">
            <h2>{r.title}</h2>
            <button className="see-all" onClick={() => onBrowse(r.manifestUrl, r.catType, r.catId, r.title)}>
              See all →
            </button>
          </div>
          <Grid metas={r.metas} onOpen={onOpen} />
          {r.hasMore && (
            <button className="load-more" disabled={r.loadingMore} onClick={() => void loadMore(r.key)}>
              {r.loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
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
    const tasks: {a: AddonDef; cat: NonNullable<Manifest['catalogs']>[number]}[] = [];
    for (const a of catalogAddons) {
      const m = manifests[a.manifestUrl];
      for (const cat of m?.catalogs || []) {
        if (!(cat.extra || []).some((e) => e.name === 'search')) continue;
        tasks.push({a, cat});
      }
    }
    // One concurrent round across every searchable catalog; failures skip.
    const settled = await Promise.allSettled(
      tasks.map(({a, cat}) => getCatalog(a.manifestUrl, cat.type, cat.id, {search: q})),
    );
    const seen = new Set<string>();
    const results: MetaPreview[] = [];
    for (const s of settled) {
      if (s.status !== 'fulfilled') continue;
      for (const it of s.value.metas || []) {
        const k = it.type + it.id;
        if (!seen.has(k)) {
          seen.add(k);
          results.push(it);
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

// Browse: a full grid for a single catalog, with its own genre filter and
// "Load more" pagination — reached from a row's "See all".
function Browse({
  manifestUrl,
  catType,
  catId,
  title,
  manifests,
  onOpen,
  onBack,
}: {
  manifestUrl: string;
  catType: string;
  catId: string;
  title: string;
  manifests: Record<string, Manifest>;
  onOpen: (t: string, id: string) => void;
  onBack: () => void;
}) {
  const [metas, setMetas] = useState<MetaPreview[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [skip, setSkip] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [genre, setGenre] = useState('');
  const [attempt, setAttempt] = useState(0);
  // Draft query vs. committed search: typing does not refetch; submitting
  // replaces the grid, clearing restores the genre/paginated listing.
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const searching = submitted !== '';

  const cat = (manifests[manifestUrl]?.catalogs || []).find((c) => c.type === catType && c.id === catId);
  const supportsGenre = (cat?.extra || []).some((e) => e.name === 'genre');
  const genres = ((cat?.extra || []).find((e) => e.name === 'genre')?.options || []).slice(0, 30);
  const supportsSearch = (cat?.extra || []).some((e) => e.name === 'search');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setMetas([]);
    (async () => {
      const extra: Record<string, string> = {};
      // An active search overrides the default (genre-filtered) listing.
      if (searching) extra.search = submitted;
      else if (genre && supportsGenre) extra.genre = genre;
      try {
        const {metas} = await getCatalog(manifestUrl, catType, catId, extra);
        if (cancelled) return;
        const list = metas || [];
        setMetas(list);
        setSkip(list.length);
        setHasMore(list.length >= PAGE);
        setStatus('ready');
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [manifestUrl, catType, catId, genre, supportsGenre, submitted, searching, attempt]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const extra: Record<string, string> = {skip: String(skip)};
    if (searching) extra.search = submitted;
    else if (genre && supportsGenre) extra.genre = genre;
    try {
      const {metas: next} = await getCatalog(manifestUrl, catType, catId, extra);
      const list = next || [];
      setMetas((prev) => {
        const seen = new Set(prev.map((m) => m.type + m.id));
        return [...prev, ...list.filter((m) => !seen.has(m.type + m.id))];
      });
      setSkip((s) => s + list.length);
      setHasMore(list.length >= PAGE);
    } catch {
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, skip, genre, supportsGenre, searching, submitted, manifestUrl, catType, catId]);

  return (
    <div className="browse">
      <button className="back" onClick={onBack}>
        ← Back
      </button>
      <h2>{title}</h2>

      {supportsSearch && (
        <form
          className="browse-search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(query.trim());
          }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${title}…`}
            aria-label={`Search within ${title}`}
          />
          <button type="submit">Go</button>
          {searching && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setSubmitted('');
              }}
            >
              Clear
            </button>
          )}
        </form>
      )}

      {!searching && genres.length > 0 && (
        <div className="genre-bar" role="group" aria-label="Filter by genre">
          <button className={genre === '' ? 'genre active' : 'genre'} onClick={() => setGenre('')}>
            All
          </button>
          {genres.map((g) => (
            <button
              key={g}
              className={genre === g ? 'genre active' : 'genre'}
              onClick={() => setGenre(g === genre ? '' : g)}
            >
              {g}
            </button>
          ))}
        </div>
      )}

      {status === 'loading' && <Spinner label="Loading…" />}
      {status === 'error' && <ErrorBox label="Couldn't load this catalog." onRetry={() => setAttempt((n) => n + 1)} />}
      {status === 'ready' && metas.length === 0 && (
        <p className="hint">{searching ? `No results for “${submitted}”.` : 'Nothing here.'}</p>
      )}

      <Grid metas={metas} onOpen={onOpen} />
      {hasMore && (
        <button className="load-more" disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
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
  // Trailer overlay (YouTube embed) — open only when a trailer is available.
  const [trailer, setTrailer] = useState(false);

  const isSeries = type === 'series';

  // While the trailer overlay is open, Back closes it instead of popping the
  // view. This listens on window/capture so it runs before App's own Back
  // handler on document (registered first, when App mounted).
  useEffect(() => {
    if (!trailer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'GoBack' || e.key === 'Escape' || e.keyCode === 27) {
        e.preventDefault();
        e.stopPropagation();
        setTrailer(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [trailer]);

  // Fetch meta: ask every capable addon concurrently, first success (in
  // addon order) wins. One failing addon never blocks the others.
  useEffect(() => {
    let cancelled = false;
    setMetaStatus('loading');
    setMeta(null);
    setSelected(null);
    setTrailer(false);
    (async () => {
      const capable = addons.filter((a) => {
        const m = manifests[a.manifestUrl];
        return m && hasResource(m, 'meta', type);
      });
      const settled = await Promise.allSettled(capable.map((a) => getMeta(a.manifestUrl, type, id)));
      let found: MetaDetail | null = null;
      for (const s of settled) {
        if (s.status === 'fulfilled' && s.value.meta) {
          found = s.value.meta;
          break;
        }
      }
      if (cancelled) return;
      setMeta(found);
      setMetaStatus(found || capable.length === 0 ? 'ready' : 'error');
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
      // Streams and subtitles fan out concurrently across capable addons;
      // results merge in addon order and failures never block the rest.
      const streamCapable = addons.filter((a) => {
        const m = manifests[a.manifestUrl];
        return m && hasResource(m, 'stream', type);
      });
      const subCapable = addons.filter((a) => {
        const m = manifests[a.manifestUrl];
        return m && hasResource(m, 'subtitles', type);
      });
      const [streamSettled, subSettled] = await Promise.all([
        Promise.allSettled(streamCapable.map((a) => getStreams(a.manifestUrl, type, streamId))),
        Promise.allSettled(subCapable.map((a) => getSubtitles(a.manifestUrl, type, streamId))),
      ]);
      if (cancelled) return;
      const all: Stream[] = [];
      let anyError = false;
      for (const s of streamSettled) {
        if (s.status === 'fulfilled') {
          for (const st of s.value.streams || []) all.push(st);
        } else {
          anyError = true;
        }
      }
      setStreams(all);
      setStreamStatus(all.length === 0 && anyError && streamCapable.length > 0 ? 'error' : 'ready');

      // Subtitles are best-effort and must never block or error the stream UI.
      const subs: Subtitle[] = [];
      const seenLang = new Set<string>();
      for (const s of subSettled) {
        if (s.status !== 'fulfilled') continue;
        for (const sub of s.value.subtitles || []) {
          // One entry per language keeps the picker short.
          if (sub.url && !seenLang.has(sub.lang)) {
            seenLang.add(sub.lang);
            subs.push(sub);
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

  const trailerId = meta?.trailerStreams?.find((t) => t.ytId)?.ytId;

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
        <DetailHero meta={meta} onTrailer={trailerId ? () => setTrailer(true) : undefined} />
      )}
      {trailer && trailerId && (
        <div className="trailer-overlay" role="dialog" aria-label={`${meta?.name || 'Video'} trailer`}>
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${trailerId}?autoplay=1&rel=0`}
            title={`${meta?.name || 'Video'} trailer`}
            allow="autoplay; encrypted-media"
            allowFullScreen
          />
          <button autoFocus onClick={() => setTrailer(false)}>
            ← Back
          </button>
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

// Hero header: full-width backdrop with a gradient scrim, the logo (or the
// title), a meta line (year · runtime · rating · genres), a compact
// credits line, and a Trailer action only when a trailer is available.
// Missing fields render nothing — no empty chrome.
function DetailHero({meta, onTrailer}: {meta: MetaDetail; onTrailer?: () => void}) {
  const year = meta.year || meta.releaseInfo;
  const rating = meta.imdbRating && meta.imdbRating.trim();
  const line = [year, meta.runtime, rating ? `★ ${rating}` : '', ...(meta.genres || []).slice(0, 3)]
    .filter(Boolean)
    .join(' · ');
  const cast = (meta.cast || []).slice(0, 5);
  const directors = Array.isArray(meta.director) ? meta.director : meta.director ? [meta.director] : [];
  return (
    <div className="detail-head" style={meta.background ? {backgroundImage: `url(${meta.background})`} : undefined}>
      {meta.logo ? <img className="hero-logo" src={meta.logo} alt="" /> : <h1>{meta.name}</h1>}
      {line && <div className="hero-meta">{line}</div>}
      {(cast.length > 0 || directors.length > 0) && (
        <div className="hero-credits">
          {cast.length > 0 && <span>Starring {cast.join(', ')}</span>}
          {directors.length > 0 && <span>Directed by {directors.join(', ')}</span>}
        </div>
      )}
      {onTrailer && (
        <button className="trailer" onClick={onTrailer}>
          ▶ Trailer
        </button>
      )}
      {meta.description && <p>{meta.description}</p>}
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
