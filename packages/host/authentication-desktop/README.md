---
kind: package-reference
description: "Authenticate Desktop requests with a private, in-memory credential without exposing it to the renderer."
---

# @deepseek-ai/dsh-host-authentication-desktop

English | [中文](README.zh.md)

## Summary

Desktop can access its Host with a private credential without a browser-token exchange. The credential flows only between the Electron main process and its owned Host, never into the browser cookie jar; the renderer receives ordinary startup data only. All authenticated Desktop requests share owner access for that Desktop lifetime.

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

The Desktop startup owner mounts the plugin through Cordis after receiving its private parent credential. It injects `connection` for Peer creation and `connection.authentication` for Provider registration; the Connection plugin provides both. Configuration is supplied in memory rather than written to a profile or settings file.

| Field | Default | Meaning |
|---|---|---|
| `readSecret` | required | Function returning the credential already validated on the private parent IPC channel |

The provider accepts one `dsh-desktop-session` Cookie value matching its credential. Duplicate values, malformed credentials and mismatches are rejected. Successful HTTP and WebSocket admission reuse its existing Peer. Disposing this plugin removes its provider registration and ends that Peer through the normal Connection lifecycle.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Desktop parent process generates and privately delivers the credential. The Host application's IPC receiver validates the handshake; its startup entry authenticates through ConnectionAuthentication before publishing the page injections. Both ends use the fixed Cookie name `dsh-desktop-session` and the value `<name>=<secret>`. The Cordis plugin owns credential verification and Peer creation. Desktop owns Host address validation and request forwarding, including origin checks and credential attachment. It supplies the process channel, mounts the plugin, and publishes its single ready response. ConnectionAuthentication owns the Provider registry and verification; Connection owns Peer creation and transport.

The [plugin entry](src/index.ts) exports the ordinary `name`, `inject`, and `apply` members; `Config` is a TypeScript interface. Token and Desktop register through the same ConnectionAuthentication service, with neither provider depending on the other.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Desktop application](../../../apps/desktop/README.md) — parent process and Host startup.
- [Connection](../../client/connection/README.md) — ConnectionAuthentication registration and Peer lifecycle.
- [Token authentication](../authentication-token/README.md) — browser launch-token authentication.

<a id="model-experience"></a>
## Model Experience

None, as authentication introduces no model-visible input.

#### KV Cache effect

None; authentication does not modify model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The plugin is a Desktop startup component. Its input requires a private credential validated by the process owner, and its shared Peer grants owner access for that Desktop lifetime.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
