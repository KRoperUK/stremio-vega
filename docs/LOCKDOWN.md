# Locking down the public server (issue #21)

## Threat model

The streaming server is reachable on a public host, and the built web app
ships **no secret**: the server injects `SERVER_TOKEN` into the served
`index.html` at request time (`injectToken` in `server/src/guard.js`), so
the token is handed to **every client that reaches this origin**. If the
origin is world-reachable, the token — and with it the whole `/api`
(transcoder, addon proxy, subtitle proxy) — is world-readable.

So the token gate is the **second** layer, not the first. The first layer
must be tunnel-level access control: anonymous internet users hit a login
wall before they can reach either the web app or the API.

## What the server already enforces (no owner action needed)

- `/api` (except `/api/health`, kept open for liveness probes) requires
  `SERVER_TOKEN` as `?t=` or the `X-Token` header.
- When `SERVER_TOKEN` is unset the API **fails closed** with `503`
  instead of serving open — an unconfigured server is never an open
  relay. Set `SERVER_TOKEN` (already required by `deploy/`) to restore
  access; nothing else can lock you out.
- Outbound addon/subtitle fetches are SSRF-guarded (public-IP only,
  redirects re-validated, bodies size-capped).
- Baseline headers on every response: `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.

## Owner runbook: put a login wall in front (human step)

Pick one — any of these satisfies the issue's acceptance criteria:

1. **Cloudflare Tunnel + Access** (recommended): route the public
   hostname through `cloudflared` and attach an Access policy (e.g.
   one-time PIN or Google allowlist for household members) to the
   hostname. Anonymous requests stop at the Access login page.
2. **Tailscale Serve/Funnel with authenticated users**, or keep the
   compose port on `127.0.0.1` (the default in
   `deploy/docker-compose.yml`) and reach it only over the tailnet —
   no public origin at all.
3. **Reverse-proxy basic auth** (Caddy/Traefik) in front of the
   container as a lighter alternative.

Do not expose the container port directly to the internet with no
auth layer: the served homepage would hand your `SERVER_TOKEN` to
anyone who asks.

## Verifying the lockdown (human step)

From an anonymous session (logged-out browser, or `curl` without
cookies/headers):

- `curl -s -o /dev/null -w '%{http_code}\n' https://<your-host>/`
  must **not** return the app — expect a login wall from the access
  layer (e.g. `302/401` to the login page), not `200` with HTML.
- `curl -s 'https://<your-host>/api/probe?u=https://example.com/x'`
  must fail the same way, without ever reaching the token check.

Then as a logged-in household member: open the app, browse, and play a
video end to end. Post the three results (anonymous root, anonymous
API, logged-in playback) on issue #21 — only a human with the tunnel
credentials can perform this check, so the issue stays open until then.
