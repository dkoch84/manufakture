# syntax=docker/dockerfile:1
#
# The sync server (apps/server/README.md) as an image. Build from the repository root:
#
#   docker build -f apps/server/Dockerfile -t manufakture-server .
#
# Run it with a volume for the database and the token from a file (or MANUFAKTURE_TOKEN):
#
#   docker run -d -p 127.0.0.1:8787:8787 -v manufakture-data:/data \
#     -v "$PWD/token:/run/secrets/token:ro" -e MANUFAKTURE_TOKEN_FILE=/run/secrets/token \
#     -e MANUFAKTURE_ORIGINS=https://cad.example.internal manufakture-server
#
# It listens on port 8787 (plain HTTP: put TLS in front of it, see the README) and runs as the
# non-root `node` user; the only thing it writes is the database under /data.

FROM node:24-bookworm-slim AS build
# better-sqlite3 compiles its native module at install time.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.26.0
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @manufakture/server build
# dist/ (package.json "files") and the npm dependencies; core and sync are bundled into dist/.
RUN pnpm --filter @manufakture/server deploy --prod /out

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    MANUFAKTURE_HOST=0.0.0.0 \
    MANUFAKTURE_PORT=8787 \
    MANUFAKTURE_DB=/data/manufakture.db
WORKDIR /app
COPY --from=build /out /app
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "dist/main.js"]
