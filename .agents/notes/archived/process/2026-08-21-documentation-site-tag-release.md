# Agent Note: Publish the documentation site from a release tag

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-21-documentation-site-tag-release.zh.md)

## Problem

Every other public surface of this project advances only at a release tag. The npm sequence publishes from a `dsh-v*` tag through a reviewed manual dispatch, the Python wheels from a `python-v*` tag behind a publisher-repository check and two protected environments, and the public source repository advances only to each release commit. The documentation website deployed on every master push touching `docs/`, `website/`, the projector, or the lockfile, with no reviewer and no version check. That site is reachable without authentication even though the repository is private, so a merge published documentation to the internet within minutes — including pages describing work that no released artifact contained, and reference material generated from a source tree ahead of everything readers could obtain.

## Decision

`docs-pages.yml` declares `workflow_dispatch` alone and publishes from a `dsh-v*` tag, which is the structure `release-publish.yml` already uses for npm: publication is an explicit act from a release tag and never appears as a pull-request check.

The build job runs `release:verify --family dsh` with `RELEASE_PUBLISH=true` before it builds anything. That is the gate npm publication runs, so the site and the npm sequence share one definition of a released version rather than each carrying its own: the run must come from a `refs/tags/` ref, the tag must carry the family prefix, and the tag must name a version the working tree actually carries. Checkout takes complete history because the release scripts read tags.

The `github-pages` environment carries a `dsh-v*` deployment tag policy and required reviewers, matching `npm-publish`. The two layers answer different failures: the script gate rejects a dispatch from the wrong ref, and the environment policy still rejects the deployment if a later workflow edit stops asking.

`DOCS_REPOSITORY_REF` stays `master`, so projected source links continue to target the public repository's default branch rather than the dispatched tag. That repository advances only to each release commit, so its master never carries unreleased work and the published tag adds no exposure control. It also retains only its most recent tags, so following the dispatched tag would leave every projected source link on a deploy from an older tag unresolvable.

Build coverage does not depend on this workflow. `check:ci:static` builds the production site on every pull request through `docs:build:mpa`, and `ci-master.yml` builds it again on master; [the projection Agent Note](2026-07-13-documentation-site-projection.md) rejected moving that build into a deployment workflow for exactly this reason, and tag-gated publication is what makes that separation load-bearing.

`ci-workflow.spec.ts` pins the shape beside the npm and Python release assertions: `on` carries `workflow_dispatch` alone, the build job runs the tag verification with `RELEASE_PUBLISH`, checkout takes complete history, `DOCS_REPOSITORY_REF` reads `master`, and the deploy job keeps the `github-pages` environment.

## Alternatives considered

**Keep the master push and add required reviewers to the environment.** This puts a human in the loop for one workflow change and no repository-settings coordination. It fails on what the reviewer is asked: an approval prompt on every documentation merge is a prompt reviewers learn to clear without reading, and nothing connects the approved content to a version anyone can install. The reviewer would be answering "does this page look publishable" when the question is "is this released".

**Follow the dispatched tag in `DOCS_REPOSITORY_REF`.** A page from a tagged snapshot linking to that snapshot's source is more precise than linking to a branch. It costs more than it buys here: the public repository keeps only its most recent tags, so a deploy from an older tag — the natural response to a bad release — breaks every projected source link at once, while its master cannot expose unreleased work in the first place.

**Publish a separate public site and keep an internal site on master.** An internal site following master preserves same-day preview for contributors while the public site tracks releases. GitHub serves one Pages site per repository, so this needs a second repository, and the public organization does not currently run checked-in CI workflows. Deferred rather than rejected: this decision does not foreclose it, since a second destination consumes the same `website/.dist` this workflow already builds.

**Make the Pages site private.** Switching Pages visibility to organization members is one repository setting and instant, and this organization's plan supports it. It answers a different question — it hides the site from readers who are meant to have it — while leaving documentation publication unlinked from release state. Tag-gated publication makes the site's content equal to what the public repository already carries, so restricting visibility buys nothing.

## Consequences

Documentation, npm packages, Python wheels, and the public source repository now advance together at each release tag, and no merge reaches a public reader on its own. Publishing costs one dispatch per release, and documentation fixes between releases stay unpublished until the next tag — which is the same latency the other three surfaces carry. A dispatch from a branch, or from a tag whose version the tree does not carry, fails at the verification step before the build runs.

The workflow no longer proves that the Pages-flavored build works on each merge, because it no longer runs on merges; `check:ci:static` and `ci-master.yml` cover the production build, and the base-path configuration this workflow adds on top is exercised only at publication time.

A site already deployed from a master push keeps serving that content until the first tagged dispatch replaces it. Dispatching an existing tag runs the workflow file as it exists at that tag, so a tag predating this change deploys through the previous workflow definition.
