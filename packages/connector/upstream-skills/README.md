---
description: "Register a CLI app plugin's entry skill with the Host Service `ctx.upstreamSkills`: it downloads the upstream files the entry indexes from one directory of the vendor's GitHub repository at a pinned commit, verifies them, publishes them in the DSH cache, and lists the entry skill over them."
kind: "package-reference"
---

# @deepseek-ai/dsh-upstream-skills

English | [中文](README.zh.md)

## Summary

CLI app plugins such as WeCom and Tencent Meeting register with `ctx.upstreamSkills` for guides their vendor publishes only in its GitHub repository. The plugin keeps its own entry `SKILL.md` and pins one directory of that repository by commit, total size, and digest. The Service downloads the commit's archive when the plugin loads, verifies the kept files, publishes them in the DSH cache, and lists the entry skill with the published directory as its base directory. The repository and the plugins' npm packages carry no copy of those files. The base bundle loads the Service, which downloads nothing until one registers.

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

A CLI app plugin's Host row injects `upstreamSkills` and calls `register` once; the registration lasts until the plugin unloads or disposes the returned handle.

### When to choose it

Register from the Host row of a CLI app plugin whose upstream skills exist only in the vendor's GitHub repository, so that each user's computer downloads them from the vendor at run time. A plugin whose CLI embeds its guides reads them through the CLI, as Feishu does, and a plugin whose release ships a checksummed skills archive downloads it together with the executable, as DingTalk does.

### Minimal configuration

The [base bundle](../../bundle/base/cordis.patch.yml) loads the Service in every profile built on it, after the `skills` registry it injects:

```yaml
- id: upstream-skills
  name: '@deepseek-ai/dsh-upstream-skills'
```

| Field | Default | Meaning |
|---|---|---|
| `skillsUrls` | `['https://codeload.github.com']` | HTTPS archive download prefixes, without a query, fragment, or credentials, tried in order; they apply to every registered plugin |
| `skillsTimeoutMs` | `120000` | Whole milliseconds one prefix may take to deliver the whole archive before the next is tried; it applies to every registered plugin |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-upstream-skills) is the exhaustive source for every accepted field. An empty `skillsUrls`, a prefix that does not parse as such a URL, or a `skillsTimeoutMs` below 1 or above 2147483647 fails at load.

### Register an entry skill

The plugin's Host row lists `upstreamSkills` in `inject`, pins the upstream files, and registers from `apply`:

```ts
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { UpstreamSkillSet } from '@deepseek-ai/dsh-upstream-skills'

const VENDOR_SKILLS: UpstreamSkillSet = {
  repository: 'vendor/vendor-cli',
  commit: '0123456789abcdef0123456789abcdef01234567',
  directory: 'skills',
  exclude: [],
  license: 'LICENSE',
  bytes: 1_754_686,
  sha256: 'c75045cc5297d5886c8a7ff01c993a782e50cbd4aa6f6559394b695157d52e10',
}

export interface Config { skillsDir?: string }

export const inject = ['upstreamSkills']

export function apply(ctx: Context, config: Config): void {
  const skills = ctx.upstreamSkills.register({
    name: 'vendor',
    entry: fileURLToPath(new URL('../skills/vendor/SKILL.md', import.meta.url)),
    set: VENDOR_SKILLS,
    skillsDir: config.skillsDir,
  })
  if (!skills.installed()) ctx.logger.info('vendor: downloading the upstream skills')
}
```

`register` reads the entry's name and description from its YAML frontmatter, registers a skill provider under `name`, and starts the download unless the files are already in place. The registration belongs to the plugin whose `ctx` made the call: unloading that plugin aborts the download and removes the provider. A second registration under one `name` throws and leaves the first in place.

- `name` is the skill provider's name, the prefix of the plugin's errors and log records, and the directory under `$DSH_HOME/cache` that receives the download.
- `entry` is the absolute path of the packaged entry `SKILL.md`, whose body refers to the upstream files by their repository paths, such as `skills/<guide>/SKILL.md`.
- `set` is the pin that `scripts/upstream-skills-digest.ts` prints.
- `skillsDir` is the plugin's own optional config field: a directory that already holds the kept files at their repository paths. When it is set, nothing is downloaded: a path that is not a directory makes `register` throw, and a directory removed later makes `install` reject.

The returned handle serves the plugin's account check. `directory` is `skillsDir`; otherwise it is `$DSH_HOME/cache/<name>/<profile>/skills-<first 16 digest digits>` in a profile and `$DSH_HOME/cache/<name>/skills-<first 16 digest digits>` without one. `installed()` tells whether that directory exists. `install(signal)` returns at once when it does; otherwise it waits for the running download, or starts one when none runs, and rejects when that download fails. Aborting `signal` stops the download, also for every other caller that waits for it. A plugin registered with `ctx.cliAccounts` passes the two as its [`prepare` step](../cli-account/README.md#prepare-before-a-check), `ready: () => skills.installed()` and `run: signal => skills.install(signal)`: its account check then waits for the files, the model gets the CLI's path only once they are in place, and the Plugins page's retry downloads them again. A failed download is logged as a warning. `dispose()` withdraws the registration before the plugin unloads. The contracts in [`src/index.ts`](src/index.ts) and [`src/types.ts`](src/types.ts) are authoritative.

### Kept files and verification

The Service downloads `<prefix>/<owner>/<repository>/tar.gz/<commit>` from each `skillsUrls` prefix in order. A prefix that answers with an error status or no body, does not deliver the whole archive within `skillsTimeoutMs`, sends a malformed archive, or sends files that differ from the pin is logged with the prefix, and the next prefix is tried; unloading the plugin stops at once. The Service keeps every regular file under `directory` except the paths in `exclude`, plus `license`, at their repository paths. It refuses an archive with an empty, `.`, or `..` path segment or a backslash in any entry, entries outside its one top-level directory, a kept path that is a link or appears twice, kept files above `bytes`, or no license file. On Windows, node-tar turns backslashes into slashes before the Service reads a path, so the segments they separate are checked instead. The digest hashes each kept file's path, byte length, and content in path order, because GitHub keeps the files of a commit archive stable but not its compressed bytes. Verified files are written to a sibling staging directory, which is then renamed to the handle's `directory`; a directory that another process, such as Desktop beside Web, published first is kept.

### Replaced pins

Each profile that `dsh` launches has a directory of its own for a plugin's files, `$DSH_HOME/cache/<name>/<profile>`, which the processes of that profile share. A registration deletes the other pins of that directory once, the first time its own pin is in place there: already at load, or after its download. A plugin update that changes the pin therefore leaves one copy, and the earlier pin stays until the new one is published. The deletion runs in the background, and neither `register` nor the end of a download waits for it; a pin that cannot be deleted is logged as a warning and deleted at a later load. Because a registration deletes the other pins only once, a process whose pin another process of the profile deleted downloads it again at its next check and leaves that process's pin in place; [Known Limitations](#known-limitations-and-deferred-work) describes that case. A composition that `dsh` did not launch has no profile: its pins stay in `$DSH_HOME/cache/<name>`, which several installations may share, and none is deleted. A configured `skillsDir` and its sibling directories are never deleted.

### Pinning a commit

`pnpm exec tsx scripts/upstream-skills-digest.ts --repository <owner>/<repository> --commit <full id> --directory <path> [--exclude <path>]... [--license LICENSE] [--url <prefix>]` downloads the archive from the `--url` prefix, `https://codeload.github.com` by default, keeps the same files, prints the pin as JSON, and lists the kept `SKILL.md` paths on stderr.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`register` runs in the calling plugin's context, so the skill provider is an effect of that plugin and is removed with it. The provider lists the entry only while the handle's `directory` exists, with source `bundled` at the bundled rank, so a project or user skill of the same name wins. It returns a complete, empty list before publishing, because an incomplete observation would make the whole skill catalog incomplete; publishing invalidates the catalog instead, as does a failed download that finds a directory another process published. One download runs at a time: every `install` call made while it runs waits for it, the abort of any such caller's signal stops it, and the provider registration's signal aborts it when the plugin unloads. Kept files are held in memory, bounded by `bytes`, until they match the digest, so no unverified file reaches the disk; files outside the selection are read and dropped, so `skillsTimeoutMs` bounds the time spent on them.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `ctx.upstreamSkills` Service, its config, `register`, the provider, and publishing |
| [`src/archive.ts`](src/archive.ts) | Download, archive reading, path and size checks, the digest, and file writing |
| [`src/types.ts`](src/types.ts) | The pin, registration, and handle types |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Connector packages](../README.md) — the group this package and the CLI app plugins belong to.
- [Runtime download of upstream skills](../../../.agents/notes/implemented/architecture/2026-10-28-upstream-skills-runtime-download.md) — why the plugins download the files instead of carrying a copy.
- [Skill registry](../../skill/skill/README.md) — the provider and catalog API the Service registers each entry skill with.
- [Skill subsystem reference](../../../docs/subsystems/skills.md) — how skills reach the model.
- [Base bundle](../../bundle/base/README.md) — the bundle that loads the Service, and how a profile overrides one of its rows.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-skill`, which lists the entry skill in its catalog once the upstream files are published and returns the entry body with the handle's `directory` as the skill's base directory. While no plugin is registered, the Service adds nothing to a model request.

#### KV Cache effect

A load that finds the files in place lists the entry in the session's first catalog. A download that finishes after the first catalog makes `dsh-tool-skill` append one replacement catalog that includes the entry; earlier request tokens are unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The first load after a new pin needs GitHub or a configured mirror; until a download succeeds, the entry skill is not listed, and a plugin whose account check waits for the files reports the failed download instead of the account.
- Each profile that loads a plugin downloads its own copy of the pin.
- Processes of one profile can run different versions of a plugin at the same time, such as one started before a plugin update and one started after it. The later one deletes the pin the earlier one reads: the earlier process lists no entry skill, and its agents cannot open the guides, until its next check has downloaded the pin again. Both pins then stay until a process of the profile loads the plugin again.
- Removing a plugin leaves its pin in the cache. A process that exits while it writes a download leaves its `.skills-<digest>-<uuid>` staging directory there too. Nothing deletes either.
- Without a profile, every pin stays in `$DSH_HOME/cache/<name>` after the plugin pins another commit.
- Only the published directory's existence is checked. When files inside it are deleted or changed, the entry skill stays listed over them; deleting the directory makes the next check or load download the pin again.
- File modes are not kept, so an upstream script is not executable; the current upstream guides run their scripts through `python3`.
- In the experimental Web preview, which runs Host plugins in a browser worker, the Service loads but node-tar does not, so every download fails there.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
