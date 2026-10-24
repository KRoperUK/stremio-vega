# Build the web app, then run the Node streaming server (which also serves the
# built app as static files). ffmpeg + ffprobe are installed in the runtime.

# ---- build the web app ------------------------------------------------------
FROM node:22-bookworm-slim AS appbuild
WORKDIR /app
COPY app/package.json app/package-lock.json* ./
RUN npm install
COPY app/ ./
RUN npm run build

# ---- runtime: server + ffmpeg ----------------------------------------------
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY server/package.json server/package-lock.json* ./
RUN npm install --omit=dev
COPY server/ ./
# Static app build served by the Node server from ./public.
COPY --from=appbuild /app/dist ./public

ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/index.js"]
