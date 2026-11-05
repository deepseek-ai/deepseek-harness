---
description: "Run MCP OAuth flows against a loopback authorization server and mount the MCP manager through a real profile in repository tests."
kind: "package-library"
---

# @deepseek-ai/dsh-mcp-testkit

English | [中文](README.zh.md)

## Summary

Use this package in tests that need a real MCP OAuth exchange or a profile-composed MCP manager. It serves a loopback OAuth authorization server and MCP endpoint, and mounts the MCP client host and the manager through a real profile, ConfigEditor, and Loader. Tests import it as a development dependency; each fixture registers its own teardown with the running test.

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

Add `@deepseek-ai/dsh-mcp-testkit` to the consuming package's `devDependencies`. Start an OAuth world, mount the manager on its context, and drive authorization through the manager:

```ts
import { callback, managerProfile, oauthWorld, phase } from '@deepseek-ai/dsh-mcp-testkit'

const world = await oauthWorld()
await managerProfile(world.ctx, { base: { servers: { oauth: { ...world.config, enabled: true } } } })
const attempt = await world.ctx.mcpManager.startAuthorization('oauth')
```

`oauthWorld()` returns the world's context with credential, authorization, Web server, and tool services, a Streamable HTTP configuration that uses OAuth, an authorization owner factory, and switches that change the protocol server's token, rejection, and metadata answers. `phase()` waits for an attempt phase, `callback()` delivers the browser callback, and `authorize()` completes one authorization through an owner. `managerProfile()` composes the MCP client host and the manager from an inherited bundle and an optional user patch; its context must already carry the tool services.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/oauth-world.ts`](src/oauth-world.ts) answers OAuth discovery, dynamic registration, token, and MCP requests from one loopback HTTP server and records each request. [`src/manager-profile.ts`](src/manager-profile.ts) writes a temporary profile whose bundle inserts the host and manager entries, then mounts it through the Loader. Both register teardown through `onTestFinished`, so they run only inside a test.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [MCP client](../../mcp/mcp-client/README.md#oauth) — OAuth connections, explicit authorization, and the MCP client host.
- [MCP manager](../../mcp/mcp-manager/README.md) — the server fleet the profile fixture mounts.
- [Test-support group map](../README.md) — sibling test utilities.

-----

<a id="model-experience"></a>
## Model Experience

None, as these fixtures serve OAuth and MCP protocol traffic without assembling or sending model requests.

#### KV Cache effect

None; the package itself sends no provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The authorization server always grants the request: it does not render consent or check the client secret, and tests change its answers through the world's switches.
- The fixtures call `onTestFinished` and therefore run only inside a Vitest test.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
