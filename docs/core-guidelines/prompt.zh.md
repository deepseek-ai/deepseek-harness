# P：提示词

[English](prompt.md) | 中文

适用于模型可见文本的规则，例如[系统提示词段落](../subsystems/system-prompt.zh.md)和工具描述。

<a id="p1"></a>
## P.1：把工具说明写进它的 schema 描述，不要写进系统提示词段落

### 原因

- 便于管理提示词。一个工具的用法只放在一处，紧挨着它的参数，而不是分散在工具 schema 和一个单独命名、单独排序的系统提示词段落里。
- 工具变化时保持一致。工具描述随工具一起加入、移除和筛选，系统提示词段落则不会：某个步骤的工具集不含该工具时，仍会发送该段落；移除该工具时，会向 Session 历史追加一条停用通知。
- 信息内聚。模型读到工具用法时，同时读到它所适用的工具。

### 反例

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'

declare const lspTool: Omit<ToolDefinition, 'description'>

export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'tool:lsp',
    order: ctx.systemPrompt.getSectionOrder('TOOL_LSP'),
    text: 'Positions are one-based line and character (UTF-16). findReferences includes the declaration.',
  })
  ctx.tools.register({ ...lspTool, description: 'Query a language server for precise code navigation.' })
}
```

该段落只描述 `lsp` 工具。它需要自己的名称、顺序和生命周期；当某次请求的工具集不含 `lsp` 时，它仍留在系统提示词中。

### 示例

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

declare const lspTool: Omit<ToolDefinition, 'description'>

export function apply(ctx: Context): void {
  ctx.tools.register({
    ...lspTool,
    description: 'Query a language server for precise code navigation. line and character are one-based UTF-16 cursor coordinates. findReferences includes the declaration.',
  })
}
```

### 例外

涉及两个或多个工具之间关系的说明放在系统提示词段落中，例如“编辑文件前先读取它”，或“普通导航用 `search`，文本匹配有歧义时用 `lsp`”。这类说明不归属于任何单个工具的描述。工具还可能来自用户、MCP 服务器或第三方插件，因此涉及它们的规则放在 harness 插件注册的段落中，这类段落比那些工具描述更可信。

### 检查方式

审查：标记只适用于单个工具的新增或修改的系统提示词段落。
