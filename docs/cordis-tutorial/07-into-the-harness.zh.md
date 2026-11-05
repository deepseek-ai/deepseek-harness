# 7. 进入 harness

[English](07-into-the-harness.md) | 中文

本章会向 harness 的 `tools` 服务注册一个可由模型调用的工具，通过 harness 工具流水线执行它，并观察结果事件。整个示例无需密钥，也不会调用模型。

## 工具插件

创建 `greet-tool.ts`，将它放在 `tmp/cordis-tutorial` 中：

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

这里的每个模式都来自前几章：`inject: ['tools']`（[第 3 章](03-services.zh.md)）会让插件等待工具注册表就绪；`ctx.tools.register(...)` 会把注册 disposer 附着到插件（[第 2 章](02-lifecycle-and-effects.zh.md)），因此卸载时会注销工具。`defineTool` 将 `parameters` 规约转换为向模型展示的 JSON Schema，推导 `args` 的类型，并在 `execute` 运行前校验模型提供的参数。工具返回由 `output.schema` 声明的规范值；`output.render` 则作为 Native renderer（原生渲染器），另行生成可持久化的结果内容。

## 观察插件

创建 `tool-logger.ts`。这是一个独立插件，通过 harness 的 `tools/result` 事件观察应用中的每次工具调用：

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

`import type {} from '@deepseek-ai/dsh-tools'` 行会引入该包的声明合并，使 `'tools/result'` 及其 payload 具有类型。这与第 4 章导入 `stats.ts` 的做法相同，只是扩展到了包级别。

## 组合并运行

```yaml
- name: '@deepseek-ai/dsh-system-prompt'
- name: '@deepseek-ai/dsh-tools'
- name: './tool-logger.ts'
- name: './greet-tool.ts'
```

`@deepseek-ai/dsh-tools` 会注入 `systemPrompt` 服务，因为工具需要向系统提示词贡献 schema，所以组合中也要列出该服务的提供方。缺少提供方时，工具插件会像[第 6 章](06-composition-and-hmr.zh.md)所述那样保持 PENDING。

```sh
node --import tsx ../../vendor/cordis/bin.js
```

```
[tool-logger] greet -> Hello, Cordis!
tool replied: [{"type":"text","text":"Hello, Cordis!"}]
```

logger 会先触发：`tools/result` 在结果物化过程中发出，发生在 `execute` 向调用方返回的 promise 兑现之前。两个插件都不知道另一个插件存在，它们由注册表服务和事件连接。

## 从这里走向完整 agent（智能体）

真实 agent 就是这套组合再加上更多插件：LLM（大语言模型）适配器、agent loop（智能体循环）、持久化和应用入口。对照 [base profile 层](../../packages/bundle/base/cordis.patch.yml)与 [headless 层](../../packages/bundle/headless/cordis.patch.yml)，你现在已经可以读懂其中各项。通过一个小型 `--patch` overlay 加入 `greet-tool.ts` 即可。

后续可以阅读：

- [构建工具](../user/develop/basic/tool.zh.md)：深入了解 `defineTool`，包括呈现和更丰富的 schema。
- [三层能力设计](../user/develop/practice/index.zh.md)：harness 如何组织可替换能力。
- [子系统页面](../subsystems/core.zh.md)上生成的 `cordis-surface` 区块：可以注入和监听的所有内容，各在其所属页面上。
- [架构](../architecture.zh.md)：这些插件所处的系统地图。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
