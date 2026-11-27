# P: Prompt

English | [中文](prompt.zh.md)

Rules for model-visible text, such as [system prompt sections](../subsystems/system-prompt.md) and tool descriptions.

<a id="p1"></a>
## P.1: Describe a tool in its schema description, not in a system prompt section

### Reason

- Prompt management. One tool's usage lives in one place, next to its parameters, instead of being split between the tool schema and a separately named and ordered system prompt section.
- Consistency when tools change. A tool's description is added, removed, and filtered with the tool. A section follows the tool set only when its text callback reads `toolSet`, which every such section must repeat; otherwise a step whose tool set excludes the tool still sends the section.
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

The section describes only the `lsp` tool. It needs its own name, order, and lifetime, and its static text remains in the system prompt of a step whose tool set excludes `lsp`.

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

A habit that applies across calls of one tool, such as checking the bash exit-code marker on every result, also stays in that tool's section, as the [tool guidance ownership decision](../../.agents/notes/implemented/architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.md) records.

### Enforcement

Review: flag text in a new or changed system prompt section that applies to only one tool and that no exception covers.
