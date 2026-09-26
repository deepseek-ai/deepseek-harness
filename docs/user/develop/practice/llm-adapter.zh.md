# LLM 适配器

[English](llm-adapter.md) | 中文

本文介绍如何为 Harness 接入新的模型提供方。

## 概述

LLM 适配器是一个继承 `LlmAdapter` 并实现 `stream()` 方法的类，它会将 Harness 的提供方无关请求转换为具体提供方的 API 调用，并将响应转换回 Harness 分片。

## 最小实现

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

## StreamChunk 协议

`stream()` 必须按以下协议生成分片：

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

### 关键规则

- 每个 `block-start` 都必须有与之对应的 `block-end`。
- `index` 从 0 开始递增，用于标识内容块的顺序。
- `tool-call-delta` 的 `argumentsDelta` 是原始 JSON 文本的增量，可以在一个分片中完整生成，也可以分多个分片生成。
- `finish` 必须是最后一个分片。
- `usage` 必须在 `finish` 之前生成。

## GenerateOptions

`stream()` 接收仓库导出的 `GenerateOptions`。它包含模型、适配器拥有的推理强度 ID、对话历史、系统提示词、工具 schema、生成参数、停止序列和中止信号；完整字段以 `@deepseek-ai/dsh-llm` 导出的 TypeScript 类型为准。适配器必须将支持的字段映射到具体 API；如果无法支持某个字段，应抛出带稳定 code 的 `LlmError`，不得静默丢弃。

请覆写 `resolveModel(provider, model, signal?)`，在一次查询中返回确切的提供方／模型身份以及可选的 `context` 和 `reasoning` 元数据。推理元数据包含有序的不透明 ID、展示名称，以及可选的配置默认值；请保留适配器给出的权威可选列表，包括其上游能力 API 返回的 `off`，不要将这些值提升为核心枚举。异步查询必须响应该可选信号，使取消和资源释放过程完全停稳。服务会校验聚合结果，并在调用 `stream()` 前拒绝显式指定但不受支持的推理强度；省略 `reasoning` 表示该模型没有可选的推理强度能力。

## 注册适配器

```ts ignore-check
ctx.llm.registerAdapter(['my-provider'], adapter)
```

第一个参数是该适配器处理的提供方路由列表。`GenerateOptions.provider` 选择已注册的适配器，`GenerateOptions.model` 则传入由适配器拥有、无需在生命周期启动时注册的模型 id。适配器能够向选择器公布模型选项时，请覆写 `listModels()`。

## 在 cordis.yml 中使用

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

## 实战参考

仓库中包含以下两个完整实现：

- `packages/llm/llm-deepseek/` — 使用 Messages API 的 DeepSeek 适配器
- `packages/llm/llm-pi-ai/` — Pi AI 适配器（不同的 API 格式）

对比这两个已交付的适配器，可以看到同一套 harness 契约如何在不同提供方 SDK 之上实现。

## 错误处理

适配器应通过带稳定 code 的 `LlmError` 抛出传输和协议故障；agent loop（智能体循环）会保留该错误及其 code，用于诊断和策略处理。不要依赖普通 `Error` 被自动转换。每个提供方 HTTP 请求还必须合并 `attributionHeaders()`，并传递 `options.signal`。

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
