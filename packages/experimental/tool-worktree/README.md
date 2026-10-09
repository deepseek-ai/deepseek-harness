---
description: "Model tool that creates a new local Git worktree and changes the current Session directory."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-tool-worktree

English | [中文](README.zh.md)

## Summary

Add Git Worktrees from the GUI plugin manager to let a model create and enter a new Git worktree with one call. This optional bundle is installed with Harness and stays off until selected. Native tool calls and PTC programs receive the same typed result, and the existing file policy governs creation.

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

In the GUI, open **Plugins → Official → Git Worktrees** and turn on the switch. The bundle loads the [worktree runtime](../worktree/README.md) and this tool together; it is off in every shipped profile. Turning it off removes `create_worktree` without deleting existing checkouts or branches. The built-in `working_directory` tool remains available.

For an explicit composition, mount this function plugin after the worktree runtime and tool registry.

```yaml
- name: '@deepseek-ai/dsh-experimental-worktree'
- name: '@deepseek-ai/dsh-experimental-tool-worktree'
```

Call `create_worktree({ name?: string, from?: string })`. Success returns the canonical checkout `path`, new `branch`, pinned `baseCommit`, and source `repositoryRoot`, and changes the calling Session's current working directory. To leave, call `working_directory({ cd: path })`; the checkout and branch remain. The [generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-tool-worktree) owns the exact schema and model-facing description.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts the `worktree` runtime row and the `tool-worktree` consumer row. [`src/index.ts`](src/index.ts) registers one typed tool. Runtime creation owns Git behavior, cancellation, and the working-directory change. The tool returns the runtime record as its canonical value and renders that record as JSON; its Host presentation uses the generic card. Disposal unregisters the tool.

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

### Creation tool

#### What the model sees

The [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-tool-worktree) defines `create_worktree`. Each successful result contains the created checkout's canonical path, branch, base commit, and source checkout’s top-level directory. Failed calls report the operation error.

#### Token effect

The schema has a fixed per-request cost while mounted. Each call appends its arguments and bounded creation result or error to ordinary tool history.

#### KV Cache effect

Unchanged tool schemas retain their existing prefix. Calls append after prior history; the working-directory service separately records the successful directory change for later requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Calling Agent required** — the tool changes a Session directory and rejects calls without an Agent.
- **Creation only** — inspection, merging, and checkout or branch removal are outside this tool; the [runtime limitations](../worktree/README.md#known-limitations-and-deferred-work) also apply.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
