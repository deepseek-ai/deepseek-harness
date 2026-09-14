# Agent Note: Publish every current experimental package

Status: implemented

English | [中文](2026-09-12-publish-all-experimental-packages.zh.md)

## Problem

Users need npm access to Auto review, the Inspector, the CPython PTC backend, and browser-worker libraries without promoting their experimental APIs. Source-checkout tests alone do not establish that their tarballs contain the runtime files and imports needed by installed consumers.

## Decision

Every current package under `packages/experimental/` publishes in the dsh release family and the local npm baseline. Each manifest omits `private` and sets `publishConfig.access: public`. The [publication denylist](2026-09-12-experimental-publication-denylist.md) remains available for future private exceptions but contains no directories. Experimental npm names, opt-in composition, dependency isolation, compatibility expectations, and support limits remain unchanged.

The Inspector tarball includes `lib/worker.js`, which its Host entry starts by a sibling URL. Its built-artifact test packs and extracts the package before starting that Worker. The WebWorker packer imports module-proxy and replacement-package tables through the runtime's public library entry; its compiled repository chunk requires no runtime TypeScript source. Its packed-consumer test imports both extracted tarballs under plain Node and mounts the resulting base image and data overlay without either package's source tree.

The CPython PTC backend ships its Python scripts and still requires a supported external interpreter on Unix. The browser-worker packages expose installed library APIs; the packer's repository CLI still requires its documented built checkout. Publication does not add these packages to any shipped profile or make the browser preview a product launcher.

## Alternatives considered

**Keep the excluded packages private.** This prevents installed use even when the selected composition explicitly accepts experimental behavior.

**Change only the manifest access fields.** The Inspector would omit its Worker, and the compiled WebWorker packer would import source files absent from the runtime tarball. Packed-consumer checks must cover the runtime files that source tests can mask.

**Promote the packages into product groups.** Installation does not require removing the experimental npm names or accepting stable ownership and support obligations.

## Consequences

All current experimental packages are available to explicit consumers. The release set and package authors take on complete public payloads while keeping default product compositions isolated. The empty denylist retains fixture-backed validation for future private exclusions.
