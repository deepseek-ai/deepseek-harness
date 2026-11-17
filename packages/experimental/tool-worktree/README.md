---
description: "Model tools that enter a local Git worktree, creating it when it is new, and return to the source checkout."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-tool-worktree

English | [中文](README.zh.md)

## Summary

Let a model enter a Git worktree with one call, which creates the worktree when no worktree has the name, and return to the checkout it came from. Web and Desktop expose these tools through Change requests & worktrees; other profiles can select this standalone bundle. Native tool calls and PTC programs receive the same typed result, and the existing file policy governs creation.

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

In the GUI, enable [Change requests & worktrees](../forge-bundle/README.md). The standalone bundle has no Plugins page card. Profiles without the Web application may select it in `dsh.profile.bundles`; it loads the [worktree runtime](../worktree/README.md) and this tool together. Turning it off removes `enter_worktree` and `exit_worktree` without deleting existing checkouts or branches; a Session inside a worktree stays there until a Host operation moves it.

For an explicit composition, mount this function plugin after the worktree runtime and tool registry.

```yaml
- name: '@deepseek-ai/dsh-experimental-worktree'
- name: '@deepseek-ai/dsh-experimental-tool-worktree'
```

Call `enter_worktree({ name?: string, from?: string })`. The tool forwards only these two fields to the runtime, so it never fetches. When the worktree pool of the checkout the Session is in holds a registered worktree of that name, the call moves the Session into it, leaves branches and files as they are, and returns its `path`, its `branch` when one is checked out, the `repositoryRoot` the Session came from, and `created: false`. Otherwise it creates a new branch and checkout from `from`, HEAD by default, enters it, and returns `path`, `branch`, the pinned `baseCommit`, `repositoryRoot`, and `created: true`. Omitting `name` always creates one with a generated name. `from` asks for a new worktree, so it fails with `WORKTREE_ALREADY_EXISTS` when the name is taken. To leave, call `exit_worktree()`: it returns the Session to the checkout it created or entered the worktree from and reports that worktree's record; the checkout and branch remain. The [generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-tool-worktree) owns the exact schema and model-facing description.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts the `worktree` runtime row and the `tool-worktree` consumer row. [`src/index.ts`](src/index.ts) registers two typed tools. `enter_worktree` asks the runtime to enter the named worktree and, only when the runtime reports `WORKTREE_NOT_FOUND`, to create it. The runtime owns Git behavior, cancellation, and the working-directory change. Each tool returns the runtime record as its canonical value and renders that record as JSON; its Host presentation uses the generic card. Disposal unregisters the tools.

No runtime invariant companion is published because the tool retains no state independently of the worktree runtime.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Worktree runtime](../worktree/README.md) — configuration, creation semantics, and write permissions.
- [Working directory](../../session/working-directory/README.md) — Session context and exit operation.
- [Tool authoring](../../../docs/cookbook/adding-a-tool.md) — canonical results and pure presentation.

-----

<a id="model-experience"></a>
## Model Experience

### Worktree tools

#### What the model sees

The [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-tool-worktree) defines `enter_worktree` and `exit_worktree`. Each successful result contains the canonical path and branch of the worktree entered or left, and the top-level directory of the checkout the Session came from; a creation, and the exit of a created worktree, add the base commit. `created` tells the model whether `enter_worktree` made a new worktree. Failed calls report the operation error.

#### Token effect

The schema has a fixed per-request cost while mounted. Each call appends its arguments and bounded creation result or error to ordinary tool history.

#### KV Cache effect

Unchanged tool schemas retain their existing prefix. Calls append after prior history; the working-directory service separately records the successful directory change for later requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Calling Agent required** — the tool changes a Session directory and rejects calls without an Agent.
- **Creation and entry only** — listing, inspection, merging, and checkout or branch removal are outside these tools. `enter_worktree` reaches only worktrees in the pool of the checkout the Session is in: a worktree elsewhere, or a sibling while the Session is inside another worktree, is not reachable by name; the [runtime limitations](../worktree/README.md#known-limitations-and-deferred-work) also apply.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
