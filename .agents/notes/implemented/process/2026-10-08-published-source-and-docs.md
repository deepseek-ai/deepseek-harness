# Agent Note: Published source and documentation

Status: implemented

English | [中文](2026-10-08-published-source-and-docs.zh.md)

## Problem

A published `@deepseek-ai/dsh-*` package carried declarations, bundled runtime, and locale resources, but not the TypeScript the declarations describe. Its `exports` map nevertheless declared `./src/*`, so an installed consumer resolved that subpath to files the tarball did not contain. A plugin author who wanted the implementation behind a documented API had to read the declaration, the documentation website, or a checkout at the matching `dsh-v*` tag: the first stops at the declaration, and the other two are not the installed version. The repository's Markdown documentation reached readers only through the website, which tracks the published release.

## Decision

Every release member publishes its TypeScript source and the declaration maps that resolve into it, and `@deepseek-ai/dsh` publishes the repository's Markdown documentation.

[`expectedDshPackageFiles`](../../../../scripts/check-workspace-constraints.ts) lists `lib/types/**/*.d.ts.map` after the declarations and `src` last; a package with Typert Remote navigation also lists `lib/typert.remote-client.d.ts.map`, which its generated declaration references through `sourceMappingURL`. [`isForbiddenPublicationFile`](../../../../scripts/publication-payload.ts) rejects only bundled JavaScript maps, so both additions pass the static manifest check and the release family's packed-tarball check. The `./src/*` export that 315 of the 332 release members already declared resolves for an installed consumer.

`@deepseek-ai/dsh` stages the repository `docs` tree into `apps/cli/docs` from its `prepack` lifecycle through [`scripts/stage-dsh-docs.ts`](../../../../scripts/stage-dsh-docs.ts). The staged copy omits `docs/persistence-changes/`, whose per-release migration records the current contract replaces, and the `*.i18n.yaml` consistency records the documentation gates own. Images and every other reader-facing asset ship with it.

The vendored family keeps upstream's payload unchanged; upstream owns those manifests, and they export `./src/*` ([release sequences](2026-08-10-npm-release-sequences.md)).

Desktop packaging keeps its own [runtime-file policy](../../../../apps/desktop/scripts/runtime-file-policy.ts), so the packaged application omits declarations and declaration maps and carries `src` and the staged `docs` tree, neither of which it loads.

## Alternatives considered

**Keep the payload declarations-only and send readers to the documentation website or the matching `dsh-v*` tag.** Rejected because neither is the installed version, and the website serves the latest published release rather than a prerelease. The declared `./src/*` export also has no meaning without those files.

**Publish declaration maps without `src`.** Rejected because a map whose `sources` are absent resolves nothing, which is exactly the navigation the [Typert Remote design](../architecture/2026-08-02-typert-remote-method-calls.md) requires.

**Publish bundled JavaScript maps alongside the runtime bundles.** Rejected because those are single-artifact builds whose maps describe a build tree that is not published.

**Ship the documentation as a separate `@deepseek-ai/dsh-docs` package.** Rejected because it adds a public package and a release member for content that belongs beside the command every install already has.

**Publish `docs/persistence-changes` with the rest of the documentation.** Rejected because those records answer a version-comparison question, and their 16 MB would dominate the payload.

## Consequences

`src` adds about 29 MB and declaration maps about 10 MB across the release set, and the staged `docs` tree adds about 6.7 MB to `@deepseek-ai/dsh`. Package tarballs grow accordingly, and the Desktop application carries `src` it never loads.

A consumer editor now follows a declaration to the installed implementation, and a plugin author reads that version's source and documentation without a checkout. The staged copy keeps the repository's relative links, so a link from a shipped page into an unshipped tree — `../packages/**`, or the omitted `docs/persistence-changes/` records — resolves only in a checkout. The documentation payload closes the website's release skew only for the version it shipped with; a consumer still compares `dsh --version` when the difference matters.

`pnpm run constraints` rejects a member whose `files` omits `src` or either declaration map, because the canonical list is exact. The release family's tarball validation rejects a bundled JavaScript map and requires `@deepseek-ai/dsh` to carry documentation and source, so a pack run that skips the staging hook fails instead of publishing without them.
