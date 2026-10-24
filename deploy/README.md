# Backend stack (`deploy/`)

The Vega app is a thin WebView client. The heavy lifting — serving the
`stremio-web` UI and running the Stremio **streaming server** (which remuxes and
transcodes addon/torrent streams into something the Vega media pipeline can
play) — happens in this container stack, deployed to an always-on host.

A real device cannot run the streaming server itself, and Vega's WebView blocks
mixed content and `file://`-origin multi-file apps, so the clean architecture is
a single HTTPS origin that serves **both** the UI and a reverse proxy to the
streaming server.

## Layout

```
deploy/
  docker-compose.yml     streaming-server + web (UI + token-gated CORS proxy)
  Dockerfile.web         builds stremio-web, serves it + proxy via nginx
  nginx.conf.template    UI at / , proxy at /s/<token>/ , CORS, SPA fallback
  .env.example           SERVER_TOKEN, WEB_PORT
```

## How it fits together

- `/` serves the static `stremio-web` UI.
- `/s/<SERVER_TOKEN>/…` reverse-proxies the streaming server, adding permissive
  CORS. A wrong/absent token returns 403, so the public hostname is not an open
  transcoder.
- The app's `streamingServerUrl` is set to `https://<host>/s/<SERVER_TOKEN>/`.

### Why a URL-path token (and not mTLS or a device id)

The Vega WebView cannot present a client certificate or attach a custom auth
header on the streaming server requests it makes, and the Vega SDK exposes no
per-device serial to the app. A secret URL-path segment is the one scheme that
works end to end with `stremio-web` unmodified. Rotate it by changing
`SERVER_TOKEN` and the value baked into the app.

### Transcoding

The Stremio streaming server bundles ffmpeg and transcodes on the fly when a
stream's codec/container is not directly playable. Tuning (horsepower, max
width, hardware accel) is a runtime setting with sensible software-transcode
defaults; it is not configured here.

## Run locally

```bash
cp deploy/.env.example deploy/.env   # set SERVER_TOKEN
docker compose -f deploy/docker-compose.yml up --build
# UI:     http://127.0.0.1:8080/
# server: http://127.0.0.1:8080/s/<SERVER_TOKEN>/settings
```

TLS termination and public exposure are handled by the host's own reverse
proxy / tunnel, out of band from this stack.
