# ── Stage 1: build the React app into static files ──────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
# install deps first (layer cache)
COPY package.json ./
RUN npm install
# build
COPY . .
RUN npm run build      # -> /app/dist

# ── Stage 2: Caddy serving the built app + proxying the backend ─────────────
FROM caddy:2-alpine
COPY --from=build /app/dist /srv/www
# Caddyfile is provided at runtime via the compose bind-mount.
