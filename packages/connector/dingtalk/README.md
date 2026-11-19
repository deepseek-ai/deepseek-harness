---
description: "Add the DingTalk plugin to a profile: the official dws with its skill, and DingTalk sign-in on the Plugins page."
kind: "package-bundle"
---

# @deepseek-ai/dsh-dingtalk

English | [中文](README.zh.md)

## Summary

The DingTalk plugin lets conversations use DingTalk through the official DingTalk Workspace CLI, `dws`. It downloads that CLI and the official DingTalk skills from one pinned release into the DSH cache, gives the model the absolute path of `dws` in runtime context, and registers one `dingtalk` skill indexing those skills. It registers the account with the [connector account registry](../../client/ui-connector-account/README.md), whose Plugins page section checks the sign-in, signs in through the browser, signs out, and cancels. The CLI keeps the sign-in in `~/.dws` and the system keychain, shared with the user's terminal. Only macOS and Windows x64 are supported.

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

### Install into a profile

Install the plugin from the Web sidebar's **Plugins** page or with the CLI:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-dingtalk
dsh plugin --profile web remove @deepseek-ai/dsh-dingtalk
```

The package has no install script to approve. When the `dingtalk` row loads, it downloads two assets of dws release 1.0.64: the archive for the computer's platform, 16 to 20 MB, and `dws-skills.zip`, 3.3 MB. Each comes from GitHub Releases, or from the official Gitee mirror when GitHub fails or has not delivered it within `releaseTimeoutMs`; the row verifies its size and SHA-256 and keeps it in its cache directory, which is `$DSH_HOME/cache/dingtalk/<profile>/` in a profile that `dsh` launches and `$DSH_HOME/cache/dingtalk/` otherwise. The first time its release is in place in a profile's directory, at load or after the download, the row deletes the other releases from it, once, so a plugin update that pins another release leaves one copy, and a release that did not change is not downloaded again. The runtime context gives no `dws` path, and the catalog has no `dingtalk` skill, until those downloads finish. On a platform the release has no archive for, the row fails to load and names the platform; set `binDir` to use another `dws`. With both `binDir` and `skillsDir` set, the row downloads nothing.

Signing in needs a DingTalk account that belongs to an organization whose administrator has turned on CLI access in the DingTalk developer console. Until then, the user can request access on the authorization page.

### What you get

After the downloads finish, one `dingtalk` skill joins the skill catalog. The agent loads it with the `skill` tool, opens the guide for the product at hand, such as `dingtalk-calendar` or `dingtalk-doc`, with the file tools, and runs `dws` by its path through the ordinary Shell tools under the current sandbox and approval policy, with `dws`'s directory first on PATH for a command that runs a guide's script. The agent checks the sign-in with `dws auth status --readonly --format json`, which does not write `~/.dws` and so reports the real state in the file sandbox. When that check or a command reports a missing or expired sign-in, the agent asks the user to connect DingTalk on the plugin page; it runs `dws auth login --no-browser` only when the user asks to finish it in the conversation, and requests `sandbox_permissions` with a `justification` on the first attempt because the command writes outside the workspace. A command that fails because the file sandbox denied a write under `~/.dws` is not a sign-in failure: the agent reruns it with `sandbox_permissions` and a `justification`.

Turning the plugin off in Plugin Manager withdraws the skill, the path from runtime context, and the account section. The CLI sign-in and the downloaded assets stay in place.

<a id="account-operations"></a>
### Account operations

The Plugins page drives these operations through the connector account registry, which the Web app loads; a headless profile loads the plugin without it. The Host runs at most one operation at a time and owns it, so leaving the page does not cancel it. Loading the row starts one check, which also downloads dws and its skills while either is missing.

| Operation | Effect |
|---|---|
| `check` | Downloads dws and its skills while either is missing, then checks the account again; each browser that opens the Web app starts one when no operation runs |
| `sign-in` | Runs `auth login --no-browser --format json`, waits for the user to authorize in a browser on this computer, then checks that dws reports the account signed in. The connected section offers it again as signing in to another organization: dws keeps one account per organization and user, so authorizing with another account adds it, and authorizing with the current one refreshes it; the check then shows the account dws reports as current |
| `sign-out` | After the user confirms, runs `auth logout --profile <corpId>:<userId>` for the account the last check found, which also signs it out of the user's own terminal, then checks again |
| Cancel | Cancels a sign-in while it waits for authorization, or a check while it downloads, and waits for the command or download to stop; other steps are ignored |

A check runs `auth status --format json`, which refreshes an expired access token with the server and exits with code 0 whether or not a user is signed in. The account reads `connected`, with the user and organization names dws reports, when `authenticated` is true; `unverified` when it is false with one of the reasons dws reports as inconclusive (`local_state_requires_repair`, `local_state_unreadable`, `ciphertext_key_mismatch`, `dek_missing`, `keychain_unavailable`); and `signed-out` otherwise. A nonzero exit or output that is not the status JSON fails the check and keeps the previous account; a download that does not finish leaves `not-installed`. Sign-out requires both ids, so it never selects every account of an organization; accounts of other organizations stay signed in, and the next check shows the account dws then reports as current. The link that `auth login` prints alone on an indented stderr line is offered only when it is an HTTPS address on `login.dingtalk.com`. Results report succeeded, cancelled, or failed. Failures show the command and the observed exit code on the page and in the Host log; the CLI's output is omitted. The process running DSH needs access to `~/.dws` and the CLI's macOS keychain item; `DSH_HOME` does not relocate them.

### Configure

| Field | Default | Meaning |
|---|---|---|
| `binDir` | the cache directory holding the downloaded executable | Absolute directory containing an executable `dws`, `dws.exe` on Windows; when set, the executable is not downloaded |
| `skillsDir` | the cache directory holding the downloaded skills | Directory laid out as the `multi/` directory of the release's `dws-skills.zip`; when set, the skills are not downloaded |
| `releaseUrls` | the GitHub Releases and Gitee mirror download prefixes of `DingTalk-Real-AI/dingtalk-workspace-cli` | HTTPS prefixes tried in order for what `binDir` and `skillsDir` do not provide; each serves `v<version>/<asset name>` with a `Content-Length` equal to the asset size. A prefix with a query, fragment, or credentials, or one that does not parse as a URL, fails at load |
| `releaseTimeoutMs` | `300000` | Whole milliseconds one prefix may take to deliver an asset before the next is tried |

An account check or sign-out gets the `commandTimeoutMs` of the [`cli-account` row](../cli-account/README.md#use-this-package), 30 seconds by default. Sign-in waits up to 10 minutes for the user, and each command keeps at most 1 MiB of stdout; the CLI account Service fixes both limits. dws itself stops waiting for authorization after 6 minutes.

The generated [config catalog](../../../docs/config-catalog.md#deepseek-aidsh-dingtalk) is the exhaustive source of supported fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts this package as the `dingtalk` row after the profile's other layers, and the Plugins page keys the account section by this package name. [`src/index.ts`](src/index.ts) is a function plugin. It registers the path of `dws` and the account with `ctx.cliAccounts`, mounts a [filesystem skill provider](../../skill/skill-filesystem/README.md) named `dingtalk` over the skill root that `src/release.ts` publishes, and starts one check so that a session without a browser also finds `dws` and the skill. The provider omits the default roots and watches the skill root, because the first download publishes it after the catalog may already have been listed. The npm package `dingtalk-workspace-cli` is not used: its install script copies the official skills into `~/.agents/skills`, which the default skill provider scans, and into other agents' skill directories, so they would outlive the plugin. dws embeds the same skills, but `dws skill setup` writes only into such agent directories.

[`src/release.ts`](src/release.ts) pins the release version, the archive for each platform, and `dws-skills.zip`, each with the name, size, and SHA-256 from the release's `checksums.txt`. It downloads whichever asset is missing, refuses a response whose `Content-Length` differs before reading the body, and verifies the digest. It extracts a `.tar.gz` platform archive with `tar`, takes only `dws.exe` from the root of the Windows `.zip` archive with `fflate`, and extracts the `multi/` entries and root `LICENSE` and `NOTICE` of the skills archive with `fflate`, into a sibling staging directory, refusing a skills entry whose path has an empty, `.`, or `..` segment or a backslash; it publishes each result by rename, and a directory another process published first is kept. Each source that fails or has not delivered within `releaseTimeoutMs` logs a warning, and cancelling the operation stops the download. An installation that fails for another reason than a cancellation, such as an archive that cannot be extracted or a cache directory that cannot be written, logs a warning with its cause, because the account operation reports only that the download did not finish. The skill root `skill-<digest>/` in the cache directory holds a copy of the packaged entry at `dingtalk/SKILL.md` and a `dingtalk/guides` symbolic link to the skills directory, a junction on Windows, which needs no symlink privilege. The digest covers the entry and the link target, so a published root never changes, and the root is published synchronously at load when the skills directory already exists. Only the processes of a profile read its cache directory. The first time the release is in place there, at load or after an installation, `prune` deletes every `dws-…` and `skill-…` entry there that the release does not use, a downloaded dws that a configured `binDir` replaces included; it does so once for each load of the row. It deletes nothing while the release is not installed, logs an entry it cannot delete, such as a `dws.exe` that still runs on Windows, and deletes it at a later load. Because it deletes only once, a process whose release another process of the profile deleted installs it again at its next check and leaves that process's release in place; [Known Limitations](#known-limitations-and-deferred-work) describes that case. A composition that `dsh` did not launch has no profile; its cache directory may be shared by several installations, and nothing is deleted from it.

The [CLI account Service](../cli-account/README.md) gives the model that path in runtime context while `dws` and the skills are installed, runs each command by the same path, runs one account operation at a time, and reports a failed command by its exit code. [`src/account.ts`](src/account.ts) carries out each operation with the dws commands, prepares the release before a check's first command, reads the authorization link from the stderr lines of `auth login`, and parses the `auth status` JSON. [`src/presentation.ts`](src/presentation.ts) maps each view to the section the registry serves, in the text of [`src/locales.ts`](src/locales.ts). It keeps the signed-in account's ids on the Host for sign-out; the Remote view carries only names. Disposal cancels the active operation, aborts running commands and downloads, and settles after their processes exit.

[`skills/dingtalk/SKILL.md`](skills/dingtalk/SKILL.md) is the only skill: the DSH guidance, an index of the 16 guides, and how to open them. The guides are the `multi/` tree of `dws-skills.zip` in release `v1.0.64`, which the upstream installer uses by default; its `mono/` alternative is one entry that repeats the same content. The filesystem provider discovers only `<root>/<name>/SKILL.md`, so the guides are not separate skills. Guides refer to one another by relative paths such as `../dingtalk-shared/SKILL.md`, which resolve because the guides keep their sibling layout, and run their helper scripts from their own `scripts/` directories. Where the DSH guidance and a guide disagree, the entry tells the agent to follow the DSH guidance: it uses the plugin's `dws` instead of installing or upgrading one, does not run `dws skill setup`, and sends sign-in to the plugin page.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Connector packages](../README.md) — the group this application plugin belongs to.
- [CLI account Service](../cli-account/README.md) — command execution, the CLI path context, and account operations shared by CLI app plugins.
- [Skills](../../../docs/subsystems/skills.md) — catalog publication, loading, and precedence.
- [Connector account surfaces](../../client/ui-connector-account/README.md) — the registry and the Plugins page section that drive the account operations.

-----

<a id="model-experience"></a>
## Model Experience

### Skill catalog entries

#### What the model sees

The skill catalog lists one `dingtalk` skill. Its Chinese description names the DingTalk products it covers and tells the agent to load it, then read the matching guide from its index, whenever the user mentions DingTalk or one of those products, or gives a DingTalk link.

#### Token effect

The entry stays in context while the plugin is loaded and its skill root is published. Its name and description total about 160 characters.

#### KV Cache effect

The catalog is fixed for one plugin version. Loading or unloading the plugin, or the first download publishing the skill root, changes the catalog, which is republished as a new message and leaves earlier context in place.

### Loaded skill body

#### What the model sees

A `skill` tool result for `dingtalk` contains about 2,400 characters: the DSH guidance, a one-sentence index entry for each of the 16 guides, and how to open them. The DSH guidance tells the agent to run the plugin's `dws` by the absolute path from the current runtime context without installing or upgrading another, not to run `dws skill setup`, to check the sign-in only with `dws auth status --readonly --format json`, to ask the user to connect on the plugin page before running `dws auth login --no-browser` itself, to request `sandbox_permissions` for that command from its first attempt, to rerun a command that failed on a denied write under `~/.dws` with `sandbox_permissions` instead of asking the user to connect again, to request it on the first run of later commands that access DingTalk data once a conversation has seen such a denial, and to tell the user that an organization administrator must turn on CLI access when dws reports it off; it takes precedence over the guides where they disagree. Its resource base is the `dingtalk` directory of the skill root in the DSH cache, so the agent opens `guides/<name>/SKILL.md` with the file tools rather than the `skill` tool and resolves each guide's relative paths and scripts against that guide's own directory.

#### Token effect

Each load adds the entry body to the retained tool history. A guide's `SKILL.md`, 4,000 to 21,000 characters, and the references it points to arrive as ordinary file-read output.

#### KV Cache effect

Loading appends a tool result and does not rewrite earlier context.

### CLI path

#### What the model sees

While the row is loaded and both `dws` and the skills are installed, the [CLI account Service](../cli-account/README.md#model-experience) adds one required runtime-context entry with the path of `dws` in `binDir`, which defaults to `dws-<version>-<platform>-<arch>` in the cache directory. The second line covers the guide scripts that call `dws` by name.

##### Runtime-context entry

```markdown
DingTalk CLI: run `dws` by its absolute path "<binDir>/dws"; the bare name may resolve to another installation or to none.
Scripts in the DingTalk skill call `dws` by name; prefix only the commands that run them with PATH="<binDir>:$PATH", and never export PATH or run `dws` by name yourself.
```

##### Runtime-context entry on Windows

```markdown
DingTalk CLI: run `dws` by its absolute path with the call operator, & '<binDir>\dws.exe'; the bare name may resolve to another installation or to none.
Scripts in the DingTalk skill call `dws` by name; start only the commands that run them with $env:PATH = '<binDir>;' + $env:PATH, and never run `dws` by name yourself.
```

#### Token effect

Two lines of about 270 characters plus the path and its directory in each runtime-context snapshot.

#### KV Cache effect

The system prompt does not change; finishing the installation, loading or unloading the row, or a changed path appends one runtime-context snapshot.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only macOS and Windows x64 are supported. The pinned Linux archives are unverified, and the release's Windows arm64 archive is not pinned.
- Commands must run on this Host. When a composition runs them elsewhere, such as over SSH, the plugin still loads, and each command that runs `dws` fails because the path does not exist there.
- The plugin uses the CLI's default configuration. Signing in or out from DSH affects the user's own terminal and other programs that run dws on this computer, and there is no DSH-private account. The page shows only the account dws reports as current and offers no picker among the saved accounts; `dws profile switch` in the terminal changes the current account.
- Sign-in from the plugin page needs a browser on the computer that runs DSH, because the CLI's authorization callback listens on `127.0.0.1`.
- The plugin sets no `DWS_CHANNEL`, and it is unverified with organizations that restrict CLI access to registered channels.
- Unless `binDir` and `skillsDir` are both set, the first check needs network access to GitHub or Gitee, and the `dingtalk` skill is absent until it succeeds; the Gitee mirror can lag a release by days. Download sources must send `Content-Length`.
- dws keeps its default telemetry and update checks; DSH guidance tells the agent not to upgrade it.
- In the file sandbox, every `dws` command that accesses DingTalk data fails when it opens the lock file under `~/.dws`, so each one needs a single-command approval to run. `dws auth status` without `--readonly` exits 0 there and reports a signed-in account as signed out, so a guide script that runs that check itself, such as the attendance check-in report, stops with a sign-in error.
- Removing the plugin leaves the downloaded assets and the skill root in the Harness cache. Each profile that loads the plugin downloads its own copy of dws and the skills. Without a profile, moving to a new release also leaves the earlier one there.
- Processes of one profile can run different versions of the plugin at the same time, such as one started before a plugin update and one started after it. The later one deletes the release the earlier one uses: in the earlier process, commands that run `dws` fail and the `dingtalk` skill is absent until its next check has downloaded the release again. Both releases then stay until a process of the profile loads the plugin again.
- The guides follow release `v1.0.64`; updating the release means changing the pinned sizes and digests, then checking the entry's index and DSH guidance against the new guides.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Specs and the `dingtalk-skills` session snapshot use a stand-in executable through `binDir` and stand-in skills through `skillsDir`; the download specs serve fixture archives from a local HTTP server. The skills spec pins the 16 upstream skill names, so a release update also updates that list.

</details>
