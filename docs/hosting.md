# Hosting manufakture

manufakture is a static web app: `pnpm build` writes it to `apps/web/dist`, and any static host that can set response headers per path can serve that directory. This file says how to build it, how to run it with the container image and the Kubernetes manifests in `deploy/`, what any other host must send, and what serving it obliges you to do.

**If you host an instance, you are responsible for it**: for keeping it updated, for who can reach it, for the data its users put in it, and for offering its source (below). The project ships the configuration; it does not run, monitor or support anybody's instance.

## Build

```sh
pnpm install --frozen-lockfile
pnpm --filter @manufakture/web build      # writes apps/web/dist
```

The build writes `source.html` (see [Source offer](#source-offer)), which names the commit it was built from. It reads it from git, or from the environment when there is no checkout:

| Variable                                  | Default                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| `MANUFAKTURE_SOURCE_COMMIT`               | `GITHUB_SHA`, else `git rev-parse HEAD`                                            |
| `MANUFAKTURE_SOURCE_DIRTY` (`1` or `0`)   | whether `git status --porcelain` lists anything                                    |
| `MANUFAKTURE_SOURCE_URL` (the repository) | `GITHUB_SERVER_URL/GITHUB_REPOSITORY`, else the web address of the `origin` remote |

A fork that serves its own changes must point the page at its own repository, which the `origin` default does. Build from a clean checkout of a commit you have pushed: a build from a tree with uncommitted changes says so on its source page, because then the commit is not its source.

## Container image

`deploy/Dockerfile` packs a build into a small image: [Caddy](https://caddyserver.com) 2.11 serving the files with `deploy/Caddyfile`, every compressible file precompressed with brotli (best quality; the 42.7 MB kernel `.wasm` goes to about 8.2 MB) and gzip. It does not build the app; pass the build as a named build context:

```sh
docker build -f deploy/Dockerfile --build-context site=apps/web/dist -t manufakture-web deploy
docker run --rm -p 8080:8080 --read-only --tmpfs /tmp manufakture-web
deploy/check-headers.sh http://localhost:8080 "$(git rev-parse HEAD)"
```

The image listens on plain HTTP, port 8080, as a non-root user (65532), and writes only Caddy's small state under `/tmp`; TLS ends at whatever sits in front of it. `GET /healthz` answers `ok` for probes. Caddy 2.10 answers every precompressed file with `206 Partial Content`, so keep 2.11 or later. `deploy/check-headers.sh` asserts every header in the next section against a running server; CI runs it against the image on every push (the `site` job in `.github/workflows/ci.yml`).

## Kubernetes

`deploy/k8s/` holds a Deployment, a Service and an Ingress, written for a small self-hosted cluster (k3s or k3d, whose built-in ingress controller is Traefik). Nothing about a real deployment is in the repository: `deploy/render.sh` fills in the host name, the TLS secret and the image from the environment and prints the manifests.

```sh
kubectl apply -f deploy/k8s/namespace.yaml     # once, as a cluster admin
MANUFAKTURE_HOST=manufakture.example.internal \
MANUFAKTURE_TLS_SECRET=manufakture-tls \
MANUFAKTURE_IMAGE=ghcr.io/OWNER/manufakture-web:1.2.3 \
  deploy/render.sh | kubectl apply -f -
kubectl -n manufakture rollout status deployment/manufakture-web
```

`deploy/k8s/namespace.yaml` makes a namespace of its own for the app, with Pod Security Admission enforcing the `restricted` profile (the Deployment meets it). Keep nothing else in that namespace: whoever can change the Deployment can read every Secret in it (see [Self-hosted rollout runner](#self-hosted-rollout-runner)).

Optional: `MANUFAKTURE_NAMESPACE` (default `manufakture`; edit the name in `namespace.yaml` and `rollout-rbac.example.yaml` to match) and `MANUFAKTURE_INGRESS_CLASS` (default `traefik`). The TLS secret must hold a certificate for the host: from cert-manager with your own issuer, or one you create with `kubectl -n manufakture create secret tls manufakture-tls --cert=... --key=...`. The service worker and installing the app need a secure context, so serve it over HTTPS (browsers count only `localhost` as secure without it). If the cluster is reachable only inside a private network, the certificate's issuer must be trusted by the devices that open the app.

The pod runs with a read-only root file system, no capabilities, no service account token and the `RuntimeDefault` seccomp profile. One replica is enough: the app is static, and a restart costs users nothing, since the service worker serves the app from its cache meanwhile.

### Publishing and rolling out

`.github/workflows/deploy.yml` runs on a version tag (`v*`) or by hand. Its `image` job builds the site and the image once, checks that image's headers the way CI does, and hands it on as an artifact; it runs the repository's install scripts, so it holds no write token. The `publish` job then pushes that same image, unchanged, to the GitHub Container Registry as `ghcr.io/<owner>/manufakture-web` (tagged with the version and the commit; the job summary names the digest). It checks out nothing and installs nothing, and is the only job with `packages: write`. GitHub's runners cannot reach a cluster inside a private network, so the rollout is a separate step:

- **By hand**: run the `render.sh | kubectl apply` above with `MANUFAKTURE_IMAGE` set to the published digest (`ghcr.io/<owner>/manufakture-web@sha256:...`). If the package is private, give the cluster a pull secret, or make the package public (the image holds only the public build).
- **Optional, self-hosted runner**: register a runner inside the network with the labels `self-hosted` and `manufakture-deploy` and a `kubectl` configured for the cluster, then set the repository variables `MANUFAKTURE_ROLLOUT=self-hosted`, `MANUFAKTURE_HOST` and `MANUFAKTURE_TLS_SECRET` (and optionally `MANUFAKTURE_NAMESPACE`, `MANUFAKTURE_INGRESS_CLASS`). The workflow's `rollout` job then applies the manifests and waits for the rollout, in the `production` environment, for version tags only. Do not register the runner before the safeguards below are in place.

#### Self-hosted rollout runner

A self-hosted runner executes whatever a workflow tells it to, and the deploy workflow's own triggers do not decide which workflows reach it. A pull request from a fork runs the fork's copy of the workflows, which can name `runs-on: [self-hosted, manufakture-deploy]`; anyone with write access can dispatch a modified workflow from a branch, or push a `v*` tag pointing at any commit. The `if` on the `rollout` job only prevents mistakes. All of these are required:

- **Deployment rule on `production`.** In the repository's settings, under Environments, give `production` a deployment tag rule that allows only `v*`, and required reviewers (with "Prevent self-review" where available). A job that names the environment then waits for a reviewer, whatever workflow it comes from; protect `v*` tags with a tag ruleset too, so only maintainers can create them.
- **Fork pull requests need approval.** Under Actions settings, choose "Require approval for all outside collaborators" for workflows from fork pull requests, so no fork's workflow runs before a maintainer has read it. On a public repository GitHub recommends against self-hosted runners for this reason; the approval is the minimum.
- **A runner group limited to this workflow**, where the plan offers runner groups (organizations): allow only this repository and only `.github/workflows/deploy.yml` at version tags, and leave public repositories off unless needed. A runner registered on the repository alone cannot be limited this way, which makes the two rules above the only gate.
- **An ephemeral or dedicated runner.** Register it with `--ephemeral` (one job, then it deregisters; a fresh one per rollout) or on a machine or container that does nothing else, holds no other credentials and is not reachable from the rest of the network beyond the cluster's API.
- **kubectl credentials limited to the app.** The runner's kubeconfig must not be an admin's. Use a service account bound by RBAC to the app's namespace, able only to read and patch the `manufakture-web` Deployment, Service and Ingress by name: `deploy/k8s/rollout-rbac.example.yaml` is such a Role and RoleBinding (not applied by `render.sh`; apply it once as a cluster admin and give the runner a short-lived token for `manufakture-rollout`). It has no `create`, `update` or `delete`, so do the first rollout by hand as an admin. It has no direct access to Secrets, Pods or `pods/exec`, and nothing outside the namespace. It is not harmless, though: patching the Deployment changes its pod template, so a hostile job can run any image in that namespace, and such a pod can mount any Secret there (the TLS secret included) and use any service account there. That is why the namespace must hold nothing but the app's objects and its TLS secret: then the worst a hostile job can do is replace the app and read that certificate's key, not touch the rest of the cluster. If the key matters more than that, let cert-manager or the ingress controller keep the certificate in a namespace the runner cannot patch anything in.

Rolling back is deploying the older image again (see [Updates and rollback](#updates-and-rollback)).

### Sync server behind a reverse proxy

The sync server (`apps/server/README.md`) takes its token as `Authorization: Bearer <token>` on HTTP, but a browser cannot set headers on a WebSocket, so the app sends it in the `Sec-WebSocket-Protocol` request header as the subprotocol `bearer.<token>` (next to `manufakture-sync` and the client's `client.<key>`). Access logs that record request headers, or that a debug log level makes verbose, therefore record the instance's token. Make sure the proxy in front of the server does not log that header:

- **Caddy** logs request headers in its access log when `log` is on. It redacts `Authorization` by default but not this header; drop it with `log { format filter { fields { request>headers>Sec-Websocket-Protocol delete } } }` (Go's spelling of the name), or leave the access log off for `/api/*`.
- **nginx** logs only what `log_format` names: do not add `$http_sec_websocket_protocol` or `$http_authorization` to it.
- **Traefik** and other ingress controllers: keep access-log header capture off (Traefik drops all headers unless `accessLog.fields.headers` asks for them), or name `Sec-WebSocket-Protocol` and `Authorization` as dropped headers.
- Do not turn on header logging in a load balancer or a web application firewall in front of the server either. If a token has been logged, replace it (`MANUFAKTURE_TOKEN`) and clear the logs.

The server itself never logs the token, request headers or bodies.

## Headers

What `deploy/Caddyfile` sends, and what any other host must send. `apps/web/src/hosting/headers.ts` holds the same rules, a unit test checks the Caddyfile against it, and `vite preview` sends its security headers, so the end-to-end tests run under the production policy.

| Response                                                                                   | Header                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content-hashed files under `assets/` (`name-XXXXXXXX.ext`)                                 | `Cache-Control: public, max-age=31536000, immutable`                                                                                                                                                                                                                                              |
| Everything else (`index.html`, `viewer.html`, `source.html`, `sw.js`, the manifest, icons) | `Cache-Control: no-cache`                                                                                                                                                                                                                                                                         |
| `.wasm`                                                                                    | `Content-Type: application/wasm`, brotli where the client takes it (`Content-Encoding: br`)                                                                                                                                                                                                       |
| `manifest.webmanifest`                                                                     | `Content-Type: application/manifest+json`                                                                                                                                                                                                                                                         |
| A missing file                                                                             | `404` with `Cache-Control: no-store`, never `index.html`                                                                                                                                                                                                                                          |
| Anything under `api/`                                                                      | `404`: nothing of the app lives there                                                                                                                                                                                                                                                             |
| Any other path without a file extension                                                    | `index.html` (a route of the app); `/viewer` and `/source` serve `viewer.html` and `source.html`                                                                                                                                                                                                  |
| Every response                                                                             | `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, a `Permissions-Policy` that turns off camera, microphone, location, payment and USB, and `Strict-Transport-Security: max-age=31536000` |

No `Cross-Origin-Embedder-Policy`: nothing needs cross-origin isolation, since the kernel is single-threaded ([ADR 0002](adr/0002-kernel-build-and-loading.md) decision 2). The dev server and `vite preview` still send COOP and COEP, for parity with the spikes. Without COEP the app logs `crossOriginIsolated: false` at start-up; that is expected.

### Content-Security-Policy

Pages (and every other response but worker scripts):

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:;
font-src 'self'; connect-src 'self' https: wss:; worker-src 'self'; manifest-src 'self'; object-src 'none';
base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

Worker scripts (`assets/*worker*.js`) get the same policy with `'unsafe-eval'` added to `script-src` and `connect-src` narrowed to `'self'`:

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; style-src 'self';
img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self';
object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

The workers fetch only the app's own `.wasm` and font files; sync and sharing talk to other origins from the page. User scripts run in QuickJS inside the regen worker and have no network API at all ([ADR 0010](adr/0010-scripting-sandbox.md)); `connect-src 'self'` is the layer behind that, so a script that escaped the interpreter still could not send anything to another origin (T7.2e). `deploy/check-headers.sh` asserts it on every worker script.

A dedicated worker takes its policy from its own script's response, not from the page, and the kernel's Emscripten glue (libcascade's embind) builds its function invokers with `new Function`; without `'unsafe-eval'` the regen worker never starts (checked: the demo part never appears). The pages themselves allow no `eval` and no inline script or style. zod probes `Function('')` once and falls back when the policy refuses it; the browser reports that as a violation, which is harmless. The pages' `connect-src` allows any `https:` and `wss:` origin because the sync server and share hosts live elsewhere: the sync socket is `wss://<server>/api/documents/:id/socket`, and an `https:` source does not match a `wss:` address, so both are needed. Plain `ws:` and `http:` stay out; the viewer refuses non-https bundle addresses anyway. `vite preview` adds `http:` and `ws:` for `localhost`, `127.0.0.1` and `[::1]` only, for local share hosts and a local sync server. `apps/web/e2e/csp.spec.ts` runs the app (kernel and regen), the viewer, the source page and a sync WebSocket to a real server under the policy and fails on any other violation; the rest of the end-to-end suite bypasses the policy, because some specs inject inline styles to pin their layout.

## Source offer

manufakture is GPL-3.0-or-later, and serving the app distributes it, so whoever serves a build must offer its corresponding source, including the build recipes of its `.wasm` modules ([ADR 0006](adr/0006-licensing.md)). Every build carries that offer: `source.html`, linked as **Source** from the header of the app and of the viewer. It names the commit the build was made from, links that commit in the repository, links ADR 0006 and the lockfile, and lists every `.wasm` the build ships with its package, version, license and upstream repository (where its build recipe lives). The list is made from the build's own output (`apps/web/src/source/`), and a build that emits a `.wasm` with no entry in `KNOWN_WASM` fails, so nothing ships without its recipe on the page.

The page is static HTML with no script. Its name has a file extension, and `source` is excluded from the service worker's navigation rule (`apps/web/src/pwa/policy.ts`), so the worker never answers it with the app.

A build from a checkout with uncommitted changes to tracked files says so on the page (untracked files, such as install and build leftovers, do not count), and `deploy/check-headers.sh`, given a commit, fails on that warning, so a release is always the exact commit it names. If you serve a modified build, publish your changes and build with `MANUFAKTURE_SOURCE_URL` (or the `origin` remote) pointing at the repository that holds them.

## Service worker

The build includes a service worker, `sw.js`, at the root of the app (next to `index.html`). It makes the app installable and lets it open with no network after one visit. Its source is `apps/web/src/pwa/sw/sw.ts`; it is built by vite-plugin-pwa with Workbox (both MIT, [ADR 0006](adr/0006-licensing.md)).

### What it caches

On the first visit, once the app has started, it precaches the build: `index.html`, every JavaScript and CSS chunk, the worker scripts, the kernel's `.wasm` (42.7 MB raw), planegcs and Manifold's `.wasm`, the bundled font, the icons and the manifest. The list is fixed at build time (`apps/web/src/pwa/precache.ts`): files up to 2 MiB, plus the kernel by name. IFC export's web-ifc (about 5 MB, used rarely) is left out and cached the first time it is used, as QuickJS will be. A build adds about 50 MB to the origin's Cache Storage.

Responses are stored as the host sent them, headers included:

- the `.wasm` files keep `Content-Type: application/wasm`, which `WebAssembly.compileStreaming` needs;
- `index.html` keeps `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` when the host sends them, so a page opened offline is isolated exactly when it was online;
- a body sent compressed is stored decoded (see the measurements below), so compression saves transfer, not disk.

### What it never touches

The worker answers only what it is told about: the precached files, navigations to the app (same origin, inside its scope, a path without a file extension, never under `api/`), and same-origin `GET` requests for content-hashed files under `assets/`. Everything else goes to the network as if there were no worker: other origins (the sync server and any share host among them), anything under `api/`, non-`GET` requests, range requests, URLs with a query string, and paths it does not know. The rules are in `apps/web/src/pwa/policy.ts`, with tests.

### What the host should send

- `sw.js` and `index.html`: `Cache-Control: no-cache` (or a short `max-age`). The app registers the worker with `updateViaCache: 'none'`, so browsers revalidate `sw.js` on every navigation anyway, but a CDN in between must not hold it either.
- Hashed files under `assets/`: `Cache-Control: public, max-age=31536000, immutable`. The precache runs after the kernel worker has downloaded the kernel and reads it from the HTTP cache; a host that forbids caching makes a first visit download the kernel twice.
- `.wasm` as `application/wasm`, precompressed with brotli where the host can (ADR 0002).
- The app may live under a sub-path: the worker's scope is Vite's `base`.

### Updates and rollback

A new build has a new `sw.js` (its file list changes). Browsers find it on the next navigation, or when an open tab comes back to the foreground, or hourly. The new worker installs in the background and waits; it never takes over on its own. The app first flushes autosave, and only once every change is saved shows "A new version of manufakture is ready" with **Reload** and **Later**. Reload saves once more, lets the new worker take over and reloads the page. **Later** leaves the old version running until every tab of the app is closed. The logic is `apps/web/src/pwa/updateFlow.ts`.

When one tab chooses Reload, the new worker takes control of every other open tab of the app as well, but those keep running the old build, and the old build's precache is gone. Each such tab notices the change of controller and offers Reload ("manufakture was updated in another tab"), again only once its autosave has flushed; a lazily loaded chunk that fails to load in the meantime (a dynamic import Vite reports as `vite:preloadError`, or an unhandled rejection with a browser's "dynamically imported module" message) leads to the same offer. The logic is in `apps/web/src/pwa/register.ts` and `skew.ts`.

Rolling back is deploying the older build again: its `sw.js` differs from the current one, so it arrives as an update like any other.

### Kill switch

If a worker is broken in a way an update cannot fix (it pins users to a bad build, or caches what it should not), serve the kill switch at the same URL: copy `apps/web/src/pwa/kill-switch/sw.js` over `dist/sw.js` and deploy. On each user's next navigation the browser installs it, and it:

1. deletes the caches the app's worker made (documents live in OPFS or IndexedDB and are not touched),
2. unregisters itself, so later loads go straight to the network,
3. reloads the windows the old worker controlled.

It has no fetch handler, so while it is active every request goes to the network. The app registers `sw.js` on every load, so while the kill switch is served each visit installs it and it removes itself again at once; that costs a few milliseconds and stores nothing. To bring offline support back, deploy a normal build. The end-to-end test `apps/web/e2e/offline.spec.ts` checks the kill switch: caches gone, and the app no longer opens offline.

### Development and tests

`vite dev` has no service worker: the plugin builds it only in `vite build`, and the app registers it only in production builds. To try it locally, `pnpm build` and `pnpm --filter @manufakture/web preview`. The end-to-end build (`VITE_E2E=1`) registers it only when a test opts in (`window.__manufakturePwaOptIn`): every other spec runs in a fresh browser context, where a worker would precache about 50 MB in the background of each test, racing the performance budgets, and would answer requests the specs intercept. `offline.spec.ts` opts in and serves the build from a server of its own, which can go down, compress and switch builds.

### Measurements

From the "measures" test in `apps/web/e2e/offline.spec.ts` (headless Chromium 153, the build served from localhost with brotli for `.wasm` and `immutable` assets, persistent browser profiles so the HTTP cache is on disk; 2026-10-04):

| Measure                                                             | Value                                              |
| ------------------------------------------------------------------- | -------------------------------------------------- |
| Kernel `.wasm`, raw                                                 | 42,691,285 bytes                                   |
| Kernel `.wasm`, as sent (brotli quality 5 in the test)              | 10,196,544 bytes                                   |
| Kernel body as stored in Cache Storage                              | 42,691,285 bytes (decoded)                         |
| Headers stored with it                                              | `Content-Encoding: br`, `Content-Length: 10196544` |
| Cache Storage for the whole precache (`navigator.storage.estimate`) | 49.7 MB                                            |
| Kernel downloads on a first visit (kernel worker and precache)      | 1                                                  |
| Start-up, first visit, nothing cached                               | 726 ms                                             |
| Start-up from the HTTP cache (no worker), median of 5               | 657 ms                                             |
| Start-up from Cache Storage (worker, online), median of 5           | 628 ms                                             |
| Start-up from Cache Storage, offline, median of 5                   | 644 ms                                             |

Start-up is navigation start to the kernel ready and the first model shown. Chromium stores the decoded body but keeps the original `Content-Encoding` and `Content-Length` headers, so a cached response's `Content-Length` is the compressed size; the kernel loader already ignores `Content-Length` when a `Content-Encoding` is present and shows progress against the known size. Cache Storage and the HTTP cache start the app equally fast: on localhost the download costs next to nothing and most of the time is the kernel's runtime init, which no cache saves (ADR 0002). The worker's value is that the app opens at all with no network, and that a slow network no longer delays a returning visit. Numbers on a loaded machine were about twice these, with the same ordering and gaps of tens of milliseconds.

A private (incognito) window keeps its HTTP cache in memory, too small for the 42.7 MB kernel, so there the precache downloads the kernel a second time on the first visit.
