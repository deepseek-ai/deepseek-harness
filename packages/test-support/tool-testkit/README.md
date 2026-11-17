---
description: "Define test tools and invoke tool pipelines or selected executors in repository tests and benchmarks."
kind: "package-library"
---

# @deepseek-ai/dsh-tool-testkit

English | [中文](README.zh.md)

## Summary

Use this package to define content-producing test tools and exercise tool execution without running an Agent turn. Tests and benchmarks import its helpers as a development dependency. Callers own the Cordis context, plugin composition, and teardown.

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

Add `@deepseek-ai/dsh-tool-testkit` to the consuming package's `devDependencies`. Define a fixture when the test needs rendered content without a domain-specific result value:

```ts
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const tool = defineContentToolFixture({
  name: 'echo',
  description: 'Return a test message.',
  parameters: {},
  execute: async () => [{ type: 'text', text: 'hello' }],
})
```

Register the returned definition through the caller's tool registry. Use `executeToolFixture` for an already-parsed invocation, or `executeModelToolFixture` to pass one JSON-encoded call through the selected executor. The latter requires the caller to mount that executor and rejects arguments that cannot be JSON-encoded or an executor response without a result. See [`src/index.ts`](src/index.ts) for invocation fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/index.ts`](src/index.ts) adapts content blocks into a tool's canonical JSON value and delegates execution to the production pipeline or registry. It creates no context and owns no plugin registrations.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Tools package](../../core/tools/README.md) — tool definitions, registry, and execution policy.
- [Testing policy](../../../docs/testing.md) — choosing verification for production behavior.
- [Test-support group map](../README.md) — sibling test utilities.

-----

<a id="model-experience"></a>
## Model Experience

None, as these test helpers do not assemble or send model requests.

#### KV Cache effect

None; the package itself sends no provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Content-array values are test fixtures; product tools declare domain-owned output schemas.
- Direct pipeline execution omits model-batch scheduling. Both execution helpers omit root Session logging; use an Agent turn when verifying the recorded conversation.
- Plugin composition and context disposal remain caller-owned.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
