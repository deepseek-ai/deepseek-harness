---
description: "Enable the change request panel and worktree Sessions from the Plugins page."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-forge-bundle

English | [中文](README.zh.md)

## Summary

Show the change requests of each Session with their checks and reviews, and let a new Session start in its own Git worktree. Enable Change requests & worktrees on the Web or Desktop Plugins page; shipped profiles leave it disabled. GitHub status comes from the `gh` CLI signed in on the Host; without it, the panel still shows the branch and the worktree option still works.

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

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The bundle patch inserts the forge registry, the GitHub provider, and the Session bindings as Host rows, and a group that isolates the `worktrees` service, holding a worktree service row and the panel's two-face package, whose Client half the Web and Desktop clients load while the row is enabled. The isolation lets the bundle coexist with the Git Worktrees bundle, whose model tool keeps its own service. The rows need the Session projection registry, working-directory, filesystem, subprocess, and sandbox services that every base-backed profile composes.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Forge subsystem](../../../docs/subsystems/forge.md) · [Session bindings](../forge-session/README.md) · [Panel](../client-ui-forge/README.md)

-----

<a id="model-experience"></a>
## Model Experience

None, as the composed packages add no model tool or prompt; the directory notice of a Session that starts in a worktree reaches the model through the working-directory service, as described by the [panel](../client-ui-forge/README.md#model-experience).

#### KV Cache effect

None from the bundle; see the [panel](../client-ui-forge/README.md#model-experience) for the worktree notice.

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
