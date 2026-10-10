# syntax=docker/dockerfile:1
#
# A small image that serves a manufakture build with Caddy (deploy/Caddyfile, docs/hosting.md).
# It does not build the app: build it first (`pnpm build`), then pass apps/web/dist as the named
# build context `site`, with this directory as the main context:
#
#   docker build -f deploy/Dockerfile --build-context site=apps/web/dist -t manufakture-web deploy
#
# The image listens on port 8080 (plain HTTP; TLS ends at the ingress) and runs as a non-root
# user. It writes nothing but Caddy's small state under /tmp.

# Precompress once, at image build time: brotli at its best quality (the 42.7 MB kernel .wasm
# goes to about 8.2 MB, which takes about a minute) and gzip for clients without brotli. Caddy
# sends the sidecar files as they are (`precompressed br gzip`); the originals stay for clients
# that accept neither.
FROM alpine:3.22 AS compress
RUN apk add --no-cache brotli gzip
COPY --from=site . /srv
RUN find /srv -type f -size +1k \
      \( -name '*.wasm' -o -name '*.js' -o -name '*.mjs' -o -name '*.css' -o -name '*.html' \
         -o -name '*.svg' -o -name '*.json' -o -name '*.webmanifest' -o -name '*.ttf' \) \
      -print0 \
    | xargs -0 -n 1 -P "$(nproc)" sh -c 'brotli --best --keep "$0" && gzip -9 --keep "$0"'

# Caddy 2.11 or later: 2.10 answers every precompressed file with 206 Partial Content.
FROM caddy:2.11-alpine
# The base image gives the binary cap_net_bind_service as a file capability. Port 8080 does not
# need it, and with every capability dropped and no privilege escalation (deploy/k8s/), the kernel
# refuses to exec a binary that carries one ("operation not permitted").
RUN setcap -r /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
COPY --from=compress /srv /srv
ENV XDG_CONFIG_HOME=/tmp/caddy/config \
    XDG_DATA_HOME=/tmp/caddy/data
USER 65532:65532
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
