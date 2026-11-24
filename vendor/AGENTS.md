# AGENTS.md — Vendored Packages

This directory contains source-vendored copies of the Cordis framework and its foundation libraries, and under `im/` the IM packages derived from Satori. `vendor/README.md` holds the manifest, the local-modification log and the sync procedure for the Cordis set; `vendor/im/README.md` holds the same for the IM packages.

**Do NOT edit `vendor/*/src/` or `vendor/im/*/src/` files casually.** Every local divergence from upstream must be logged exhaustively under "Local modifications" in the README that owns the package, classified as Build (B), Upstream (U) or Patch (P) in `vendor/README.md`, or as an `I` entry in `vendor/im/README.md`. The vendored `tsconfig.json` files are the exception — regenerated to fit the monorepo build, and they may be touched for type-checking policy changes (e.g., `noImplicitAny`).

When changes are unavoidable, follow the sync procedure in the owning README.
