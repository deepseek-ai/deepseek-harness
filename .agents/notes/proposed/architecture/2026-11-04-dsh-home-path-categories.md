# Agent Note: Harness home path categories

Status: proposed

English | [中文](2026-11-04-dsh-home-path-categories.zh.md)

## Problem

Each package builds its own path under `$DSH_HOME` (default `~/.dsh`), so the home root mixes user configuration, durable records, logs, indexes, and downloads. A new service or plugin has no rule for where its files belong, and some owners resolve the home by hand: [liveshare](../../../../packages/experimental/liveshare/src/host/share-host.ts) reads `process.env.DSH_HOME` directly, and [migrate-sessions-to-v4](../../../../scripts/migrate-sessions-to-v4.ts) defaults to `~/.dsh/sessions` without reading `DSH_HOME`.

## Proposal

Group paths under `$DSH_HOME` by the kinds the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/) uses. Every category stays inside `$DSH_HOME`; the harness does not read `XDG_*` variables.

| Category | Holds | Losing it |
|---|---|---|
| `config` | Files a person writes or edits to configure the harness | Loses the user's configuration |
| `data` | Durable records: user work, sign-ins, installed software | Loses user work, sign-ins, or installed software |
| `state` | Records that persist across runs but are not user work: logs, indexes, ids, retained outputs | Resets history; the harness keeps working |
| `cache` | Content the harness can rebuild or download again | Costs time or bandwidth only |
| `backup` | Backup archives the harness writes, such as compressed copies of the home or a profile | Nothing; the archives are not read during normal operation |

There is no `runtime` category, the XDG kind for sockets and pid files, because no owner needs one under the home: locks sit beside the file they protect, and live sockets stay in the operating-system temporary directory because Unix socket paths have a length limit. `backup` is not an XDG kind: it gives backup archives one directory that users and cleanup tools can empty at any time without affecting a running harness or the records the archives copy.

### Path helper

[`dshPath(category, ...segments)`](../../../../packages/util/home-paths/src/index.ts) in `@deepseek-ai/dsh-home-paths` returns `<home>/<category>/<segments>` without creating directories; `dshPath({ category, dshHome }, ...segments)` resolves an explicit configured home. Loader `!!js` config expressions receive the same function beside `dshHomePath`. A new path under the home uses `dshPath` and passes its owner's directory name, normally the package name without the `@deepseek-ai/dsh-` prefix, as the first segment. `dshHomePath` remains for the existing top-level entries, and `dshCachePath` is `dshPath('cache', ...)`.

### Conventional top-level entries

Users open, edit, and script against these entries directly, and documentation across the repository names them, so they keep their current top-level locations and are not candidates for moving:

| Path under `$DSH_HOME` | Owner | Kind |
|---|---|---|
| `.env` | [app-boot](../../../../packages/boot/app-boot/README.md) environment layer | config |
| `cordis.patch.yml` | [app-boot](../../../../packages/boot/app-boot/README.md) home patch layer | config |
| `AGENTS.md` | [agent-instructions](../../../../packages/context/agent-instructions/README.md) | config |
| `skills/` | [skill-filesystem](../../../../packages/skill/skill-filesystem/README.md) | config |
| `.credentials.yaml` | [credentials-local](../../../../packages/credentials/credentials-local/README.md) | data |
| `profiles/<name>/` | [app-boot](../../../../packages/boot/app-boot/README.md), plugin-manager, Desktop (`desktop` profile and its `lock`) | data |
| `sessions/` | session-persistence-jsonl root in the base and sdk-minimal bundles | data |
| `cache/` | already the `cache` category | cache |

Files inside a profile directory, such as `node_modules/`, `pnpm-lock.yaml`, `compatibility.json`, `.plugin-manager/`, `.plugin-market/repositories/`, `created-plugins/`, and `cua-*.lock`, stay with their profile because pnpm and the profile tools address them relative to it. The legacy `settings.yaml` importer keeps reading the home root because that file is the import source.

### Other existing entries

These entries have no user-facing convention. Each row names the category it belongs to; moving it is a separate change that needs a data migration plan:

| Current path under `$DSH_HOME` | Category | Owner | Why |
|---|---|---|---|
| `storages/` | `data` | storage-json root in the base bundle | Workspace, schedule, and other domain records; its `session_projcache` unit is a rebuildable cache, but storage-json has one root |
| `attachments/v1/` | `data` | [attachment-local](../../../../packages/attachment/attachment-local/README.md) | User attachments; Session history records their absolute paths |
| `dsh-runtimes/` | `data` | Desktop offline runtimes ([workspace-dependencies](../../../../packages/bundle/web-app/cordis.patch.yml)) | Installed software that may hold user additions |
| `liveshare/` | `data` | [liveshare](../../../../packages/experimental/liveshare/README.md) owner state and credential | Holds management tokens |
| `.anonymous-user-id` | `state` | [anonymous-user-id](../../../../packages/identity/anonymous-user-id/README.md) | Losing it only issues a new id |
| `logs/` | `state` | CLI startup failure reports | Logs |
| `llm-deepseek/files-v3.json` | `state` | [llm-deepseek](../../../../packages/llm/llm-deepseek/README.md) upload index | Derived index |
| `office-kit/outputs/` | `state` | [office-kit](../../../../packages/document/office-kit/README.md) | Retained conversion outputs removed after their retention period |
| `speech-to-text/sensevoice/` | `cache` | voice-input-bundle | Downloadable models |
| `cache/attachments/` | `cache` | attachment-local request images | Already in `cache` |

### Outside the home

These locations are out of scope: `~/.agents` (`DSH_AGENTS_HOME`), shared with other agent tools; Electron `userData` and `logs`, managed by Electron; the Python SDK resource cache `~/.cache/deepseek-harness/resources` (`DSH_RESOURCE_CACHE`), shared across homes; spill and subprocess output directories under the operating-system temporary directory; and developer or release script state such as `~/.dsh-desktop-signing`.

## Alternatives considered

**Move every entry now.** A first draft moved all entries, including the conventional ones, into category directories with no fallback. It made every existing home look empty after an upgrade, broke absolute attachment paths recorded in Sessions, and renamed files users edit by hand. The conventional entries above now stay, and the remaining moves wait for a migration plan.

**Read `XDG_*` variables.** Splitting the home across `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and similar roots would scatter one installation across several directories and break the single `DSH_HOME` override that tests, the SDK, and Desktop rely on; the [single harness home resolver](../../implemented/architecture/2026-07-24-single-harness-home-resolver.md) already rejected separate roots. The proposal borrows only the classification, inside that one root.

**Add a `runtime` category.** No current owner needs one; adding it would publish an unused value.

## Acceptance criteria

- New paths under `$DSH_HOME` are built with `dshPath` and land in one category directory.
- Each move of an entry from "Other existing entries" ships with a migration that preserves existing user data, plus an upgrade guide.
- The conventional top-level entries keep their locations.

## Risks

Until migrations land, the home holds both category directories and legacy top-level entries. Moving `attachments/` invalidates absolute paths in Session history unless the migration keeps the old location readable. Owners that resolve the home by hand do not pick up the helper until they are changed.
