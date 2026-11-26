# P: Prompt

English | [中文](prompt.zh.md)

Rules for model-visible text, such as [system prompt sections](../subsystems/system-prompt.md) and tool descriptions.

<a id="p1"></a>
## P.1: Describe a tool in its schema description, not in a system prompt section

### Reason

- Prompt management. One tool's usage lives in one place, next to its parameters, instead of being split between the tool schema and a separately named and ordered system prompt section.
- Consistency when tools change. A tool's description is added, removed, and filtered with the tool. A section is not: a step whose tool set excludes the tool still sends the section, and removing the tool appends a retirement notice to the Session history.
- Cohesion. The model reads a tool's usage together with the tool it applies to.

### Example, bad

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

The section describes only the `lsp` tool. It needs its own name, order, and lifetime, and it remains in the system prompt of a request whose tool set excludes `lsp`.

### Example

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

### Exception

Guidance about the relation between two or more tools belongs in a system prompt section, such as "read a file before you edit it" or "use `search` for ordinary navigation and `lsp` when textual matches are ambiguous". No single tool's description owns that guidance. Tools can also come from users, MCP servers, or third-party plugins, so a rule that involves them belongs in a section that a harness plugin registers, which is more trusted than those descriptions.

### Enforcement

Review: flag a new or changed system prompt section whose text applies to only one tool.
