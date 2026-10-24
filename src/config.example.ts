// App configuration template. Copy to `config.ts` (gitignored) and fill in the
// real values; `config.ts` is what the app imports. The secret server token
// must never be committed, so it lives only in the local `config.ts`.
//
// There is no runtime process.env on Vega/Hermes and Metro does not inline
// arbitrary env vars, so the token is a literal in config.ts rather than an
// env var.

export interface AppConfig {
  // Origin that serves the stremio-web UI (the WebView loads this).
  baseUrl: string;
  // Full streaming-server URL forced into stremio-web's settings, including the
  // secret token path segment, with a trailing slash.
  // e.g. https://stremio-vega.example/s/<token>/
  streamingServerUrl: string;
}

export const config: AppConfig = {
  baseUrl: 'https://stremio-vega.kroper.uk',
  // Replace <token> with the SERVER_TOKEN deployed on the backend.
  streamingServerUrl: 'https://stremio-vega.kroper.uk/s/<token>/',
};
