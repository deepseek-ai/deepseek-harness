# Agent Note: README assets publish from a dedicated repository

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-17-readme-assets-on-cdn.zh.md)

## Problem

The public Chinese README embeds three community QR codes. Repository-relative images make each replacement depend on a source change and the separate public-repository publication flow, even though the image bytes do not change product code or documentation text.

The images need stable public URLs while their source bytes, publication credentials, cache behavior, and update history remain explicit and reviewable.

## Decision

The README references fixed URLs under `https://cdn.deepseek.com/harness/readme/`. The private [`deepseek-harness/readme-cdn-assets`](https://github.com/deepseek-harness/readme-cdn-assets) repository owns the three allowlisted PNG files, their tests, and their publication code. A push to its `master` branch runs `publish.yml`, which installs the pinned Huawei OBS SDK, tests `scripts/upload.mjs`, and publishes the images.

The uploader accepts only the three README filenames, verifies each source is a PNG file, and uploads it to `dp-cdn-deepseek/harness/readme/` with `Content-Type: image/png` and `Cache-Control: no-store`. It checks the OBS response status, reports the resulting public URL, and closes the client on both success and failure. Repository Actions Secrets supply `OBS_DSH_README_ACCESS_KEY_ID` and `OBS_DSH_README_SECRET_ACCESS_KEY`; the OBS identity needs write access only to that object prefix.

The assets repository provides the update history and rollback source. The public README keeps the same URLs across image replacements, so ordinary image updates do not require a product-repository change or a public-repository synchronization.

## Alternatives considered

**Keep repository-relative images on `master`.** This preserves GitHub as the only image host, but every operational QR-code replacement remains coupled to the code review and public-repository publication path.

**Keep a long-lived assets branch in the product repository.** A branch avoids product `master` changes, but it leaves image ownership, OBS credentials, and publication workflow attached to the product repository and its repository-wide automation. A dedicated repository gives that operational source one default branch and one narrow responsibility.

**Use content-addressed CDN object names.** Immutable objects avoid stale caches, but each image replacement must also change the README URL, which removes the independent update path this workflow exists to provide.

**Allow the uploader to publish arbitrary paths.** A generic uploader could serve future assets without code changes, but the same credentials could then overwrite unrelated CDN objects. The fixed allowlist keeps this publication job limited to the README images it owns.

## Consequences

Community QR codes can change through one assets-repository push while the public README remains unchanged. The product repository carries no OBS dependency or credential, uploads retain an auditable git source, and CDN responses carry `Cache-Control: no-store`.

The README depends on the public CDN and GitHub's image proxy, while publication depends on a second private repository and its two Actions Secrets. `no-store` gives up edge and browser caching for these small files.
