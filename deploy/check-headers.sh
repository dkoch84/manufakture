#!/usr/bin/env bash
# Asserts what a running manufakture server sends (the image from deploy/Dockerfile, or any host
# configured from docs/hosting.md): status codes, Content-Type, Cache-Control, compression, the
# Content-Security-Policy and the source page. Used by the `site` job in CI; also handy against a
# live instance.
#
#   deploy/check-headers.sh http://localhost:8080 [expected-commit]
#
# With a commit, the source page must name it and must not say the build had local changes.
#
# Exits non-zero after listing every failed check.
set -euo pipefail

base="${1:?usage: check-headers.sh BASE_URL [EXPECTED_COMMIT]}"
base="${base%/}"
commit="${2:-}"
failures=0
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "FAIL: $*"
  failures=$((failures + 1))
}

# fetch PATH [curl args...]: headers to $tmp/h (lower-case names), body to $tmp/b.
fetch() {
  local path="$1"
  shift
  curl -sS -o "$tmp/b" -D "$tmp/h.raw" "$@" "$base$path"
  tr -d '\r' < "$tmp/h.raw" | sed -E 's/^([^:]+):/\L\1:/' > "$tmp/h"
}

status() { head -n 1 "$tmp/h" | awk '{print $2}'; }
header() { grep -i "^$1:" "$tmp/h" | head -n 1 | cut -d: -f2- | sed -E 's/^ +//'; }

expect_status() {
  local want="$1" path="$2" got
  got="$(status)"
  [ "$got" = "$want" ] || fail "$path: status $got, want $want"
}

expect_header() {
  local name="$1" want="$2" path="$3" got
  got="$(header "$name")"
  [ "$got" = "$want" ] || fail "$path: $name is '$got', want '$want'"
}

expect_header_contains() {
  local name="$1" want="$2" path="$3" got
  got="$(header "$name")"
  [[ "$got" == *"$want"* ]] || fail "$path: $name '$got' lacks '$want'"
}

expect_no_header() {
  local name="$1" path="$2"
  [ -z "$(header "$name")" ] || fail "$path: sends $name, it must not"
}

page_csp="script-src 'self' 'wasm-unsafe-eval';"
# Pages reach the sync server and share hosts on other origins: https, and wss for the sync socket.
page_connect="connect-src 'self' https: wss:;"

# The pages: no long cache, the strict policy, the security headers, no cross-origin isolation.
for path in / /index.html /viewer.html /viewer /source.html /some/app/route; do
  fetch "$path"
  expect_status 200 "$path"
  expect_header_contains content-type text/html "$path"
  expect_header cache-control no-cache "$path"
  expect_header_contains content-security-policy "$page_csp" "$path"
  expect_header_contains content-security-policy "frame-ancestors 'none'" "$path"
  expect_header_contains content-security-policy "$page_connect" "$path"
  expect_header x-content-type-options nosniff "$path"
  expect_header referrer-policy no-referrer "$path"
  expect_header cross-origin-opener-policy same-origin "$path"
  expect_no_header cross-origin-embedder-policy "$path"
  expect_no_header server "$path"
done
fetch /some/app/route
grep -q '<div id="root">' "$tmp/b" || fail "/some/app/route: not the app's index.html"

# The service worker and the manifest: revalidated, right types.
fetch /sw.js
expect_status 200 /sw.js
expect_header_contains content-type javascript /sw.js
expect_header cache-control no-cache /sw.js
fetch /manifest.webmanifest
expect_status 200 /manifest.webmanifest
expect_header content-type application/manifest+json /manifest.webmanifest
expect_header cache-control no-cache /manifest.webmanifest

# Never the app: anything under api/, and a missing file (not cached either).
for path in /api /api/shares/x /assets/missing-AbCd1234.js /assets/missing-AbCd1234.wasm /missing.png; do
  fetch "$path"
  expect_status 404 "$path"
  [[ "$(header cache-control)" != *immutable* ]] || fail "$path: a 404 is cached as immutable"
  [[ "$(header content-type)" != *wasm* ]] || fail "$path: a 404 is labelled WebAssembly"
done

# Hashed assets, found through the built pages.
fetch /index.html
script="$(grep -oE '/assets/[^"]+\.js' "$tmp/b" | head -n 1)"
[ -n "$script" ] || fail "index.html names no script under /assets/"
if [ -n "$script" ]; then
  fetch "$script" -H 'Accept-Encoding: br'
  expect_status 200 "$script"
  expect_header cache-control 'public, max-age=31536000, immutable' "$script"
  expect_header content-encoding br "$script"
  expect_header_contains content-security-policy "$page_csp" "$script"
fi

# The source page names the commit and every .wasm; every .wasm it names is served right.
fetch /source.html
expect_status 200 /source.html
grep -q 'Source code of this build' "$tmp/b" || fail "/source.html: not the source page"
if [ -n "$commit" ]; then
  grep -q "data-commit=\"$commit\"" "$tmp/b" || fail "/source.html: does not name commit $commit"
  # A release is built from a clean checkout of that commit; a dirty one means the commit alone is
  # not its source (or the build changed a tracked file).
  grep -q 'data-testid="source-dirty"' "$tmp/b" && fail "/source.html: says the build is dirty"
fi
cp "$tmp/b" "$tmp/source.html"
wasm_files="$(grep -oE 'assets/[^<]+\.wasm' "$tmp/source.html" | sort -u)"
[ -n "$wasm_files" ] || fail "/source.html lists no .wasm"
grep -q 'opencascade_single' <<< "$wasm_files" || fail "/source.html does not list the kernel"
fetch /source.css
expect_status 200 /source.css
expect_header_contains content-type text/css /source.css

for file in $wasm_files; do
  path="/$file"
  fetch "$path" -H 'Accept-Encoding: br, gzip'
  expect_status 200 "$path"
  expect_header content-type application/wasm "$path"
  expect_header content-encoding br "$path"
  expect_header cache-control 'public, max-age=31536000, immutable' "$path"
  head -c 4 "$tmp/b" | od -An -tx1 | grep -q '00 61 73 6d' && fail "$path: br body is not compressed"
  fetch "$path" -H 'Accept-Encoding: gzip'
  expect_header content-encoding gzip "$path"
  fetch "$path"
  expect_status 200 "$path"
  expect_no_header content-encoding "$path"
  head -c 4 "$tmp/b" | od -An -tx1 | grep -q '00 61 73 6d' || fail "$path: not a WebAssembly file"
done

# Worker scripts get the worker policy, which allows eval for the kernel's Emscripten glue and
# connects to the app's own origin only. The
# service worker's precache list names every one of them.
fetch /sw.js
workers="$(grep -oE 'assets/[A-Za-z0-9_.-]*worker[A-Za-z0-9_.-]*\.js' "$tmp/b" | sort -u || true)"
[ -n "$workers" ] || fail "sw.js names no worker script"
for file in $workers; do
  fetch "/$file"
  expect_status 200 "/$file"
  expect_header_contains content-security-policy "'wasm-unsafe-eval' 'unsafe-eval'" "/$file"
  # Workers reach their own origin only (user scripts run in the regen worker).
  expect_header_contains content-security-policy "connect-src 'self';" "/$file"
done

fetch /healthz
expect_status 200 /healthz

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed against $base"
  exit 1
fi
echo "all header checks passed against $base"
