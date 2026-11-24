# Agent Note: 工具可达性与初始披露

Status: proposed

[English](2026-11-18-tool-reachability-and-initial-disclosure.md) | 中文

## Problem

两个执行器在每个步骤都完整披露每个可达工具：`tool-executor-native` 通过请求的 `tools` 字段，`tool-executor-ptc` 通过 `tools:sdk` 章节。没有任何按工具的说明能表达模型可以如何调用某个工具，以及在任何发现之前它能收到多少内容；`ToolSchema.deferLoading` 只是以某一个提供方机制命名。

## Proposal

用两个面向模型的维度描述每个可达工具，两者都由模型收到的内容定义，而不是由宿主或提供方传输的内容定义。

### 可达性

| 取值 | 含义 |
|---|---|
| `native` | 只能作为提供方工具调用来调用。 |
| `program` | 只能在 `run_code` 程序内部调用。 |
| `both` | 两种方式都可调用。 |

授权是独立的：被 `restrict()` 移除或因 `when` 条件未激活而移除的工具不在此模型之内；guard 拒绝的是一次执行，不改变任何一个维度。

### 初始披露

| 取值 | 模型在任何发现之前收到的内容 |
|---|---|
| `none` | 关于该工具的任何内容都没有。 |
| `name` | 工具名称。 |
| `summary` | 不含参数的描述；可以按命名空间给出。 |
| `full` | 名称、描述、参数，以及 `program` 可达性下的返回类型。 |

每个可达工具都可被搜索；`none` 只表示不在初始披露中。

## Alternatives considered

**一个由 `invisible`、`discoverable`、`injected`、`system prompt` 构成的可见性轴。** `injected` 是工具在搜索命中后进入的状态，`system prompt` 是通道，且不存在仅名称级别；该轴混合了策略、状态和通道。

**一个 `discoverable` 布尔值。** 每个看似需要不可搜索工具的情形都是授权、搜索排序、别名或不是工具的运行时内建函数；省略 schema 不是强制手段（[packages/AGENTS.md](../../../../packages/AGENTS.md)）。

## Acceptance criteria

- 每个已注册工具在每个步骤为每个维度解析出一个取值，两个执行器读取同一次解析。
- 在录制快照中，一个 `none` 工具在每个执行器下都通过 `tool_search` 被找到并随后被调用；`native` 激活按[活跃工具请求头](../../implemented/architecture/2026-09-20-dynamic-tool-updates.zh.md)投影。

## Risks

- 发现增加一次模型往返，且搜索质量取决于工具名称和描述。
- 按步骤重新计算会在取值之间移动工具，并改变缓存所依赖的声明前缀。
