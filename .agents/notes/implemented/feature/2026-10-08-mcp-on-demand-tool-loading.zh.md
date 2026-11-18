# Agent Note: On-demand MCP tool loading

Status: implemented

[English](2026-10-08-mcp-on-demand-tool-loading.md) | 中文

## Problem

已连接的 MCP 服务器会在每次请求中发送全部工具定义。Notion 托管服务器提供 46 个工具，定义合计约 214,500 字符；其中一个工具的输入 schema 就约有 83,000 字符。因此，只注册服务器的 Notion 插件在模型使用任何 Notion 工具之前，就会让每次请求都承担这部分上下文。

现有的 `ToolSchema.deferLoading` 标记解决不了这个问题。只有声明了 `toolUpdate` 的路由才会遵循它，而目录中只有默认的 `deepseek-flash` 条目声明了。该标记能保留可复用的前缀，但不会减少上下文。

## Decision

配置 `toolLoading: on-demand` 的 mcp-client 条目不把服务器的工具注册到工具注册表。该行为位于 mcp-client 内部；不改动会话事件、消息类型或其他包，mcp-manager 只把该字段传给它的实例。

**每个服务器一个加载器。** 服务器在 eager 服务器注册工具的位置注册 `mcp__<serverName>__load_tools`，并在 eager 服务器移除工具的位置撤下它，因此断线与重连遵循 eager 的生命周期。服务器自己名为 `load_tools` 的工具不列入目录，并记录一条警告。

**目录是一个系统提示词段落。** `mcp:<serverName>:tools` 段落列出每个工具的原始名称及其描述的第一行，长度以 `catalogDescriptionMaxLength` 为上限，并且只对能看到加载器的 agent 渲染。会话日志本来就记录系统提示词，所以目录不需要新的消息类型；只有服务器的工具列表变化时目录才会变化。

**加载注册到 agent 自己的作用域。** 加载器先校验所有请求的原始名称，再注册任何工具；随后把这些定义注册到插件为该 agent 创建的作用域中。插件在 `agent/disposed` 时释放该作用域，插件卸载时也会释放它。下一次请求头带上这些定义，agent loop 记录这次添加。子 agent、fork 和恢复的会话开始时都没有已加载的工具。

**每个发布的注册代都会延续已加载的工具。** 工具定义调用的是构建它的那一代连接的 client，因此重连后必须替换已加载的定义。每次发布注册代时，会为每个 agent 重新注册该代仍提供的已加载名称，并丢弃其余名称。重新注册失败只丢弃该 agent 的这个工具，并记录失败。

**加载器决定访问权限。** 工具限制只过滤继承的工具，因此能看到加载器就能加载目录中的任何工具，就像能看到 `skill` 就能加载目录中的任何 skill。执行 guard 与权限检查照常生效。

## Alternatives considered

**在 mcp-resources 中放一个共享的 `load_mcp_tools` 工具，并发布会话目录消息。** 实现后否决：它需要跨包的目录接口、只支持 Host 级服务器的限制、在每个 agent 的每一步都扫描会话历史的 `agent/pre-step` 监听器，以及一种持久化消息类型。

**把目录放进加载器的工具描述。** 否决：OpenAI 与 Azure OpenAI 的 Chat Completions 会拒绝超过 1024 字符的工具描述，pi-ai 路由原样传递描述，而十几个工具的目录就会超过这个上限。

**每个条目一个静态 `includeTools` 列表。** 否决：每个插件都必须预先选定工具，会话中模型无法使用其他工具。

**代理工具 `call_mcp_tool(server, tool, args)`。** 否决：工具列表从不变化，但模型失去每个工具的参数 schema，按工具名匹配的权限、展示与 guard 都需要转发。

**给 MCP 工具加 `deferLoading` 标记。** 否决：它不节省上下文，且只在声明 `toolUpdate` 的路由上生效。

**全局注册，再用 `tools.restrict({ deny })` 按 agent 隐藏。** 否决：每个 agent 都需要一个限制作用域，每次工具变化都会重新扫描注册表并复制每个 schema。

**恢复会话时恢复已加载的工具。** 否决：这需要持久记录已加载的名称，也就是改动会话格式。agent loop 已经会记录恢复的会话失去了哪些工具。

## Testing

mcp-client 规格覆盖：只注册加载器与提示词目录、看不到加载器的 agent 不渲染目录、加载到单个 agent 的作用域、无效加载、跨注册代延续已加载工具、撤下与恢复、释放 agent、限定在单个 agent 的重新注册失败、被排除的 `load_tools` 服务器工具、加载器名称冲突，以及从加载、调用到卸载的插件路径。一个 manager 规格挂载按需条目。`mcp-tool-loading` 会话快照固定目录段落、加载器 schema、工具添加记录，以及加载后的一次调用。

## Consequences

- 在 agent 加载工具之前，按需服务器的开销是加载器定义加每个工具一行目录。
- 每次加载都会改变下一次请求的工具列表。声明了工具更新的路由保留之前的前缀；其他路由每次加载开始一个新的请求序列。
- 模型在使用服务器的工具之前需要多一次工具调用。
- agent 的工具限制不过滤已加载的工具；用 `tools.guard` 可按名称禁止可加载的工具。
- PTC 程序要到下一个程序才能看到在 `run_code` 内加载的工具。
