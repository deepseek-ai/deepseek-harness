---
name: dsh-create-upgrade-guide
description: Use when a deepseek-harness change breaks an externally perceptible surface (CLI, profiles, cordis.yml or settings keys, persisted user data, SDK or wire APIs, published package entry points), or when changing a surface that an unreleased upgrade guide already covers, to write or update docs/upgrade-guide/v<version>/<item>/guide.md.
---

# DSH Create Upgrade Guide

An upgrade guide tells a reader who runs release vT what to change to run the next release. Write it in the change that introduces the break, as soon as the break is recognized; do not defer it to release preparation.

## Scope

Write a guide only for breaks that someone outside the repository can observe after upgrading:

- `dsh` commands, flags, and profile names;
- `cordis.yml`, patch, overlay, and settings keys or their accepted values;
- persisted user data: Session logs, SQLite stores, and user data directories;
- TypeScript and Python SDK exports, JSON-RPC, HTTP, and ACP messages;
- published package names and entry points.

Pre-stable internal APIs whose consumers are all updated in the same change need no guide. A Session-format change still follows [type acknowledgements](../../../docs/cookbook/reviewing-persistence-type-changes.md); its guide states only the reader's actions and links that record.

## Location

`docs/upgrade-guide/v<version>/<item>/guide.md`

- `<version>` is the `version` field of the root `package.json` when you write the guide, for example `v0.1.7-rc.2`. The guide describes the upgrade from that release to the next one.
- `<item>` is a kebab-case name of the changed surface, for example `profile-flag-rename`.
- Each item directory holds exactly `guide.md`, its Chinese counterpart `guide.zh.md`, and the pairing record `guide.i18n.yaml`: no index, no attachments.

## Maintenance

While the root version is unchanged, the current version directory describes the delta from vT to current `master`. When a later change touches a surface a guide there covers, update that guide in the same change; delete the guide when the break is reverted. After the version bump, guides in older version directories are frozen; a new break goes into the new version directory. Never write a guide spanning more than one release.

## Format

Start from the [upgrade-guide template](../dsh-doc/templates/upgrade-guide.md). `verify-upgrade-guides` enforces:

- frontmatter with exactly `kind: upgrade-guide` and a one-sentence `description` naming what breaks; add a key only together with its gate check, then backfill every guide;
- one `#` title, then exactly the `## Change` and `## Migration` sections in `guide.md`, and `## 变更` and `## 迁移` in `guide.zh.md`, in that order;
- at most 500 words in `guide.md`, frontmatter included.

`Change` states the old and new behavior of the surface and who is affected. `Migration` lists ordered steps that name exact files, keys, commands, or symbols, and states how to confirm the migration worked.

When a guide needs more than 500 words, the extra text belongs elsewhere: link source files or symbols instead of restating code, move rationale into an [Agent Note](../../notes/README.md), and turn repeated mechanical steps into a script or `dsh` command that the guide invokes.

Follow [dsh-prose-standard](../dsh-prose-standard/SKILL.md). Write the Chinese counterpart in the same change under the [bilingual pairing rules](../../../docs/AGENTS.md), then record the pair with `pnpm run verify-translation-pairing --write docs/upgrade-guide/v<version>/<item>/guide.md`.

## Verify

```sh
pnpm run verify-upgrade-guides
pnpm run verify-translation-pairing docs/upgrade-guide/v<version>/<item>/guide.md
pnpm run verify-md-links
```
