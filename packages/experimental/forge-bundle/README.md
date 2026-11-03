---
description: "Enable the change request panel and worktree Sessions from the Plugins page."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-forge-bundle

English | [中文](README.zh.md)

## Summary

Review each Session's change requests, checks, and diffs, start a new Session in a Git worktree, or ask the model to create one during a conversation. Enable Change requests & worktrees on the Web or Desktop Plugins page; shipped profiles leave it disabled. GitHub status comes from the Host's signed-in `gh` CLI; local worktree creation does not require GitHub authentication.

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

Open Plugins and enable Change requests & worktrees in the Official group. In a Git workspace, check Worktree in the composer before the first message to start the Session in a new worktree. In a Session whose directory is inside a Git checkout, the header button opens the panel. GitHub pull requests that the Session creates with `gh pr create`, opens with `gh pr view`, `gh pr edit`, or `gh pr checkout`, or works on as its branch or updates with a later `git push`, appear as change requests without further steps. Run `gh auth login --hostname <host>` in a terminal to sign in; the panel shows the command when sign-in is missing. The [panel package](../client-ui-forge/README.md#use-this-package) describes each control.

The same switch enables the model's [`create_worktree`](../tool-worktree/README.md) tool. Turning it off removes both the panel and the tool while retaining existing checkouts and branches. For profiles that already selected the standalone worktree bundle, follow the [upgrade guide](../../../docs/upgrade-guide/v0.2.2-alpha.2/forge-worktree-entry/guide.md) before enabling this bundle.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The bundle mounts the forge registry, GitHub provider, Session bindings, and the worktree model tool. The tool uses the top-level `worktree` service; the panel keeps its isolated `forge-worktree` service inside `optional-forge-panel`. Their configuration ids and creation flows stay independent. The panel records worktrees requested before a Session starts; model-created worktrees do not acquire the panel's recovery records. The rows use the Session projection, working-directory, filesystem, subprocess, and sandbox services from base-backed profiles.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Forge subsystem](../../../docs/subsystems/forge.md) · [Session bindings](../forge-session/README.md) · [Panel](../client-ui-forge/README.md)

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the [`create_worktree`](../tool-worktree/README.md#model-experience) tool and the [panel’s directory notice](../client-ui-forge/README.md#model-experience) for Sessions that start in a worktree.

#### KV Cache effect

Enabling or disabling the bundle changes the model's tool schema list. Calls append tool results and directory context; see the [tool's cache behavior](../tool-worktree/README.md#model-experience).

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- GitHub is the only code host provider, and the bundle serves github.com only; a GitHub Enterprise host needs a profile patch that lists it in the `forge-github` row's [`hosts`](../forge-github/README.md#use-this-package). No provider recognizes GitLab or other hosts.
- The model has no tool for bound change requests yet.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
