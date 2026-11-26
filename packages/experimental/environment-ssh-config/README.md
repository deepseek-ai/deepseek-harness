---
description: "Discover concrete OpenSSH aliases and contribute lazy SSH execution environments."
kind: "package-reference"
---

# @deepseek-ai/dsh-environment-ssh-config

English | [中文](README.zh.md)

## Summary

Make concrete aliases from a local OpenSSH configuration available as execution environments. This provider contributes each selected alias through the single-destination SSH provider, sharing its trust and execution behavior. Discovery reads configuration files without evaluating `Match exec` or contacting destinations, and runs again when those files change. SSH connections start when a caller selects a handle for execution. This package is experimental and requires explicit composition.

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

Mount the registry and discovery provider. Each selected destination needs an SSH server, a POSIX shell and Node `^24.22.3 || >=26.13.1`. The single-SSH provider installs missing or older daemons in each remote user's `~/.cache/dsh/environment/daemon.js` by default. Set `ssh.daemonPath` to override this with a common absolute path; the single-SSH provider owns verification and replacement rules.

```yaml
- name: '@deepseek-ai/dsh-environment'
- name: '@deepseek-ai/dsh-environment-ssh-config'
  config:
    file: ~/.ssh/config
    handlePrefix: ssh-
    hosts: [build, test]
    debounceMs: 100
```

| Field | Default | Meaning |
|---|---|---|
| `file` | `~/.ssh/config` | Configuration also passed to OpenSSH with `-F` |
| `handlePrefix` | `ssh-` | Stable prefix before each selected alias |
| `hosts` | `[]` | Concrete alias allowlist; empty selects all discovered aliases |
| `debounceMs` | `100` | Milliseconds without further changes to the watched files and directories before discovery runs again |
| `ssh` | `{}` | Common single-SSH provider settings; optional `daemonPath` overrides each remote user's cache path |

An alias `build` contributes `{ handle: 'ssh-build', displayName: 'build' }` with the default prefix. Discovery skips handles already registered by any provider. Register explicit SSH environments before loading discovery; later registrations with the same handle still fail. `host`, `handle`, `displayName` and `configFile` inside `ssh` are rejected because discovery owns those values. Other settings use the [single SSH provider](../environment-ssh/README.md#use-this-package) defaults and validation. The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-environment-ssh-config) owns the exhaustive field reference.

Aliases must be concrete `Host` names; wildcard patterns and negated names do not create environments. Discovery follows top-level `Include` directives and those under exactly `Host *`. Other conditional Host or Match Includes are excluded, avoiding aliases whose containing condition would not apply when selected. Relative Include paths resolve from the user's `.ssh` directory, as OpenSSH does. Include matches are read in sorted order, duplicate aliases are combined and Include cycles fail. An absent `~/.ssh/config` contributes no aliases, as OpenSSH reads no user configuration then; other missing source files, undeclared requested aliases and invalid SSH settings fail loading.

### Configuration changes

While loaded, the provider watches the directories of the configured file and of every file read through its supported Includes, both through the paths that reached them and through their real paths. It also watches the directories where a missing file or a new Include match can appear, such as the nearest existing directory of an absent `~/.ssh/config`. Discovery runs again once `debounceMs` passes without further changes. Each new selected alias gains an SSH child provider, the child provider of each removed alias is disposed and its connection closed, and unchanged aliases keep their child providers and open connections. Edits inside a remaining alias's Host block apply to its next connection.

An allowlisted alias that is no longer declared is removed with a logged warning and returns once it is declared again; at load, an undeclared allowlisted alias fails loading. Removal prevents OpenSSH from resolving the undeclared name as a host name. A change that leaves the configuration unreadable, such as a parse error, an Include cycle or a deleted file other than `~/.ssh/config`, keeps the previous aliases and logs a warning; the provider stays loaded and applies the next readable configuration. A new alias that the SSH provider rejects, such as one beginning with `-`, is logged and skipped. Discovery skips handles registered by other providers at every rediscovery. If another provider unregisters such a handle, discovery takes it over at the next configuration change or provider reload.

Removing discovery stops watching, removes its SSH child providers and closes their connections; environments registered by other providers remain.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`ssh-config` parses the local files. The discovery walk reads concrete aliases and supported Includes without computing Match expressions, and collects the directories to watch, including those reached before a failure. For each selected alias whose handle the registry does not list, the provider creates and awaits a single-SSH child plugin with resolved common configuration. Each child transport starts a fresh stdio daemon when opening a connection; the registry reuses live connections. Child fibers, their registrations and the watchers belong to the discovery provider's lifecycle. Execution uses the registry's common protocol.

Non-recursive `fs.watch` watchers are keyed by directory path and file identity, so a retargeted symbolic link or a directory recreated with a new identity is watched again. A watcher that reports an event naming its own directory or no entry, as Linux does when the watched directory is removed and its watch ends, or that fails is replaced at the next rediscovery even when the identity is unchanged. Any event restarts the `debounceMs` timer, and rediscoveries run one at a time; a rediscovery that fails unexpectedly is logged, and the next event starts another. The timer also starts when watching starts and when a rediscovery changes the watched directories, so a change that a new watcher has not reported is still read. Disposal waits for a running rediscovery and then closes the watchers, also when that rediscovery failed.

| File | Owns |
|---|---|
| [`src/discover.ts`](src/discover.ts) | File discovery, concrete aliases, Include traversal and directories to watch |
| [`src/watch.ts`](src/watch.ts) | Directory watchers that follow a changing directory set |
| [`src/index.ts`](src/index.ts) | Provider configuration, SSH child composition and rediscovery |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Environment registry](../environment/README.md) — metadata and explicit handle selection.
- [Single SSH provider](../environment-ssh/README.md) — trust decisions and connection behavior.
- [Environment subsystem](../../../docs/subsystems/environment.md) — public service reference.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through tools selecting its contributed environments; those tools own schemas, rendered results and logging. This provider adds no prompt section, model tool or Session event.

#### KV Cache effect

None; this package neither assembles nor sends model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Watching relies on Node `fs.watch`. File systems that do not report changes, such as some network mounts, need a provider reload after a configuration change. On macOS a new watcher reports changes only once it has started; a change made before then is read by the rediscovery `debounceMs` later, unless starting takes longer. A directory that cannot be watched, for example after the system watcher limit is reached, is logged; discovery tries to watch it again at the next rediscovery, which only a change in another watched directory or a provider reload starts.
- Watching follows a symbolic link to its final target's directory. Retargeting an intermediate link in a chain of links takes effect at the next change in a watched directory.
- Conditional Includes other than exactly `Host *` are not enumerated. Explicit single-SSH providers can still target those aliases.
- All selected aliases share the configured SSH settings, including any explicit `daemonPath`. Without an override, each destination resolves its own remote user's cache path. Use explicit providers for destinations requiring different settings.
- The provider does not install remote Node or discover destinations from `known_hosts`. Daemon bootstrap, compatibility checks and failures follow the single-SSH provider.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Parser tests use isolated SSH directories and config files. Loader tests verify lazy contribution and removal without connecting to user destinations. Watching tests use temporary home directories and files and wait for registry change events or logged warnings; debounce and disposal tests use fake timers. One test keeps a real connection through the single-SSH provider's fake OpenSSH fixture.

</details>
