# Verify container signatures before applying manifests (#156)

## Summary

The deploy workflow applied kustomize manifests without verifying that the selected images were signed by the expected
build workflow. A signature gate now runs immediately before `kubectl apply` and rejects unpinned tags, unsigned images
and signatures from unexpected identities/issuers.

## What changed

- **`.github/workflows/deploy-k8s.yml`** — installs cosign and adds "Verify image signatures before apply" between the
  cluster-target check and `kubectl apply`. Identity and issuer come from environment variables.
- **`scripts/verify-image-signatures.sh`** (new) — requires `COSIGN_IDENTITY` and `COSIGN_OIDC_ISSUER`, extracts every
  image from the rendered kustomization, requires each to be pinned by `sha256`, and runs `cosign verify` with the
  expected certificate identity and OIDC issuer.
- **`test/verify-image-signatures.test.cjs`** (new) — runs the script with fake `kubectl`/`yq`/`cosign` binaries to cover
  missing configuration, unpinned tags, successful verification and a rejected signature.
- **`docs/DEPLOY-KUBERNETES.md`** — documents the two variables and the gate's behaviour.

## Acceptance criteria addressed

- Each selected digest is verified against the expected signing identity and issuer before deployment.
- A mismatched identity/issuer or unsigned image stops deployment before `kubectl apply`.

## Validation

`node --test test/verify-image-signatures.test.cjs` → 4 passed.

closes #156
