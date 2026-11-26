---
description: "Keyless mock model route for demos and previews that must answer without a provider key."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-mock

English | [中文](README.zh.md)

## Summary

`dsh-llm-mock` registers the `mock` provider route with one model, `mock`, through `ctx.llm`. Every call on that route streams the configured `reply` as one text block and stops. It sends no network request and reads no credential, so a deployment can start Sessions before a user adds a provider key. The [browser Preview](../webworker-packer/README.md) mounts it as its default model; other provider routes stay configurable beside it.

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

Mount the plugin beside `ctx.llm` and select provider `mock`, model `mock`:

```yaml
- id: llm-mock
  name: '@deepseek-ai/dsh-llm-mock'
  config:
    reply: This is a mock model reply.
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: mock
    model: mock
```

`reply` is the only setting; it defaults to `This is a mock model reply.` and must be nonempty. The model picker lists the route as **Mock** with the model **Mock model**, accepting text input. The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-llm-mock) lists the accepted fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, the adapter's model listing and fixed-reply stream, and adapter registration |

The adapter ignores the request content. It checks the request signal once before yielding, so an already aborted call fails without output.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [LLM service](../../llm/llm/README.md) — adapter registration and the stream chunk contract.
- [Mock LLM server](../../test-support/llm-mock-server/README.md) — a scriptable HTTP endpoint for testing provider adapters and failure recovery.

-----

<a id="model-experience"></a>
## Model Experience

None, as no model receives requests on this route: the adapter answers every call with the configured text.

#### KV Cache effect

None; the route sends no provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The reply is fixed**: it does not depend on the conversation, never calls tools, and reports no token usage.
- **Auxiliary requests receive the same reply**: a generated Session title on this route repeats the reply text.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
