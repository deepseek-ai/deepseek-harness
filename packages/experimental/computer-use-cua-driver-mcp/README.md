---
description: "Configure experimental local computer use with an installed Cua Driver MCP executable and exclusive provider registration."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp

English | [中文](README.zh.md)

## Summary

Let the model operate the local desktop through an already installed Cua Driver. Mount this package with the computer-use service to expose the driver's own tool descriptions, arguments, and results through MCP. Installation and desktop permissions remain with Cua Driver, and no driver activates by default. The provider reserves computer use until its connection and tools finish closing; callers coordinate concurrent Sessions themselves.

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

Choose this provider when Cua Driver is already installed and configured on the same machine as DSH. The [upstream installation and permissions guide](https://github.com/trycua/cua/blob/cua-driver-rs-v0.28.0/libs/cua-driver/README.md) owns platform setup.

### Minimal configuration

Add these rows to a composition that already provides tools and system-prompt services. Screenshots also require an attachment store and a model route declaring image input.

```yaml
- name: '@deepseek-ai/dsh-computer-use'
- name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp'
  config:
    command: cua-driver
    args: [mcp]
```

| Field | Default | Meaning |
|---|---|---|
| `command` | `cua-driver` | Installed executable path or PATH command |
| `args` | `[mcp]` | Arguments passed directly without a shell |
| `toolCallTimeoutMs` | MCP client default | Per-call timeout override in milliseconds |
| `reconnect` | MCP client policy | Optional reconnection overrides |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-computer-use-cua-driver-mcp) lists accepted fields. The [MCP client](../../mcp/mcp-client/README.md) owns timeout and reconnection defaults.

### Activation and ownership

The provider registers as `cua-driver-mcp` before connecting. A second computer-use provider fails activation, including another instance of this package. Failed initialization or initial tool discovery rejects this entry and releases its registration after cleanup. Later disconnects retain the registration while the MCP client reconnects or exhausts its attempt budget; unload the entry to release it.

The model sees tools under the fixed `mcp__cua-driver-mcp__` namespace. Tool names, descriptions, input schemas, canonical results, and image admission follow the existing [MCP bridge](../../mcp/mcp-client/README.md). There is no additional DSH action catalog or provider-selection tool.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/index.ts`](src/index.ts) groups the computer-use reservation and owned MCP child into one ordered effect. Child teardown finishes before the reservation disposer runs, including during failed activation. The MCP client owns credential scrubbing, subprocess termination, tool synchronization, cancellation, and durable image projection.

No runtime invariant companion is published: the provider exposes no independent driver state to compare with its registration, and the child owns its connection and tool generations.

### Verify an installed driver

From the repository root, opt into the live compatibility test with the absolute path of a Cua Driver executable. It discovers tools, calls `check_permissions` with `prompt: false`, and verifies teardown. On macOS, `--direct` runs the runtime in the MCP process using the launching host's permissions; omit `DSH_COMPUTER_USE_MCP_ARGS` to use the default `["mcp"]` arguments.

```sh
DSH_COMPUTER_USE_MCP_EXECUTABLE=/absolute/path/to/cua-driver \
DSH_COMPUTER_USE_MCP_ARGS='["mcp","--direct"]' \
pnpm run test:e2e packages/experimental/computer-use-cua-driver-mcp/tests/installed-driver.e2e.ts
```

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Computer-use service](../../computer-use/computer-use/README.md) — exclusive named registration.
- [MCP client](../../mcp/mcp-client/README.md) — protocol discovery, execution, and image behavior.
- [Cua Driver](https://github.com/trycua/cua/blob/cua-driver-rs-v0.28.0/libs/cua-driver/README.md) — upstream executable and platform setup.

-----

<a id="model-experience"></a>
## Model Experience

### Cua Driver tools and screenshots

#### What the model sees

The installed driver's advertised tool descriptions and input schemas appear under `mcp__cua-driver-mcp__<tool>` names. Successful calls retain ordered text and admitted screenshots; unsupported image routes receive the MCP bridge's diagnostic text. Tool calls and projected results enter the Session log through the normal execution pipeline.

#### Token effect

Registered schemas enter model requests, and tool arguments, text results, and admitted images add context until compaction. Canonical inline image bytes stay outside Session events; durable attachment references identify model-visible images.

#### KV Cache effect

Unchanged tool discovery preserves the tool-definition prefix. Catalog changes can invalidate reuse from the first changed schema onward; appended tool results preserve the preceding request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

This provider relies on the installed driver and the MCP bridge's supported capabilities.

- Desktop access requires upstream installation and platform permissions; plugin activation alone does not prove that every desktop action is permitted.
- Sessions share one desktop. Run one computer-use workflow at a time or coordinate them externally; the registration does not serialize Session actions.
- Driver upgrades can change the discovered catalog. The provider has no runtime driver switching, dedicated desktop permission UI, or DSH action abstraction.
- Startup deadlines and rich-result restrictions follow the [MCP client's limitations](../../mcp/mcp-client/README.md#known-limitations-and-deferred-work).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
