#!/usr/bin/env bash
# Verify every image in the rendered kustomization before kubectl apply (#156).
# Requires COSIGN_IDENTITY (the signing workflow identity) and
# COSIGN_OIDC_ISSUER (the OIDC issuer) environment variables.
set -euo pipefail

KUSTOMIZE_DIR="${1:?usage: verify-image-signatures.sh <kustomize-dir>}"

if [ -z "${COSIGN_IDENTITY:-}" ] || [ -z "${COSIGN_OIDC_ISSUER:-}" ]; then
  echo "::error::Set COSIGN_IDENTITY and COSIGN_OIDC_ISSUER on the deploy environment before deploying"
  exit 1
fi

RENDERED="$(kubectl kustomize "$KUSTOMIZE_DIR")"
IMAGES="$(printf '%s\n' "$RENDERED" | yq -N '[.. | select(has("image")) | .image] | unique | .[]')"

if [ -z "$IMAGES" ]; then
  echo "::error::No container images found in ${KUSTOMIZE_DIR}"
  exit 1
fi

while IFS= read -r image; do
  [ -n "$image" ] || continue
  if [[ "$image" != *@sha256:* ]]; then
    echo "::error::Image '${image}' is not pinned by sha256 digest; refusing to deploy unpinned images"
    exit 1
  fi
  echo "Verifying signature: ${image}"
  cosign verify \
    --certificate-identity "$COSIGN_IDENTITY" \
    --certificate-oidc-issuer "$COSIGN_OIDC_ISSUER" \
    "$image" >/dev/null
  echo "Verified: ${image}"
done <<< "$IMAGES"

echo "All images verified for identity '${COSIGN_IDENTITY}' issued by '${COSIGN_OIDC_ISSUER}'."
