# @manufakture/server

The sync server of [ADR 0009](../../docs/adr/0009-sync-model.md): a Node program a user runs on
their own machine or a small host, for one user and their devices ([product decision
0001](../../docs/decisions/0001-m7-hosting-accounts-and-sharing.md): self-hosted, one bearer token
per instance, no accounts, SQLite). It orders each document's command log, validates every entry
with core through `judgeEntry` from [`@manufakture/sync`](../../packages/sync/README.md), keeps the
de-duplication table with its retention floor, pushes accepted entries over WebSockets and stores
blobs by SHA-256. Fastify 5, `@fastify/websocket`, `@fastify/cors` and better-sqlite3 13; GPL-3.0-or-later.

Whoever runs an instance is responsible for what it stores and serves. The project operates no
sync service, and nothing is sent anywhere but to the server you run.

## Running

```bash
pnpm install
pnpm --filter @manufakture/server build            # dist/main.js
MANUFAKTURE_TOKEN="$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=')" \
MANUFAKTURE_ORIGINS=https://cad.example.internal \
MANUFAKTURE_DB=/var/lib/manufakture/sync.db \
  pnpm --filter @manufakture/server start
```

It listens on `127.0.0.1:8787` by default: on localhost or a private network, behind a reverse
proxy that ends TLS. Do not expose it to the internet: the token is the only protection.

The container recipe is [`Dockerfile`](Dockerfile) (build from the repository root:
`docker build -f apps/server/Dockerfile -t manufakture-server .`); it keeps the database in the
`/data` volume and runs as a non-root user.

## Configuration

Everything comes from environment variables.

| Variable                  | Default          | Meaning                                                                                                                |
| ------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `MANUFAKTURE_TOKEN`       | (required)       | The instance's bearer token: 32 to 512 characters of `A-Z a-z 0-9 . _ ~ -` (it must fit a WebSocket subprotocol)       |
| `MANUFAKTURE_TOKEN_FILE`  |                  | Read the token from this file instead (a container secret)                                                             |
| `MANUFAKTURE_DB`          | `manufakture.db` | The SQLite database file; created on first start                                                                       |
| `MANUFAKTURE_HOST`        | `127.0.0.1`      | The address to listen on (`0.0.0.0` in the container)                                                                  |
| `MANUFAKTURE_PORT`        | `8787`           | The port                                                                                                               |
| `MANUFAKTURE_ORIGINS`     | (none)           | Comma-separated origins of the app (`https://host[:port]`), allowed by CORS and on WebSocket upgrades. Empty: none     |
| `MANUFAKTURE_TRUST_PROXY` | off              | `1` to trust `X-Forwarded-*` from the reverse proxy (only affects logged addresses)                                    |
| `MANUFAKTURE_LOG_LEVEL`   | `info`           | `fatal`, `error`, `warn`, `info`, `debug`; logs are JSON lines on stdout and never include the token or request bodies |

Limits (all positive integers; `src/limits.ts` documents each):

| Variable                                 | Default                            |
| ---------------------------------------- | ---------------------------------- |
| `MANUFAKTURE_MAX_BODY_BYTES`             | 40 MiB                             |
| `MANUFAKTURE_MAX_MESSAGE_BYTES`          | 40 MiB                             |
| `MANUFAKTURE_MAX_ENTRY_BYTES`            | 12 MiB (under the app's 16 MiB)    |
| `MANUFAKTURE_MAX_JSON_DEPTH`             | 64                                 |
| `MANUFAKTURE_MAX_JSON_NODES`             | 1,000,000                          |
| `MANUFAKTURE_MAX_CREATED_IDS_PER_SUBMIT` | 100,000                            |
| `MANUFAKTURE_MAX_BLOB_BYTES`             | 20 MiB (core's `MAX_IMPORT_BYTES`) |
| `MANUFAKTURE_MAX_BLOB_TOTAL_BYTES`       | 10 GiB                             |
| `MANUFAKTURE_MAX_DOCUMENTS`              | 10,000                             |
| `MANUFAKTURE_MAX_CLIENTS_PER_DOCUMENT`   | 256                                |
| `MANUFAKTURE_MAX_ROWS_PER_CLIENT`        | 20,000                             |
| `MANUFAKTURE_ENTRIES_PER_MINUTE`         | 20,000 (at least 1,000)            |
| `MANUFAKTURE_MESSAGES_PER_MINUTE`        | 1,200                              |
| `MANUFAKTURE_VALIDATION_BUDGET_MS`       | 2,000                              |
| `MANUFAKTURE_MAX_CONNECTIONS`            | 256                                |
| `MANUFAKTURE_MAX_SOCKET_BUFFER_BYTES`    | 64 MiB                             |
| `MANUFAKTURE_HELLO_TIMEOUT_MS`           | 10,000                             |
| `MANUFAKTURE_MAX_VERSIONS_PER_DOCUMENT`  | 2,000                              |
| `MANUFAKTURE_MAX_BRANCHES_PER_DOCUMENT`  | 100                                |
| `MANUFAKTURE_MAX_PULL_BYTES`             | 8 MiB (at least one entry a pull)  |
| `MANUFAKTURE_REQUEST_TIMEOUT_MS`         | 120,000 (a whole HTTP request)     |
| `MANUFAKTURE_CONNECTION_TIMEOUT_MS`      | 300,000 (an idle connection)       |
| `MANUFAKTURE_KEEP_ALIVE_TIMEOUT_MS`      | 72,000 (above the proxy's own)     |

The app refuses any message from the server over 16 MiB (`MAX_INBOUND_BYTES` in
`apps/web/src/sync/transport.ts`). Every accepted entry is pushed to every client and may come
back alone in a pull, so keep `MANUFAKTURE_MAX_ENTRY_BYTES` and `MANUFAKTURE_MAX_PULL_BYTES` well
under that: an entry the app cannot receive closes its socket again on every reconnect. Raising
them needs the app's limit raised too.

A document's head is cached in memory while it is in use and dropped after ten minutes unused; the
next request loads it again from the database.

Share links (`src/shares.ts`; the user guide is `docs/user/sharing.md`):

| Variable                                 | Default               | Meaning                                                    |
| ---------------------------------------- | --------------------- | ---------------------------------------------------------- |
| `MANUFAKTURE_SHARES`                     | on                    | `off` removes the share routes, the only public ones       |
| `MANUFAKTURE_SHARE_MAX_BYTES`            | 50 MiB                | The largest bundle, counted while the upload streams in    |
| `MANUFAKTURE_SHARE_MAX_COUNT`            | 100                   | Active shares per token                                    |
| `MANUFAKTURE_SHARE_EXPIRY_DAYS`          | 30                    | Expiry of a share that asks for none (at most 3650)        |
| `MANUFAKTURE_SHARE_ALLOW_NEVER`          | on                    | `off` refuses shares that never expire                     |
| `MANUFAKTURE_SHARE_MAX_CONCURRENT_READS` | 8                     | Public downloads at once; more get 503 with `Retry-After`  |
| `MANUFAKTURE_SHARE_READ_TIMEOUT_MS`      | 120,000               | One download's deadline; a slower reader is cut off        |
| `MANUFAKTURE_VIEWER_ORIGINS`             | `MANUFAKTURE_ORIGINS` | Origins allowed by CORS on the public download (no others) |

Whoever runs a server is responsible for what it hosts; there is no hosted service and no takedown
contact (`docs/user/sharing.md`, "If you run the server").

## Routing `/api` to the server

Everything the server answers is under `/api`, which the app never uses for itself: the service
worker sends `/api` to the network (`apps/web/src/pwa/policy.ts`), and the static image's
`deploy/Caddyfile` answers `/api` with 404 when there is no server. To serve the app and the
server on one origin, route `/api` to the server in front of the static site. With Caddy:

```caddyfile
cad.example.internal {
	handle /api/* {
		reverse_proxy 127.0.0.1:8787
	}
	handle {
		reverse_proxy 127.0.0.1:8080 # the static image (deploy/)
	}
}
```

Caddy passes WebSocket upgrades through `reverse_proxy` as they are. With nginx, a `location
/api/` with `proxy_pass`, `proxy_http_version 1.1` and the `Upgrade`/`Connection` headers does the
same; raise `client_max_body_size` to the body limit. On one origin, `MANUFAKTURE_ORIGINS` can stay
empty (no CORS needed, and a same-origin WebSocket is allowed by the app's `connect-src 'self'`). A
server on another origin needs that origin's scheme to be allowed by the app's
Content-Security-Policy (`connect-src 'self' https:` covers `https:` and `wss:`) and the app's
origin in `MANUFAKTURE_ORIGINS`.

## The API

Every route but `GET /api/health` and `GET /api/shares/:id` needs `Authorization: Bearer <token>`. No cookies are read or
set. JSON responses carry `Cache-Control: no-store`; an error is `{ code, message }` with a 4xx
status, plus `messages` when protocol messages explain it.

| Route                                  | What it does                                                                                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                      | `{ ok: true }`, no token                                                                                                                                         |
| `POST /api/documents`                  | `{ document }`: a new document at revision 0, under the document's own `id` (URL-safe, at most 128 characters). Migrated and checked by core. `201 { id, head }` |
| `GET /api/documents`                   | `{ documents: [{ id, name, createdAt, head }] }`                                                                                                                 |
| `GET /api/documents/:id/snapshot`      | `{ rev, document, highWater }`: the head, for a new device: `new SyncClient(document, rev, { clientId, highWater })`                                             |
| `POST /api/documents/:id/hello`        | A `hello` message, with the client key header: `{ messages: [welcome] }`                                                                                         |
| `POST /api/documents/:id/entries`      | A `submit` message, with the client key header: `{ messages }`, the acks, refusals and retryable answers in entry order                                          |
| `GET /api/documents/:id/entries?since` | A pull: `{ messages: [push] }` with up to 1,000 entries after `since`                                                                                            |
| `PUT /api/blobs/:sha256`               | `application/octet-stream`, at most `MAX_IMPORT_BYTES`; refused unless the bytes hash to the name. `201` stored, `200` already there                             |
| `GET /api/blobs/:sha256`               | The bytes, or 404                                                                                                                                                |
| `GET /api/documents/:id/socket`        | The WebSocket (below)                                                                                                                                            |
| `GET /api/documents/:id/versions`      | `{ versions }`: every branch's named versions, in the order they were stored                                                                                     |
| `POST /api/documents/:id/versions`     | `{ version }` (`ServerVersionSchema`): `201`, or `200` when that record is stored already; `409 version-exists` for another record under its id                  |
| `GET /api/documents/:id/versions/:vid` | `{ version, document }`: the version and its branch's document at its revision                                                                                   |
| `GET /api/documents/:id/branches`      | `{ branches }`: the branch records (main has none)                                                                                                               |
| `POST /api/documents/:id/branches`     | `{ branch }` (`ServerBranchSchema`): a new branch log from a stored version; `201`, `200` for a resend, `409 branch-exists`                                      |
| `POST /api/shares?name=&expires=`      | A `.mfkview` as `application/vnd.manufakture.view+zip`; `expires` is days or `never`. `201 { id, name, size, createdAt, expiresAt }`; 409 at the count limit     |
| `GET /api/shares`                      | `{ shares, limits }`: the active shares, newest first                                                                                                            |
| `GET /api/shares/:id`                  | The bundle, **no token**, CORS for `MANUFAKTURE_VIEWER_ORIGINS` only; 404 for unknown, revoked and expired ids alike                                             |
| `DELETE /api/shares/:id`               | Revokes: `204`, or 404                                                                                                                                           |

The snapshot, hello, entries (both) and socket routes take `?branch=<id>` for a branch's own log;
without it they mean `main`. Anything but a branch id is `400`, an unknown branch `404` (a
WebSocket closes with 4404). A client's claim, rows and floor are per branch, and a push goes to the
connections of its branch only.

The messages are `@manufakture/sync`'s protocol (`ClientMessageSchema`, `ServerMessageSchema`), so
a client feeds every message of `messages` to `SyncClient.handle` whatever the status was.

### Client ids and keys

A submit speaks for one `clientId`, and only the client that claimed that id may use it: the first
`hello` for an id records the SHA-256 of the client key it came with, and every later hello and
HTTP submit for that id must present the same key (compared in constant time). So no client can
submit as another, raise another's retention floor or prune its rows. The client makes the key
itself (32 to 128 base64url characters, at least 192 random bits) and keeps it with its queue state,
beside `clientId`. Over HTTP it goes in the `Manufakture-Client-Key` header; on a WebSocket in the
`client.<key>` subprotocol. A WebSocket is bound to the client of its hello: a submit for any other
`clientId` on it is refused.

### Submits

A submit is checked whole before anything is judged, and refused with no change when any check
fails: the schema, the client key, an entry with a newer `format` than the server's (`400
format-version`), an entry over `MANUFAKTURE_MAX_ENTRY_BYTES`, more created ids than the per-submit limit, a
floor above the submit's own lowest `clientSeq`, a `clientSeq` or `prevSeq` below the client's
stored floor that the table no longer keeps (`400 below-floor`, one `error` message per entry; a
correct client only ever sends one in a late copy of an entry it has already resolved), more rows
than `MANUFAKTURE_MAX_ROWS_PER_CLIENT` (`429 too-many-rows`) or more entries than the client's per-minute
budget (`429 rate-limited` with `Retry-After`).

Then the entries are judged in order, as ADR 0009 decision 2 and its amendment say: a recorded
`(clientId, clientSeq)` gets its recorded outcome, refusals included; an unknown `prevSeq` gets
`predecessor-unknown`, which is not recorded; a refused `prevSeq` gives `predecessor-refused`; a
created id below the head's counter is `id-reused`; then core; then the counter guard. Everything
the submit changes (entries, outcomes, the head and its high-water mark, a snapshot every
`CHECKPOINT_EVERY` = 100 revisions, the client's floor, latest accepted entry and pruned rows) is
written in one SQLite transaction, and the answers and pushes go out only after it commits. The
status is `200`, or `409` with `code: "predecessor-unknown"` when any entry got the retryable
answer (resend it after its predecessor). Once a submit has used `MANUFAKTURE_VALIDATION_BUDGET_MS`, its
remaining entries are left unjudged and unanswered; the client resends entries without an answer.

The store keeps, per client, every outcome from the highest floor the client has sent, plus its
latest accepted entry, and never lowers a floor.

**The server trusts each entry's `created` list.** The client computes the ids its command creates
(`createdIds`), and the server cannot (ADR 0009 amendment, item 1: core takes an id an `editFeature`
adds as an edit of whatever has that id). A client that lies about `created` can only make its own
entry slip past the takeover guard; core and the counter guard still check the result, so the
document stays valid. With one user per instance that client is the user's own.

### The WebSocket

`new WebSocket(url, ['manufakture-sync', 'bearer.' + token, 'client.' + key])`; the server answers
with the `manufakture-sync` subprotocol only. An upgrade from an `Origin` not in
`MANUFAKTURE_ORIGINS` is refused (non-browser clients send none). The first message must be the
client's `hello` (within `MANUFAKTURE_HELLO_TIMEOUT_MS`); after the `welcome`, `submit` and `pull`
messages are answered as over HTTP, and every entry the server accepts, from any connection or
HTTP request, is pushed to every connection of the document that has said hello. A transport-level
refusal arrives as an `error` message with code `invalid-message` naming the reason. A reader that
falls more than `MANUFAKTURE_MAX_SOCKET_BUFFER_BYTES` behind is disconnected and pulls on reconnect. Submits
over one connection arrive in order, which keeps `predecessor-unknown` rare (ADR 0009 amendment,
item 12).

### Versions and branches

T7.1e (ADR 0009 decision 9). A **version** names revision `rev` of one branch's log, for good:
records are append-only and keyed by the app's version id, so a pin by document and version id
means the same in every browser. Storing one also stores its branch's document at that revision as
a snapshot, so reading it back replays nothing. A **branch** is a log of its own whose revision 0
is the document of the version it names (`fromVersion`), with the high-water mark of that
version's branch as of its revision; it is synced through the routes above with `?branch=`.

Both routes are behind the token like the others, take bodies of at most 16 KiB
(`RECORD_BODY_BYTES`), check them with the shared schemas, and answer every refusal with a fixed
message: `invalid-version`/`invalid-branch` (schema), `no-branch` and `no-revision` (a version for
a branch or revision the server does not have), `no-version` (a branch from a version it does not
have), `version-exists`/`branch-exists` (409), and `too-many-versions`/`too-many-branches` (403) at
the limits above. A resend of a stored record is answered `200` with it, so a client that lost
the answer can send it again.

## Storage and backup

One SQLite file (`MANUFAKTURE_DB`) with write-ahead logging and `synchronous = FULL`, so an
answered submit survives a crash or a power cut, and a process killed mid-submit leaves the
database as it was before the submit (the torn-write test kills one). Tables: `documents`,
`branches` (head and high-water mark of `main` and every other branch), `entries`, `snapshots`,
`clients` (key hash, floor, latest accepted), `outcomes` (the de-duplication table), `versions`,
`branch_records` and `blobs`. `meta.schema` versions the layout (2 since T7.1e; a version 1 database
gets the two new tables when it is opened); a newer database is refused.

Back up with SQLite's online backup, which is safe while the server runs:

```bash
sqlite3 /var/lib/manufakture/sync.db ".backup '/backups/sync-$(date +%F).db'"
```

(or `VACUUM INTO '/backups/sync.db'`). Do not copy the file alone while the server runs: the
`-wal` file beside it holds recent commits. To restore, stop the server, put the backup in place
of the database (removing any `-wal` and `-shm` files) and start it. Clients whose entries were
accepted after the backup was taken will find the server behind them; the app's sync handles that
as a server fault (T7.1d), so restore the newest backup there is.

## Known limitations

- Validation runs core on the event loop. The size, depth, node and per-submit time limits bound
  one request, but a single entry near the limits (a large `replaceDocument`) still holds other
  requests while it is judged. Moving judging to a worker thread is the next step if that shows up.
- A document's head (its current document, replayed from the newest snapshot) is cached in
  memory while the document is in use, and dropped after ten minutes without a request, as are the
  per-client rate buckets; the next request loads it again from the database. What stays in memory
  is therefore bounded by the documents in use at once, each up to a full document.
- Entries are capped at 12 MiB so that the app can always receive them, which refuses an import
  over about 9 MiB (its bytes travel base64 inside the entry) until imports move out to blobs.
  A server that stored larger entries under an older default (32 MiB) serves them to no app client:
  their sockets close on that message and reconnect to it again.
- Imports still carry their bytes inline in the document and its commands (core's schema), so
  entries do not name blobs yet and the server has no check that a named blob exists; the blob
  routes are ready for the format change that moves `data` out by hash.
- Every version stores a full snapshot of its document (and every branch one more, its revision
  0), unless a snapshot of that revision is there already, so storage grows by one document per
  version beside the log and the checkpoints. Versions are never deleted; the per-document limits
  (`MANUFAKTURE_MAX_VERSIONS_PER_DOCUMENT`, `MANUFAKTURE_MAX_BRANCHES_PER_DOCUMENT`) bound it.
- Versions and branches are authorised by the token alone, like everything else: whoever holds it
  can read every document's versions, which is what pin resolution across documents needs.
  Per-document authorisation belongs with accounts (T7.1h, skipped in M7).
- One token for everything. Accounts, per-document roles and a hosted service are deferred
  (product decision 0001); the store's tables are keyed by document and branch, and the client
  claim does not depend on the token, so accounts can be added in front of them.

## Tests

`test/server.test.ts` runs a real server on an ephemeral port over a temp SQLite file: auth and
CORS, documents, client claims, two `SyncClient`s converging over WebSockets, pushes, the
retryable answer, a restart with resubmissions, snapshots, the retention floor cases of the M7
plan, hostile inputs and every limit. `test/records.test.ts` covers versions and branches: the
token, storing, listing and reading back, resends and conflicts, the schemas' refusals with fixed
messages, the body and count caps, a branch's own log and pushes, and the schema upgrade. `test/torn-write.test.ts` bundles `test/crash-child.ts`,
kills it with SIGKILL inside the commit transaction, and checks the store is unchanged and the
submit then lands.

```bash
pnpm --filter @manufakture/server test
pnpm --filter @manufakture/server typecheck
```
