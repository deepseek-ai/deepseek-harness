# LLM adapters

English | [中文](llm-adapter.zh.md)

This guide connects a new LLM provider to Harness.

## Overview

An LLM adapter extends `LlmAdapter` and implements `stream()`, translating Harness's provider-neutral request into a provider API call and translating the response back into Harness chunks.

## Minimal implementation

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

class MyAdapter extends LlmAdapter {
  private apiKey: string

  constructor(apiKey: string) {
    super()
    this.apiKey = apiKey
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 1. Convert options.messages to the provider format.
    // 2. Call the streaming API.
    // 3. Convert the response into StreamChunk values.
  }
}

export interface Config {
  apiKey: string
  providers: string[]
}

export const Config: Schema<Config> = Schema.object({
  apiKey: Schema.string().required(),
  providers: Schema.array(Schema.string()).required(),
})

export const name = 'my-llm-adapter'
export const inject = ['llm']

export function apply(ctx: Context, config: Config) {
  const adapter = new MyAdapter(config.apiKey)
  ctx.llm.registerAdapter(config.providers, adapter)
}
```

## StreamChunk protocol

`stream()` yields chunks using this protocol:

```ts
import { brandString } from '@deepseek-ai/dsh-brand'
import type { StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'

async function* exampleChunks(): AsyncIterable<StreamChunk> {
  // 1. Start each content block with block-start.
  yield { type: 'block-start', index: 0, blockType: 'text' }

  // 2. Stream text through text-delta.
  yield { type: 'text-delta', index: 0, text: 'Hello' }
  yield { type: 'text-delta', index: 0, text: ' world' }

  // 3. End each content block with block-end and the complete block.
  yield {
    type: 'block-end',
    index: 0,
    block: { type: 'text', text: 'Hello world' },
  }

  // 4. Tool-call block.
  yield { type: 'block-start', index: 1, blockType: 'tool-call' }
  yield {
    type: 'tool-call-delta',
    index: 1,
    id: brandString<ToolCallId>('call-123'),
    name: 'bash',
    argumentsDelta: '{"command":"ls"}',
  }
  yield {
    type: 'block-end',
    index: 1,
    block: {
      type: 'tool-call',
      id: brandString<ToolCallId>('call-123'),
      name: 'bash',
      arguments: '{"command":"ls"}',
    },
  }

  // 5. Token usage.
  yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } }

  // 6. Finish reason.
  yield { type: 'finish', reason: { kind: 'stop' } }
  // Alternatively, { kind: 'tool-calls' } requests tool execution.
}
```

### Key rules

- Every `block-start` has a matching `block-end`.
- `index` increases from 0 and identifies content-block order.
- A `tool-call-delta` carries raw JSON text in `argumentsDelta`, either all at once or over multiple chunks.
- `finish` is the final chunk.
- Emit `usage` before `finish`.

## GenerateOptions

`stream()` receives the exported `GenerateOptions` type. It includes the model, adapter-owned reasoning-effort id, conversation history, system prompt, tool schemas, generation parameters, stop sequences, and abort signal; treat the TypeScript type exported by `@deepseek-ai/dsh-llm` as authoritative. Map supported fields to the provider API. If the provider cannot honor a field, throw `LlmError` with a stable code instead of silently dropping it.

Override `resolveModel(provider, model, signal?)` to return exact provider/model identity plus optional `context` and `reasoning` metadata in one lookup. Reasoning metadata contains ordered opaque ids and display names plus an optional configured default; preserve the adapter's authoritative selectable list, including `off` when its upstream capability API returns it, instead of promoting those values into a core enum. Honor the optional signal for asynchronous lookup so cancellation and disposal reach quiescence. The service validates the aggregate and rejects unsupported explicit efforts before `stream()`; omitting `reasoning` means that model has no selectable reasoning-effort capability.

## Register an adapter

```ts ignore-check
ctx.llm.registerAdapter(['my-provider'], adapter)
```

The first argument lists provider routes handled by the adapter. `GenerateOptions.provider` selects the registered adapter, while `GenerateOptions.model` passes an adapter-owned model id without lifecycle registration. Override `listModels()` when the adapter can advertise model choices to selectors.

## Use it from cordis.yml

```yaml
- id: my-llm
  name: './src/my-llm-adapter.ts'
  config:
    apiKey: !!js process.env.MY_API_KEY
    providers:
      - my-provider

- id: agent-loop
  name: '@deepseek-ai/dsh-agent-loop'
  config:
    agents:
      - id: main
        provider: my-provider
        model: my-model-v1
```

## Reference implementations

The repository contains complete implementations:

- `packages/llm/llm-deepseek/` — DeepSeek adapter using the Messages API
- `packages/llm/llm-pi-ai/` — Pi AI adapter using a different API format

Compare the two shipped adapters to see the same harness contract implemented over different provider SDKs.

## Error handling

Adapters throw transport and protocol failures as `LlmError` values with stable codes. The agent loop preserves the error and code for diagnostics and policy; it does not convert an ordinary `Error` automatically. Every provider HTTP request must also merge `attributionHeaders()` and forward `options.signal`.

```ts
import {
  attributionHeaders,
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

class HttpAdapter extends LlmAdapter {
  constructor(private readonly endpoint: string) {
    super()
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...attributionHeaders(),
      },
      body: JSON.stringify({ model: options.model, messages: options.messages }),
      ...options.signal ? { signal: options.signal } : {},
    })
    if (!response.ok) {
      throw new LlmError(`Provider API error: ${response.status}`, 'PROVIDER_HTTP_ERROR')
    }
    // A real adapter parses the response and emits the complete chunk sequence.
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
```
