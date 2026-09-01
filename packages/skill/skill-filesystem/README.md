---
description: "The local filesystem skill provider for users and maintainers authoring local skills or configuring how project, custom, and user skill roots are discovered and watched."
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-filesystem

English | [中文](README.zh.md)

## Summary

Agents can use local skills from the repository, a custom directory, or the user's agent configuration: author a skill as a directory bundle with a `SKILL.md` or a flat `<name>.md` file under any scanned root, and it appears in the session catalog. The provider discovers the project, custom, and user roots, parses each skill's YAML frontmatter, and watches the directories, so new, renamed, or deleted skills reach agents without a restart. Choose it when skills live on disk — the registry (`dsh-skill`) accepts any provider, and another provider can supply skills from elsewhere.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin to make local skills available to agents. It scans the project, custom, and user skill roots below, parses each skill's frontmatter into a catalog entry, and loads the body on demand; it also watches the roots so new, renamed, or deleted skills reach the next catalog without a restart.

### When to choose it

Use this provider when skills live on disk — in the repository, a custom directory, or the user's agent configuration. Avoid it when skills come from a remote registry or embedded plugin data: the registry accepts any provider, and this package is one implementation.

### Skill format

A skill is either a directory bundle `<name>/SKILL.md` or a flat file `<name>.md` at the top level of a scanned root; nested `**/SKILL.md` files are deliberately not discovered. The file starts with YAML frontmatter: required `name` and `description`, plus optional `whenToUse`, `metadata`, `disable-model-invocation`, and `user-invocable`.

`disable-model-invocation: true` keeps the skill out of model-facing catalogs and loaders; `user-invocable: false` keeps it out of human-facing commands, and omitted fields default to permitting their surface. The two keys accept YAML booleans plus the case-insensitive `true`/`false`, `yes`/`no`, `on`/`off`, and `1`/`0` forms; a rejected spelling or a non-boolean value drops the whole skill with a warning rather than silently permitting a surface.

The catalog and the body have separate lifecycles: discovery parses frontmatter into the catalog entry, and every load re-reads the current file, so editing a skill body needs no versioning or cache invalidation.

### Roots and priority

Default roots are scanned in this provider's rank order:

| Rank | Source | Path |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `Config.customSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills` |
| 500 | `user-agents` | `<agentsHome>/skills` |

The project root is the nearest ancestor containing `.git`; without one, the current cwd is used. The user DSH root skips its `.system` child. `includeDefaultRoots: false` omits the project and user rows plus the `$DSH_BUNDLED_SKILL_DIR` default so an isolated provider sees only its own configured roots; `bundledSkillDir` adds a bundled root at rank 600.

### Mount and configure

Load the plugin alongside the skill registry; it requires `ctx.skills`.

```yaml
- name: '@deepseek-ai/dsh-skill'
- name: '@deepseek-ai/dsh-skill-filesystem'
```

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `filesystem` | Unique provider name registered on `ctx.skills` |
| `includeDefaultRoots` | `true` | Include project and user roots around `customSkillDirs` |
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Harness config root; its `skills` subdirectory is scanned |
| `agentsHome` | `$DSH_AGENTS_HOME` or `~/.agents` | Shared agent config root scanned for compatible skills |
| `customSkillDirs` | `[]` | Additional local skill roots, after project roots and before user roots |
| `watch` | `true` | Watch local roots and invalidate the provider when the catalog may have changed |
| `bundledSkillDir` | — | Bundled skill root scanned at rank 600 when configured |

The remaining `watch*` fields tune Chokidar behavior — polling, stability window, interval, project cap, and symlink following. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-skill-filesystem) is the exhaustive source for every field.

### Change detection

Existing roots are watched, so adding, renaming, or deleting a skill (or editing its frontmatter) triggers a catalog refresh for the next model step; edits below `references`, `scripts`, `assets`, and other bundle resources do not. The first-party `write` and `edit` tools invalidate the provider directly when their target could affect a watched skill, so the model observes its own filesystem mutation without waiting for the host watcher. External IDE, Git, and shell changes are picked up by the host watcher, and a root that does not exist yet is probed until it appears.

### Observable success and failures

A valid skill under any scanned root appears in the session catalog sorted by name, and loading it returns the current file body. A file without valid frontmatter, an invalid name, or an invalid invocation value is skipped with a warning, so the model catalog receives no per-skill diagnostic and cannot distinguish an absent skill from an invalid one. Unexpected discovery or read failures leave the catalog observation incomplete rather than replacing the last-good view with a misleading deletion.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how discovery and watching are organized; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The provider is built on two separations. First, catalog versus body: discovery parses frontmatter into summaries, while every load re-reads the file, so body edits need no hash, revision, or cache invalidation. Second, discovery versus watching: `list()` scans roots and resolves the project root through `ctx.fs` when a filesystem service is present (falling back to abortable Node I/O), while a separate watch manager owns Chokidar handles, missing-root probes, and invalidation.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry, provider, root resolution, frontmatter parsing, watch manager |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Discovery flow

Discovery resolves the root list for the lookup cwd, asks the watch manager to attach to each root, then scans each root's direct entries: directory bundles resolve `<name>/SKILL.md`, flat files resolve `<name>.md`. Each file is parsed for frontmatter — `name` must be kebab-case, `description` is required, and the invocation keys resolve through the strict boolean grammar — and candidates carry the root's source label and rank so the registry can merge them with other providers. Confirmed missing paths are valid empty state; malformed or non-text entries warn and skip.

### Watching and invalidation

Existing roots are watched by Chokidar at depth 1; a root that does not exist is followed from its nearest existing ancestor one missing segment at a time using `fs.watchFile`. Relevant events — direct bundle add/remove, flat `.md` add/remove, and direct `SKILL.md` add/remove/change — coalesce into one provider invalidation per microtask batch, while resource-subtree changes are ignored. The watch manager is bounded by `watchMaxProjects`, logs and retries failed startup, and closes every handle at teardown. First-party `write`/`edit` mutations invalidate synchronously through the `fs/observed` event.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the registry contract to the consumer that renders discovered skills and the home-path resolution used by the config defaults.

- [Skill subsystem reference](../../../docs/subsystems/skills.md) — the registry contract and the local discovery priority table.
- [skill package](../skill/README.md) — the registry this provider registers on.
- [tool-skill package](../tool-skill/README.md) — how discovered skills reach the session catalog and the model.
- [home-paths package](../../util/home-paths/README.md) — how `dshHome` and `agentsHome` resolve.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-skill`, which renders this provider's invocable names and capped descriptions into the initial or replacement catalog and a selected current instruction body plus resource-base guidance into retained tool history while paths, provider ranks, and disabled skills remain hidden.

#### KV Cache effect

Watcher invalidation can cause the named consumer to append a replacement catalog to the existing request history. Body-only edits leave the catalog digest unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Discovery is one level deep** — only `<root>/<name>/SKILL.md` and `<root>/<name>.md` are recognized; nested skill trees and package manifests are ignored.
- **Project scope is the nearest `.git` ancestor** — workspaces without that marker fall back to the supplied cwd, with no alternate project-root marker or monorepo subproject selection.
- **Malformed entries disappear with a warning** — the model catalog receives no per-skill diagnostic and cannot distinguish an absent skill from an invalid one; unexpected I/O failures preserve the last-good catalog instead.
- **Missing-root observation polls one path segment** — roots absent at startup use `fs.watchFile` at `watchPollIntervalMs` until Chokidar can attach, trading bounded detection latency for reliable creation detection across IDE, Git, and shell workflows.
- **No body revision protocol** — a loaded body is ordinary retained tool history; later file edits affect later calls but neither rewrite old results nor announce that the body changed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the code. A TODO in `src/index.ts` proposes extracting the Chokidar and missing-root observation into a Cordis file-watch service, keeping skill filtering and invalidation here; the missing-root polling tradeoff documented above is part of that open design.

</details>
