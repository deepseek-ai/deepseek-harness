---
description: "Read the Session’s current directory or enter an existing directory with the same tool. Relative changes use the current directory. The returned absolute path can be passed to other tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-working-directory

English | [中文](README.zh.md)

## Summary

Read the Session’s current directory or enter an existing directory with the same tool. Relative changes use the current directory. The returned absolute path can be passed to other tools.

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

Mount alongside `tools` and `workingDirectory`. Call `working_directory({})` to read or `working_directory({ cd: "src" })` to change directory. The tool has no configuration fields.

```yaml
- name: '@deepseek-ai/dsh-tool-working-directory'
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The tool delegates validation, recovery, persistence, and context notices to the directory owner. Its canonical result contains `cwd`; native rendering returns that path. The generic tool card displays the arguments and result without a separate GUI renderer.

No runtime invariant companion is published because the tool delegates all directory state and mutations to `workingDirectory`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Working directories](../../../docs/subsystems/working-directory.md) — shared runtime behavior.
- [Session group](../README.md) — durable Session services.
- [Testing](../../../docs/testing.md) — composition and replay verification.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema and result

#### What the model sees

The [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-working-directory) defines the optional `cd` argument and canonical `cwd` result. Directory notices are owned by `dsh-working-directory`.

#### Token effect

The registered schema and returned path contribute tokens when the tool is available and invoked.

#### KV Cache effect

Changing tool availability changes its schema context. A tool call appends ordinary call and result history without replacing prior messages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Calling Session required** — the tool requires an Agent and changes neither existing processes nor write permissions.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
