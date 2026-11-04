---
description: "Download the upstream files that a CLI app plugin's entry skill indexes from one directory of the vendor's GitHub repository at a pinned commit, verify them, publish them in the DSH cache, and list the entry skill over them."
kind: "package-library"
---

# @deepseek-ai/dsh-upstream-skills

English | [中文](README.zh.md)

## Summary

CLI app plugins such as WeCom and Tencent Meeting use this library for guides that their vendor publishes only in its GitHub repository. The plugin keeps its own entry `SKILL.md` and pins one directory of that repository by commit, total size, and digest. `registerUpstreamSkills` downloads the commit's archive when the plugin loads, keeps the directory and the license file, verifies them, publishes them in the DSH cache, and then lists the entry skill with the published directory as its base directory. The repository and the plugins' npm packages carry no copy of the upstream files.

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

### When to use it

Use it in the Host row of a CLI app plugin whose upstream skills exist only in the vendor's GitHub repository, so that each user's computer downloads them from the vendor at run time. A plugin whose CLI embeds its guides reads them through the CLI, as Feishu does, and a plugin whose release ships a checksummed skills archive downloads it together with the executable, as DingTalk does.

### Entry point

A plugin pins the upstream files, adds the shared config fields to its own `Config`, and registers its entry skill at load:

```ts
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { registerUpstreamSkills, type UpstreamSkillsConfig, type UpstreamSkillSet } from '@deepseek-ai/dsh-upstream-skills'
import type {} from '@deepseek-ai/dsh-skill'

declare const ctx: Context
declare const config: UpstreamSkillsConfig

const VENDOR_SKILLS: UpstreamSkillSet = {
  repository: 'vendor/vendor-cli',
  commit: '0123456789abcdef0123456789abcdef01234567',
  directory: 'skills',
  exclude: [],
  license: 'LICENSE',
  bytes: 1_754_686,
  sha256: 'c75045cc5297d5886c8a7ff01c993a782e50cbd4aa6f6559394b695157d52e10',
}

const skills = registerUpstreamSkills(ctx, {
  name: 'vendor',
  entry: fileURLToPath(new URL('../skills/vendor/SKILL.md', import.meta.url)),
  set: VENDOR_SKILLS,
  config,
})
```

`registerUpstreamSkills` reads the entry's name and description from its YAML frontmatter, registers a skill provider under `name`, and starts the download unless the files are already in place. `skills.directory` is `skillsDir`, or `$DSH_HOME/cache/<name>/skills-<first 16 digest digits>`. `skills.state` is `downloading` while a download runs, otherwise `installed` when that directory exists and `failed` when it does not. `skills.watch(listener)` reports each start and end of a download, and `skills.retry()` starts another download after a failure and returns at once. A plugin shows the state beside its account and calls `retry()` from its check without waiting, so a slow download never holds its account operations. A failed download is logged as a warning. Disposing the plugin aborts the download, removes the provider, and ends the notifications. The entry's body refers to the upstream files by their repository paths, such as `skills/<guide>/SKILL.md`. The contracts in [`src/index.ts`](src/index.ts) and [`src/types.ts`](src/types.ts) are authoritative.

### Kept files and verification

The library downloads `<prefix>/<owner>/<repository>/tar.gz/<commit>` from each `skillsUrls` prefix in order. A prefix that answers with an error status or no body, does not deliver the whole archive within `skillsTimeoutMs`, sends a malformed archive, or sends files that differ from the pin is logged with its origin, and the next prefix is tried; disposing the plugin stops at once. The library keeps every regular file under `directory` except the paths in `exclude`, plus `license`, at their repository paths. It refuses an archive with an empty, `.`, or `..` path segment or a backslash in any entry, entries outside its one top-level directory, a kept path that is a link or appears twice, kept files above `bytes`, or no license file. On Windows, node-tar turns backslashes into slashes before the library reads a path, so the segments they separate are checked instead. The digest hashes each kept file's path, byte length, and content in path order, because GitHub keeps the files of a commit archive stable but not its compressed bytes. Verified files are written to a sibling staging directory, which is then renamed to `skills.directory`; a directory that another process, such as Desktop beside Web, published first is kept.

### Pinning a commit

`pnpm exec tsx scripts/upstream-skills-digest.ts --repository <owner>/<repository> --commit <full id> --directory <path> [--exclude <path>]... [--license LICENSE] [--url <prefix>]` downloads the archive from the `--url` prefix, `https://codeload.github.com` by default, keeps the same files, prints the pin as JSON, and lists the kept `SKILL.md` paths on stderr.

### Shared config

| Field | Default | Meaning |
|---|---|---|
| `skillsDir` | none | Directory holding the kept files at their repository paths; when set, nothing is downloaded, and a path that is not a directory fails the load |
| `skillsUrls` | `['https://codeload.github.com']` | HTTPS archive download prefixes, without a query, fragment, or credentials, tried in order |
| `skillsTimeoutMs` | `120000` | How long one prefix may take to deliver the whole archive before the next is tried |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The provider lists the entry only while `skills.directory` exists, with source `bundled` at the bundled rank, so a project or user skill of the same name wins. It returns a complete, empty list before publishing, because an incomplete observation would make the whole skill catalog incomplete; publishing invalidates the catalog instead. One download runs at a time, and the provider registration's signal aborts it when the plugin is disposed. Kept files are held in memory, bounded by `bytes`, until they match the digest, so no unverified file reaches the disk; files outside the selection are read and dropped, so `skillsTimeoutMs` bounds the time spent on them.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Shared config fields, registration, the provider, and publishing |
| [`src/archive.ts`](src/archive.ts) | Download, archive reading, path and size checks, the digest, and file writing |
| [`src/types.ts`](src/types.ts) | The pin and handle types |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Connector packages](../README.md) — the group this library and the CLI app plugins belong to.
- [Runtime download of upstream skills](../../../.agents/notes/implemented/architecture/2026-10-28-upstream-skills-runtime-download.md) — why the plugins download the files instead of carrying a copy.
- [Skill registry](../../skill/skill/README.md) — the provider and catalog API this library implements.
- [Skill subsystem reference](../../../docs/subsystems/skills.md) — how skills reach the model.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-skill`, which lists the entry skill in its catalog once the upstream files are published and returns the entry body with `skills.directory` as the skill's base directory.

#### KV Cache effect

A load that finds the files in place lists the entry in the session's first catalog. A download that finishes after the first catalog makes `dsh-tool-skill` append one replacement catalog that includes the entry; earlier request tokens are unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The first load after a new pin needs GitHub or a configured mirror; until a download succeeds, the entry skill is not listed and the plugin shows the `failed` state.
- Published directories stay in `$DSH_HOME/cache/<name>` after a plugin pins another commit and after the plugin is removed; nothing prunes them. A process that exits while it writes a download leaves its `.skills-<digest>-<uuid>` staging directory there too.
- Only the published directory's existence is checked. When files inside it are deleted or changed, the entry skill stays listed over them; deleting the directory makes the next check or load download the pin again.
- File modes are not kept, so an upstream script is not executable; the current upstream guides run their scripts through `python3`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
