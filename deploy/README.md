# Backend: web app + codec-aware streaming server (`deploy/`, `app/`, `server/`)

The Vega / Fire TV app (repo root) is a thin WebView that loads **our own** web
client over HTTPS. That client and the streaming server are this stack.

```
app/      custom React/Vite web client (Stremio addon protocol: catalogs,
          search, detail, stream pick, player). Toggleable Cinemeta +
          Archive.org public-domain addons, plus add-your-own addon URLs.
server/   Node/Express streaming server: serves the built app + a /api that
          probes each stream's codec and PASSES IT THROUGH when the Fire Stick
          can decode it, or TRANSCODES with ffmpeg only when it cannot.
deploy/   Dockerfile (builds app, runs server + ffmpeg) + compose + .env.
```

## Why this instead of hosting stremio-web

Forcing the full `stremio-web` into the Vega WebView was fragile — settings
injection, WASM-core internals, a persisted-server mismatch. This is a smaller,
fully-owned app that speaks the open **Stremio addon protocol** (so Cinemeta,
Debridio, Torrentio, … still work) with a player we control.

## Codec handling (the point)

`GET /api/stream?url=<source>&t=<token>`:
1. `ffprobe` the source (header only; the decision is cached for a few minutes).
2. If video+audio+container are **Vega-native** → **proxy** the bytes straight
   through (range-aware, zero VPS CPU): the Fire Stick fetches and
   hardware-decodes them, but every byte stays on this HTTPS origin. A 302
   redirect to the source would fail on the Stick (often-HTTP origins, missing
   CORS, media loaders that will not follow cross-origin redirects).
3. Else, if only the container is off (e.g. `.ts`/AVI holding H.264+AAC) →
   `ffmpeg -c copy` remux into fragmented MP4 (no re-encode).
4. Else → re-encode only the unsupported track(s) to H.264/AAC, into
   fragmented MP4 over a chunked response. Concurrent re-encodes are bounded
   (extras get a retryable 429, never a pile-up).

Vega-native: video H.264/HEVC/VP8/VP9/AV1, audio AAC/MP3/AC3/E-AC3/Opus/FLAC/
Vorbis, container mp4/webm-mkv/hls. Anything else is remuxed or transcoded.

## Security

`/api` is gated by `SERVER_TOKEN` (query `t` or `X-Token`), and fails
closed with `503` when the token is unset. The built app ships
no secret; the server injects the token into `index.html` at serve time, so
only a client that reached this origin (behind the tunnel) receives it.
The token gate is the second layer: the first must be tunnel-level access
control. See [docs/LOCKDOWN.md](../docs/LOCKDOWN.md) for the threat model,
the owner runbook, and the human verification steps (issue #21).

## Run locally

```bash
cp deploy/.env.example deploy/.env        # set SERVER_TOKEN
docker compose -f deploy/docker-compose.yml up --build
# app + api: http://127.0.0.1:8080/
# probe a stream:  http://127.0.0.1:8080/api/probe?url=<src>&t=<token>
```

Dev (two terminals, no Docker):

```bash
cd server && npm install && SERVER_TOKEN=dev npm start           # :8080
cd app && npm install && VITE_SERVER_BASE=http://localhost:8080 \
  VITE_SERVER_TOKEN=dev npm run dev                              # :5173
```
