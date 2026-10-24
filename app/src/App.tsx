import {useCallback, useEffect, useState} from 'react';
import {useAddons} from './useAddons';
import {
  getCatalog,
  getManifest,
  getMeta,
  getStreams,
  hasResource,
  type Manifest,
  type MetaDetail,
  type MetaPreview,
  type Stream,
} from './addon';
import {Player} from './Player';
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

export function App() {
  const {addons, toggle, add, remove, enabled} = useAddons();
  const manifests = useManifests(enabled);
  const [view, setView] = useState<View>({name: 'home'});
  const [playing, setPlaying] = useState<Stream | null>(null);

  const catalogAddons = enabled.filter((a) => manifests[a.manifestUrl] && hasResource(manifests[a.manifestUrl], 'catalog'));

  return (
    <div className="app">
      <nav className="topbar">
        <span className="brand">Vega Stream</span>
        <button onClick={() => setView({name: 'home'})}>Home</button>
        <button onClick={() => setView({name: 'search'})}>Search</button>
        <button onClick={() => setView({name: 'addons'})}>Addons</button>
      </nav>

      {view.name === 'home' && (
        <Home catalogAddons={catalogAddons} manifests={manifests} onOpen={(t, id) => setView({name: 'detail', type: t, id})} />
      )}
      {view.name === 'search' && (
        <Search catalogAddons={catalogAddons} manifests={manifests} onOpen={(t, id) => setView({name: 'detail', type: t, id})} />
      )}
      {view.name === 'detail' && (
        <Detail
          type={view.type}
          id={view.id}
          addons={enabled}
          manifests={manifests}
          onPlay={setPlaying}
          onBack={() => setView({name: 'home'})}
        />
      )}
      {view.name === 'addons' && (
        <Addons addons={addons} toggle={toggle} add={add} remove={remove} />
      )}

      {playing && <Player stream={playing} onClose={() => setPlaying(null)} />}
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
  onOpen,
}: {
  catalogAddons: AddonDef[];
  manifests: Record<string, Manifest>;
  onOpen: (t: string, id: string) => void;
}) {
  const [rows, setRows] = useState<{title: string; metas: MetaPreview[]}[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out: {title: string; metas: MetaPreview[]}[] = [];
      for (const a of catalogAddons) {
        const m = manifests[a.manifestUrl];
        for (const cat of (m.catalogs || []).slice(0, 4)) {
          // skip search-only catalogs here
          if ((cat.extra || []).some((e) => e.name === 'search' && e.isRequired)) continue;
          try {
            const {metas} = await getCatalog(a.manifestUrl, cat.type, cat.id);
            if (metas?.length) out.push({title: `${cat.name || cat.id} (${cat.type})`, metas: metas.slice(0, 20)});
          } catch {
            /* skip failing catalog */
          }
        }
      }
      if (!cancelled) setRows(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [catalogAddons.map((a) => a.manifestUrl).join(','), manifests]);

  if (!rows.length) return <p className="hint">Loading catalogs… (enable addons if empty)</p>;
  return (
    <div className="rows">
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
  onPlay: (s: Stream) => void;
  onBack: () => void;
}) {
  const [meta, setMeta] = useState<MetaDetail | null>(null);
  const [streams, setStreams] = useState<Stream[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // meta from the first addon that has it
      for (const a of addons) {
        const m = manifests[a.manifestUrl];
        if (m && hasResource(m, 'meta', type)) {
          try {
            const {meta} = await getMeta(a.manifestUrl, type, id);
            if (!cancelled && meta) {
              setMeta(meta);
              break;
            }
          } catch {
            /* try next */
          }
        }
      }
      // streams from every addon that provides them
      const all: Stream[] = [];
      for (const a of addons) {
        const m = manifests[a.manifestUrl];
        if (m && hasResource(m, 'stream', type)) {
          try {
            const {streams} = await getStreams(a.manifestUrl, type, id);
            for (const s of streams || []) all.push(s);
          } catch {
            /* skip */
          }
        }
      }
      if (!cancelled) setStreams(all);
    })();
    return () => {
      cancelled = true;
    };
  }, [type, id, addons.map((a) => a.manifestUrl).join(','), manifests]);

  return (
    <div className="detail">
      <button className="back" onClick={onBack}>
        ← Back
      </button>
      {meta && (
        <div className="detail-head" style={meta.background ? {backgroundImage: `url(${meta.background})`} : undefined}>
          <h1>{meta.name}</h1>
          {meta.runtime && <span>{meta.runtime}</span>}
          {meta.description && <p>{meta.description}</p>}
        </div>
      )}
      <h2>Streams</h2>
      {streams === null && <p className="hint">Finding streams…</p>}
      {streams?.length === 0 && <p className="hint">No streams from enabled addons.</p>}
      <ul className="streams">
        {(streams || [])
          .filter((s) => s.url)
          .map((s, i) => (
            <li key={i}>
              <button onClick={() => onPlay(s)}>▶ {s.name || s.title || s.description || `Stream ${i + 1}`}</button>
            </li>
          ))}
      </ul>
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
