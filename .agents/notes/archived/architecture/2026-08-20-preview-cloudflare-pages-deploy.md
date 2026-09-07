# Agent Note: per-PR preview deployments on Cloudflare Pages

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-20-preview-cloudflare-pages-deploy.zh.md)

## Problem

The browser worker preview exists to observe a pull request's frontend and host code running, so it needs a static host per pull request that outsiders cannot reach. GitHub Pages publishes privately only on GitHub Enterprise Cloud, which this organization has not settled, and one Pages site per repository cannot isolate pull requests. The first deployment run also exposed a packaging defect: on a clean checkout `pnpm install` never creates the `dsh-pack-vfs-image` bin link, so `build:preview` fails with `command not found` anywhere but a working tree whose install ran after a build.

## Decision

**Deployment.** Every push to a pull request publishes `apps/web/dist` to the Cloudflare Pages project `dsh-build-preview` under the branch alias `pr-<number>`, behind Cloudflare Access (`.github/workflows/build-preview-cloudflare.yml`). The upload carries build products only — the platform never holds repository sources, and sourcemaps are deleted before upload because they embed complete sources. `preview.html` replaces `index.html` as the deployment root: the served page cannot boot without a host injecting `window.__DSH_BOOT__`, so the root must be the page that boots. Per pull request the newest build wins; across pull requests each alias is its own URL, so nothing contends. The run passes only after a service-token request proves the protected URL serves the packed image: HTTP 200 (Access admitted the token; 302 means the Access policy lacks its Service Auth rule), no `content-encoding` (the platform must not claim transport compression over an already-compressed body, which would leave the worker's `DecompressionStream` inflating a plain tar), and the gzip magic `1f 8b`. A marker-guarded comment states the stable alias URL once per pull request.

**Bin link.** pnpm creates a workspace bin link only when the link target exists at install time. A `bin` entry naming a build product (`lib/bin.js`) therefore never gets its link on a clean checkout — building later does not revisit linking. The packer commits a root `bin.js` as the stable link target; it forwards to `lib/bin.js` and, when the build product is missing, names `pnpm run build` and exits 1. Same pattern as `dsh-subprocess-local`'s committed spawn-helper entry.

## Alternatives considered

**GitHub Pages, privately published.** Enterprise-Cloud-only, and `deploy-pages` replaces the whole site, so pull requests would overwrite each other; per-branch subdirectories require the legacy branch-deploy path and its build-rate limits.

**Actions artifact as the preview.** Download permission aligns exactly with repository read access and costs nothing, but an artifact is a zip download, not a browsable site. Kept as the fallback if the Cloudflare surface goes away.

**Documenting "install again after building" instead of committing a link target.** Leaves every clean checkout broken in an order-dependent way the error message does not explain; CI is precisely such a checkout on every run.

## Consequences

A pull request's preview lives at `https://pr-<number>.dsh-build-preview.pages.dev` and demands a Cloudflare Access sign-in; automation reaches it with a service token. The deployment platform holds no sources and no sourcemaps, which also means the preview cannot map its bundles back to source until sourcemap handling is designed deliberately. The image byte path — bytes stored compressed, served without transport re-encoding — is asserted on every deployment, so a platform behavior change fails the run instead of the worker boot. The packer bin works from any clean checkout after one full build, and the constraints table pins `bin.js` in the published file list.
