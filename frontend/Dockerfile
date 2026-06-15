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
# Entrypoint selects TLS strategy (internal / auto / http) from TLS_MODE at start.
COPY caddy-entrypoint.sh /usr/local/bin/caddy-entrypoint.sh
RUN chmod +x /usr/local/bin/caddy-entrypoint.sh
# Caddyfile is provided at runtime via the compose bind-mount.
ENTRYPOINT ["/usr/local/bin/caddy-entrypoint.sh"]
