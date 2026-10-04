#!/usr/bin/env bash
# Prints the Kubernetes manifests in deploy/k8s/ with the deploy-time settings filled in, for
# `kubectl apply -f -` (docs/hosting.md). Nothing about a real deployment lives in the repository:
# the host name, the TLS secret and the image come from the environment.
#
#   MANUFAKTURE_HOST=manufakture.example.internal \
#   MANUFAKTURE_TLS_SECRET=manufakture-tls \
#   MANUFAKTURE_IMAGE=ghcr.io/OWNER/manufakture-web:v1.2.3 \
#     deploy/render.sh | kubectl apply -f -
#
# Optional: MANUFAKTURE_NAMESPACE (default manufakture; the namespace must exist) and
# MANUFAKTURE_INGRESS_CLASS (default traefik, k3s's and k3d's built-in controller).
set -euo pipefail

: "${MANUFAKTURE_HOST:?set MANUFAKTURE_HOST to the host name the app is served at}"
: "${MANUFAKTURE_TLS_SECRET:?set MANUFAKTURE_TLS_SECRET to the TLS secret for that host}"
: "${MANUFAKTURE_IMAGE:?set MANUFAKTURE_IMAGE to the image to run (registry/name:tag or @digest)}"
export MANUFAKTURE_NAMESPACE="${MANUFAKTURE_NAMESPACE:-manufakture}"
export MANUFAKTURE_INGRESS_CLASS="${MANUFAKTURE_INGRESS_CLASS:-traefik}"
export MANUFAKTURE_HOST MANUFAKTURE_TLS_SECRET MANUFAKTURE_IMAGE

# Names that are not a DNS label sequence would only fail later, inside the cluster.
if ! [[ "$MANUFAKTURE_HOST" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$ ]]; then
  echo "render.sh: MANUFAKTURE_HOST is not a host name: $MANUFAKTURE_HOST" >&2
  exit 1
fi

# The other values go into the YAML unquoted: whitespace or a newline would change the manifests'
# structure rather than fail, so refuse it.
for name in MANUFAKTURE_TLS_SECRET MANUFAKTURE_IMAGE MANUFAKTURE_NAMESPACE MANUFAKTURE_INGRESS_CLASS; do
  value="${!name}"
  if [ -z "$value" ] || [[ "$value" =~ [[:space:]] ]]; then
    echo "render.sh: $name must be one word with no whitespace" >&2
    exit 1
  fi
done

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/k8s"
vars='${MANUFAKTURE_HOST} ${MANUFAKTURE_TLS_SECRET} ${MANUFAKTURE_IMAGE} ${MANUFAKTURE_NAMESPACE} ${MANUFAKTURE_INGRESS_CLASS}'
first=1
for f in deployment.yaml service.yaml ingress.yaml; do
  [ "$first" = 1 ] || echo '---'
  first=0
  envsubst "$vars" < "$dir/$f"
done
