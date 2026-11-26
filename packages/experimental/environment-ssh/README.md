---
description: "Contribute one execution environment reached through OpenSSH with strict host-key checking."
kind: "package-reference"
---

# @deepseek-ai/dsh-environment-ssh

English | [中文](README.zh.md)

## Summary

Run environment functions on a machine reachable through OpenSSH. This provider contributes one stable handle and display name to the environment registry, using your SSH configuration for users, keys, proxies and jump hosts. It installs missing or older execution daemons; each new connection starts a fresh process, while a live connection reuses that process. Unknown host keys require a pinned fingerprint or human confirmation; changed keys fail. The package is experimental and is composed explicitly.

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

Install `ssh` and `ssh-keygen` locally. The destination needs an SSH server, a POSIX shell and Node `^24.22.3 || >=26.13.1`. Mount this provider beside the registry. Connections and daemon bootstrap start on first execution. By default, remote Node resolves `os.homedir()` and stores the daemon at `~/.cache/dsh/environment/daemon.js` for the SSH user. Set `daemonPath` to an absolute remote path to override this location.

```yaml
- name: '@deepseek-ai/dsh-environment'
- name: '@deepseek-ai/dsh-environment-ssh'
  config:
    handle: ssh-build
    displayName: Build machine
    host: build-box
```

| Field | Default | Meaning |
|---|---|---|
| `handle` | `ssh-` followed by `host` | Opaque stable registry identifier |
| `displayName` | `host` | User-facing label; it may repeat |
| `host` | required | OpenSSH destination or alias |
| `daemonPath` | Remote `~/.cache/dsh/environment/daemon.js` | Optional absolute destination path; missing or older daemons are installed automatically |
| `node` | `node` | Node executable on the destination |
| `configFile` | OpenSSH search | Configuration passed with `-F` to every SSH operation |
| `hostKeys` | `[]` | Verified `SHA256:` fingerprints accepted for unknown hosts |
| `knownHostsFile` | `$DSH_HOME/state/environment-ssh/known_hosts` | File receiving explicitly trusted keys |
| `ssh`, `sshKeygen` | `ssh`, `ssh-keygen` | Executable argv prefixes without options |
| `killGraceMs` | 2000 | Grace before forcibly terminating SSH processes |
| `maxOutputBytes` | 64 KiB | Retained helper output and SSH stderr |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-environment-ssh) owns the exhaustive field reference. Set a distinct handle when separate registrations would otherwise collide. Display names never select an environment.

### Host keys

Each open reads effective destination settings with `ssh -G`. Existing keys in the configured known-hosts files are checked with `StrictHostKeyChecking=yes`. A changed key is never re-trusted automatically.

For an unknown host, OpenSSH fetches the offered key through the user's configured proxy or jump host, records it in a temporary file under `accept-new`, and stops before authenticating. The provider accepts it only when its fingerprint is pinned in `hostKeys`, or the run's `confirm` callback obtains agreement after the person verifies the fingerprints on the destination. The question carries the host name, the port and each key's type and fingerprint for a client to render, and `detail`, the same facts as English text. Accepted keys are appended to `knownHostsFile`; the user's own known-hosts files are unchanged. Otherwise `SshHostKeyUntrustedError` reports `ENVIRONMENT_SSH_HOST_KEY_UNTRUSTED` and the fingerprints to verify.

### Daemon bootstrap

After host trust is established, the provider checks that the configured `node` executable exists, meets the supported version range and provides the required Node built-in modules. It resolves the standalone bundle through the installed `@deepseek-ai/dsh-environment/daemon.js` export. An existing regular daemon file is reused without rewriting only when its first-line metadata has the exact environment package version and protocol version, and its full SHA-256 digest matches the local bundle.

If the daemon is absent or its recognized semantic version is lower than the local bundle's version, the provider sends the bundle over SSH stdin to remote Node. Node validates the upload digest in a private random temporary file and acquires a directory lock before publication. It rechecks the destination, creates an absent target with an exclusive hard link, or atomically replaces the previously inspected older file. A changed destination must match the requested bundle or installation fails. A busy lock reports an error and requires retry after the other installer finishes. Bootstrap requires no `scp`, SFTP, `cat` or `mv`.

If the remote installer is killed, a private random `<daemonPath>.upload-*` file or `<daemonPath>.install-lock` directory may remain. The installer never publishes a partially written daemon at the final path. Inspect leftovers and remove them manually only when no installer is using them.

A newer or unrecognized daemon, or an equal-version daemon with a different protocol or digest, fails unchanged with `ENVIRONMENT_SSH_DAEMON_INCOMPATIBLE`. Inspect the file, then remove or replace it manually, or configure an absent destination path. Automatic replacement applies only to a recognized lower semantic version; the provider never downgrades a newer daemon. `SshEnvironmentError` also reports `ENVIRONMENT_SSH_NODE_NOT_FOUND`, `ENVIRONMENT_SSH_NODE_UNSUPPORTED`, `ENVIRONMENT_SSH_DEPENDENCY_MISSING` or `ENVIRONMENT_SSH_BOOTSTRAP_FAILED`, with the missing prerequisite or corrective action.

### Independent environments

Each new channel starts its own remote daemon process, including channels to the same destination. The registry reuses a live channel for the same registration. Handles identify registry entries and do not select remote resident instances. Removing the provider removes its registry contribution and closes its channel.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The provider contributes metadata and a transport; it implements no function-execution protocol. After trust checks and daemon bootstrap, SSH launches the bundled daemon in module mode with `serve --stdio` on the destination. The registry authenticates that channel before running functions over its common peer. The transport owns the SSH process and closes it when the registry releases the channel. Standard input and output carry frames; exit status and retained stderr explain connection termination. SSH config discovery composes this same plugin for each selected alias.

| File | Owns |
|---|---|
| [`src/index.ts`](src/index.ts) | Configuration, registry contribution, trust decisions and SSH connection |
| [`src/bootstrap.ts`](src/bootstrap.ts) | Remote prerequisites, daemon compatibility and atomic installation |
| [`src/openssh.ts`](src/openssh.ts) | Effective settings, key lookup, fingerprints and POSIX command quoting |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Environment registry](../environment/README.md) — execution and lifecycle semantics.
- [SSH configuration provider](../environment-ssh-config/README.md) — multiple aliases using this provider.
- [Local provider](../environment-local/README.md) — managed local execution.
- [SSH provider family](../../ssh/README.md) — Session-wide filesystem and subprocess services.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through environment runs made by tools; those tools own schemas and rendered results. This provider adds no prompt section, model tool or Session event.

#### KV Cache effect

None; this package neither assembles nor sends model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The provider does not install remote Node. The SSH user needs permission to create the daemon directory and install or replace its file. Newer, unrecognized or equal-version incompatible files require manual review; they are never replaced automatically.
- Each open starts an SSH process and a fresh remote daemon. OpenSSH `ControlMaster` settings govern underlying connection sharing. Closing SSH ends remote functions only once the remote daemon observes its closed input; this provider supplies no remote process supervisor.
- Remote login output on stdout corrupts the protocol channel.
- Trust records are managed through `knownHostsFile`; there is no dedicated trust-settings page.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Composition tests replace OpenSSH tools with `tests/fixtures/fake-openssh.ts` while running the real stdio execution daemon. They verify trust decisions, configuration and connection reuse without contacting user hosts.

</details>
