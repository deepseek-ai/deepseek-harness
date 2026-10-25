# 7. Into the harness

English | [中文](07-into-the-harness.zh.md)

This chapter registers a model-callable tool with the harness's `tools` service, executes it through the harness tool pipeline, and observes the result event. It remains keyless and does not call a model.

## A tool plugin

Create `greet-tool.ts` in `tmp/cordis-tutorial`:

```ts
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'

export const name = 'greet-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet the named person.',
    parameters: {
      name: { type: 'string', required: true, description: 'Who to greet' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return `Hello, ${args.name}!`
    },
  }))

  // Drive one call through the real execution pipeline, standing in for
  // the model. ToolCallId brands the correlation id a provider would issue.
  void (async () => {
    const result = await ctx.tools.execute({
      calls: [{
        type: 'tool-call', id: brandString<ToolCallId>('demo-1'),
        name: 'greet', arguments: JSON.stringify({ name: 'Cordis' }),
      }],
      signal: new AbortController().signal,
    })
    console.log('tool replied:', JSON.stringify(result.results[0]?.result.content))
  })()
}
```

Every pattern here is from the earlier chapters: `inject: ['tools']` ([chapter 3](03-services.md)) holds the plugin until the tool registry exists; `ctx.tools.register(...)` attaches the registration disposer to the plugin ([chapter 2](02-lifecycle-and-effects.md)), so unloading unregisters the tool. `defineTool` converts the `parameters` spec to the JSON Schema shown to the model, infers the type of `args`, and validates model-supplied arguments before `execute` runs. The tool returns the canonical value declared by `output.schema`; `output.render` separately produces the Native and durable result content.

## An observer plugin

Create `tool-logger.ts` — a separate plugin that watches every tool call in the app through the harness's `tools/result` event:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'tool-logger'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.on('tools/result', (exec, result) => {
    const text = result.content
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('')
    console.log(`[tool-logger] ${exec.name} -> ${text}`)
  })
}
```

The `import type {} from '@deepseek-ai/dsh-tools'` line pulls in the package's declaration merges so `'tools/result'` and its payload are typed — the same move as chapter 4's `stats.ts` import, at package scale.

## Compose and run

```yaml
- name: '@deepseek-ai/dsh-system-prompt'
- name: '@deepseek-ai/dsh-tools'
- name: './tool-logger.ts'
- name: './greet-tool.ts'
```

`@deepseek-ai/dsh-tools` injects the `systemPrompt` service because tools contribute schemas to the system prompt, so the composition lists its provider too. Without it, the tools plugin remains PENDING as described in [chapter 6](06-composition-and-hmr.md).

```sh
node --import tsx ../../vendor/cordis/bin.js
```

```
[tool-logger] greet -> Hello, Cordis!
tool replied: [{"type":"text","text":"Hello, Cordis!"}]
```

The logger fired first: `tools/result` is emitted as part of result materialization, before `execute`'s promise resolves to the caller. Neither of your plugins knows the other exists — the registry service and the event connect them.

## From here to a full agent

A real agent is this composition plus more plugins: an LLM adapter, the agent loop, persistence, and an application entry. Compare the [base profile layer](../../packages/bundle/base/cordis.patch.yml) and [headless layer](../../packages/bundle/headless/cordis.patch.yml) — you can read their entries now. Add your `greet-tool.ts` through a small `--patch` overlay.

Where to go next:

- [Build a tool](../user/develop/basic/tool.md) — more of `defineTool`, including presentation and richer schemas.
- [Three-layer capability design](../user/develop/practice/index.md) — how the harness structures replaceable capabilities.
- The generated `cordis-surface` regions on the [subsystem pages](../subsystems/core.md) — everything you can inject and listen to, each on its owning page.
- [Architecture](../architecture.md) — the system map these plugins live in.

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
