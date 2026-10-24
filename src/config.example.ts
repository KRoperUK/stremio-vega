// App configuration template. Copy to `config.ts` (gitignored) and set the
// base URL. No secret lives here — the web app reads its token from the
// server-injected index.html.

export interface AppConfig {
  // HTTPS origin serving the web client + /api (the streaming server).
  baseUrl: string;
}

export const config: AppConfig = {
  baseUrl: 'https://stremio-vega.kroper.uk',
};
