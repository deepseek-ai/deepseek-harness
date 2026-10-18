---
description: "Install the pinned official dws and its skills into the DSH cache, put dws on the private Shell PATH, load its skill, and run the account operations the Plugins page drives."
kind: "package-reference"
---

# @deepseek-ai/dsh-dingtalk-cli

English | [中文](README.zh.md)

## Summary

This package is the Host row of the [DingTalk plugin](../dingtalk/README.md). It downloads the official DingTalk Workspace CLI, `dws`, and the official DingTalk skills from one pinned release into the DSH cache, puts `dws` on the private Shell PATH, and registers one `dingtalk` skill whose guides are those skills. Its `dingtalk` Remote checks the CLI's sign-in, signs in through the CLI's browser authorization page, signs out the current account, and cancels, for the [DingTalk plugin page](../../client/ui-dingtalk/README.md). The CLI keeps the sign-in in `~/.dws` and the system keychain, which the user's own terminal shares. Only macOS is supported.

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

### Add it to a profile

Install the [DingTalk plugin bundle](../dingtalk/README.md), which inserts this package as the `dingtalk` row. The package has no install script. When the row loads, it downloads two assets of dws release 1.0.64: the archive for the computer's platform, 16 to 18 MB, and `dws-skills.zip`, 3.3 MB. Each comes from GitHub Releases, or from the official Gitee mirror when GitHub fails; the row verifies its size and SHA-256 and keeps it in `$DSH_HOME/cache/dingtalk/`. `dws` is missing from the Shell PATH, and the `dingtalk` skill from the catalog, until those downloads finish. On a platform the release has no archive for, the row fails to load and names the platform; set `binDir` to use another `dws`. With both `binDir` and `skillsDir` set, the row downloads nothing.

Signing in needs a DingTalk account that belongs to an organization whose administrator has turned on CLI access in the DingTalk developer console. Until then, the user can request access on the authorization page.

### What you get

After the downloads finish, one `dingtalk` skill joins the skill catalog. The agent loads it with the `skill` tool, opens the guide for the product at hand, such as `dingtalk-calendar` or `dingtalk-doc`, with the file tools, and runs `dws` commands through the ordinary Shell tools under the current sandbox and approval policy. When a command reports a missing or expired sign-in, the agent asks the user to connect DingTalk on the plugin page; it runs `dws auth login --no-browser` only when the user asks to finish it in the conversation, and requests `sandbox_permissions` with a `justification` on the first attempt because the command writes outside the workspace.

Turning the row off in Plugin Manager withdraws the skill and the private PATH entry for later Shell calls. The CLI sign-in and the downloaded assets stay in place.

<a id="account-operations"></a>
### Account operations

The `dingtalk` Remote serves the Plugins page. It runs at most one operation at a time, owned by the Host, so leaving the page does not cancel it. Loading the row starts one check, which also downloads dws and its skills while either is missing.

| Method | Effect |
|---|---|
| `follow(signal)` | Streams the account, the operation in progress, and the last result; each new follower starts a check when no operation runs |
| `check()` | Downloads dws and its skills while either is missing, then checks the account again; returns the operation id |
| `signIn()` | Runs `auth login --no-browser --format json`, waits for the user to authorize in a browser on this computer, then checks that dws reports the account signed in |
| `signOut()` | Runs `auth logout --profile <corpId>:<userId>` for the account the last check found, which also signs it out of the user's own terminal, then checks again |
| `cancel(id)` | Cancels a sign-in while it waits for authorization and waits for its command to exit; other steps and a finished id are ignored |

A check runs `auth status --format json`, which refreshes an expired access token with the server and exits with code 0 whether or not a user is signed in. The account reads `connected`, with the user and organization names dws reports, when `authenticated` is true; `unverified` when it is false with one of the reasons dws reports as inconclusive (`local_state_requires_repair`, `local_state_unreadable`, `ciphertext_key_mismatch`, `dek_missing`, `keychain_unavailable`); and `signed-out` otherwise. A nonzero exit or output that is not the status JSON fails the check and keeps the previous account; a download that does not finish leaves `not-installed`. Sign-out requires both ids, so it never selects every account of an organization; accounts of other organizations stay signed in, and the next check shows the account dws then reports as current. The link that `auth login` prints alone on an indented stderr line is offered only when it is an HTTPS address on `login.dingtalk.com`. Results report succeeded, cancelled, or failed. Failures include the command and the observed exit code in the Remote result and Host log; the CLI's output is omitted. The process running DSH needs access to `~/.dws` and the CLI's macOS keychain item; `DSH_HOME` does not relocate them.

### Configure

| Field | Default | Meaning |
|---|---|---|
| `binDir` | the cache directory holding the downloaded executable | Absolute directory containing an executable `dws`; when set, the executable is not downloaded |
| `skillsDir` | the cache directory holding the downloaded skills | Directory laid out as the `multi/` directory of the release's `dws-skills.zip`; when set, the skills are not downloaded |
| `releaseUrls` | the GitHub Releases and Gitee mirror download prefixes of `DingTalk-Real-AI/dingtalk-workspace-cli` | HTTPS prefixes tried in order for what `binDir` and `skillsDir` do not provide; each serves `v<version>/<asset name>` with a `Content-Length` equal to the asset size |
| `commandTimeoutMs` | `30000` | Deadline for one account check or sign-out, including executable lookup |

Sign-in waits up to 10 minutes for the user, and each command keeps at most 1 MiB of stdout; the [CLI account library](../cli-account/README.md) fixes both limits. dws itself stops waiting for authorization after 6 minutes.

The generated [config catalog](../../../docs/config-catalog.md#deepseek-aidsh-dingtalk-cli) is the exhaustive source of supported fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/index.ts`](src/index.ts) is a Remote service registered as `ctx.dingtalk`. It requires a Host subprocess runtime, registers the `dws` directory with [Shell environment](../../shell/shell-env/README.md) as the `dingtalk` PATH contribution, mounts a [filesystem skill provider](../../skill/skill-filesystem/README.md) named `dingtalk` over the skill root that `src/release.ts` publishes, and starts one check so that a session without a browser also finds `dws` and the skill. The provider omits the default roots and watches the skill root, because the first download publishes it after the catalog may already have been listed. The npm package `dingtalk-workspace-cli` is not used: its install script copies the official skills into `~/.agents/skills`, which the default skill provider scans, and into other agents' skill directories, so they would outlive the plugin. dws embeds the same skills, but `dws skill setup` writes only into such agent directories.

[`src/release.ts`](src/release.ts) pins the release version, the archive for each platform, and `dws-skills.zip`, each with the name, size, and SHA-256 from the release's `checksums.txt`. It downloads whichever asset is missing, refuses a response whose `Content-Length` differs before reading the body, and verifies the digest. It extracts the platform archive with `tar`, and the `multi/` entries and root `LICENSE` and `NOTICE` of the skills archive with `fflate`, into a sibling staging directory, refusing a skills entry whose path has an empty, `.`, or `..` segment or a backslash; it publishes each result by rename, and a directory another process published first is kept. Each failed source logs a warning. The skill root `$DSH_HOME/cache/dingtalk/skill-<digest>/` holds a copy of the packaged entry at `dingtalk/SKILL.md` and a `dingtalk/guides` symbolic link to the skills directory. The digest covers the entry and the link target, so a published root never changes, and the root is published synchronously at load when the skills directory already exists.

The [CLI account library](../cli-account/README.md) runs each command on the private PATH, so the backend and the Shell use the same executable, and runs one operation at a time. [`src/account.ts`](src/account.ts) extends that runtime with the dws commands, prepares the release before a check's first command, reads the authorization link from the stderr lines of `auth login`, and parses the `auth status` JSON. It keeps the signed-in account's ids on the Host for sign-out; the Remote view carries only names. Disposal cancels the active operation, aborts running commands and downloads, and settles after their processes exit.

[`skills/dingtalk/SKILL.md`](skills/dingtalk/SKILL.md) is the only skill: the DSH guidance, an index of the 16 guides, and how to open them. The guides are the `multi/` tree of `dws-skills.zip` in release `v1.0.64`, which the upstream installer uses by default; its `mono/` alternative is one entry that repeats the same content. The filesystem provider discovers only `<root>/<name>/SKILL.md`, so the guides are not separate skills. Guides refer to one another by relative paths such as `../dingtalk-shared/SKILL.md`, which resolve because the guides keep their sibling layout, and run their helper scripts from their own `scripts/` directories. Where the DSH guidance and a guide disagree, the entry tells the agent to follow the DSH guidance: it uses the plugin's `dws` instead of installing or upgrading one, does not run `dws skill setup`, and sends sign-in to the plugin page.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Connector packages](../README.md) — the group this application plugin belongs to.
- [CLI account library](../cli-account/README.md) — command execution and account operations shared by CLI app plugins.
- [Shell environment](../../shell/shell-env/README.md) — private PATH contributions shared by backend subprocesses and Shell tools.
- [Skills](../../../docs/subsystems/skills.md) — catalog publication, loading, and precedence.
- [DingTalk plugin](../dingtalk/README.md) — the bundle that inserts this row and the page row.
- [DingTalk plugin page](../../client/ui-dingtalk/README.md) — the Plugins page that drives the account operations.

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

A `skill` tool result for `dingtalk` contains about 2,100 characters: the DSH guidance, a one-sentence index entry for each of the 16 guides, and how to open them. The DSH guidance tells the agent to run the plugin's `dws` by name without installing or upgrading another, not to run `dws skill setup`, to ask the user to connect on the plugin page before running `dws auth login --no-browser` itself, to request `sandbox_permissions` for that command from its first attempt, and to tell the user that an organization administrator must turn on CLI access when dws reports it off; it takes precedence over the guides where they disagree. Its resource base is the `dingtalk` directory of the skill root in the DSH cache, so the agent opens `guides/<name>/SKILL.md` with the file tools rather than the `skill` tool and resolves each guide's relative paths and scripts against that guide's own directory.

#### Token effect

Each load adds the entry body to the retained tool history. A guide's `SKILL.md`, 4,000 to 21,000 characters, and the references it points to arrive as ordinary file-read output.

#### KV Cache effect

Loading appends a tool result and does not rewrite earlier context.

### Plugin CLIs entry

#### What the model sees

The row declares `dws` with its private PATH entry, so the [Shell environment](../../shell/shell-env/README.md#model-experience) Plugin CLIs section of the system prompt lists `` `dws` (dingtalk) `` while the row is loaded and the shell runs on this Host.

#### Token effect

The entry adds a few tokens to that section; the section's own text belongs to Shell environment.

#### KV Cache effect

Loading or unloading the row changes the section text, and provider cache reuse may end at the first changed token.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only macOS is supported. The pinned Linux archives are unverified, and Windows has no pinned archive.
- The plugin requires a subprocess runtime on this Host and fails to load when the composition's subprocess runtime runs elsewhere, such as over SSH.
- The plugin uses the CLI's default configuration. Signing in or out from DSH affects the user's own terminal and other programs that run dws on this computer, and there is no DSH-private account or account picker.
- Sign-in from the plugin page needs a browser on the computer that runs DSH, because the CLI's authorization callback listens on `127.0.0.1`.
- The plugin sets no `DWS_CHANNEL`, and it is unverified with organizations that restrict CLI access to registered channels.
- Unless `binDir` and `skillsDir` are both set, the first check needs network access to GitHub or Gitee, and the `dingtalk` skill is absent until it succeeds; the Gitee mirror can lag a release by days. Download sources must send `Content-Length`.
- dws keeps its default telemetry and update checks; DSH guidance tells the agent not to upgrade it.
- In the file sandbox, an ordinary command that refreshes a token or writes `~/.dws` can be denied and then needs a single-command approval.
- Removing the plugin or moving to a new release leaves the downloaded assets and skill roots in the Harness cache.
- The guides follow release `v1.0.64`; updating the release means changing the pinned sizes and digests, then checking the entry's index and DSH guidance against the new guides.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Specs and the `dingtalk-skills` session snapshot use a stand-in executable through `binDir` and stand-in skills through `skillsDir`; the download specs serve fixture archives from a local HTTP server. The skills spec pins the 16 upstream skill names, so a release update also updates that list.

</details>
