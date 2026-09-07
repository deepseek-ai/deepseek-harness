# Agent Note: 能力 seam——Service Definition / Service Provider / Consumer 角色

Status: implemented

[English](2026-06-13-capability-seams.md) | 中文

## 问题

harness 具有可替换的能力，包括 shell 执行和模型提供方。一项能力涉及三个关注点，它们以不同速率、因不同原因变化：*约定*（这项能力是什么）、*实现*（它如何运行）、*消费方 API*（模型和其他插件面向什么编程）。将三者捆绑在一个包中会耦合这些变化速率——把本地执行器换成沙箱化执行器时，模型看到的工具 schema 也会被搅动，尽管面向模型的约定从未改变。

这与「谁在运行时提供、谁需要一项能力」是不同的问题，后者 Cordis 已通过服务 + `inject` 解决（提供方注册 `ctx.shell`；消费方声明 `inject: ['bash']`，其 fiber 挂起直到服务存在）。该机制是必要的，但不决定包的边界；本 Agent Note 决定的是包的边界。

## 决策

一项可替换的能力包含**三个角色**：

1. **Service Definition**——拥有 `ctx.<key>` 的 Cordis `Service` 和词汇类型，仅依赖约定所需的词汇（例如 `dsh-shell`：`ShellExecutor`、`ShellRunResult`、`ShellProcess`）。Service Definition 可以是抽象类，也可以是具体的注册表服务；绝不是 TypeScript `interface`。
2. **Service Provider**——提供或注册实现的插件（例如 `dsh-bash-local`：子进程、由提供方管理的范围终止、spill 文件截断）。[原生 containment 决策](2026-08-28-subprocess-native-containment.zh.md)负责本地提供方的 OS 特有范围机制。沙箱化和远程 Service Provider 是依据同一 Service Definition 实现或注册的兄弟包。
3. **Consumer**——模型和插件编程所面向的内容（例如 `dsh-tool-bash`：`bash` schema，后台句柄注册到通用任务运行时）。Consumer 注入服务键，从不导入 Service Provider 特有的类型。

角色名使用标题式大小写：**Service Definition**、**Service Provider** 和 **Consumer**。泛指的 `provider` 和 `consumer` 仍使用小写。

Service Provider 与 Consumer 由此独立演进：沙箱化执行器替换 `dsh-bash-local` 时无需触碰任何工具 schema。

当角色独立演进时，通常使用不同的包；但当各角色确实属于同一个关注点时，并非必须拆分：LLM（大语言模型） seam 将 Service Definition 和 Consumer 合并为 `dsh-llm`（Consumer 是 agent loop（智能体循环）本身，而非可替换的 schema 接口），适配器作为 Service Provider 包。不要预防性地拆分——如果一项能力只有一种可设想的 Service Provider 和一个 Consumer，就保持为一个包，直到出现第二个。

## 术语：seam 指三者组合，而非接口

一个 **seam** 是完整的能力——三个角色合在一起：**Service Definition**（拥有 `ctx.<key>` 和词汇的 Cordis `Service`）、一个或多个 **Service Provider**，以及一个或多个 **Consumer**。`packages/shell` 是规范范例——`dsh-shell` / `dsh-bash-local`+`dsh-bash-sandbox` / `dsh-tool-bash`。一个包可以承担多个角色，但单个角色本身不是 seam。「seam」一词严格保留给这种完整能力；命名其中一个组成部分时，应使用其角色、类、服务、约定或扩展点。[术语表](../../../../docs/glossary.zh.md#capability-seam)是规范条目。

## 曾考虑的替代方案

- **始终合并各角色**：否决。因为它会重新耦合独立变化的 Service Definition、Service Provider 和 Consumer。
- **`@cordisjs/plugin-capability`**：这是完全不同的维度。它是一个权限／能力*安全*服务（具名权限加继承，通过 `ctx.capability.test` 针对会话检测这些权限），是延后的权限／沙箱工作（`tools/pre-execute` deny/ask 门）的候选方案，不是替换实现的机制。混淆这两个「能力」概念正是本 Agent Note 所指出的陷阱。

## 后果

分离角色会增加包和样板代码（`package.json`、`tsconfig`、README 和注入接线）。换来的是：Service Provider 与 Consumer 独立发布和版本管理，新后端永远不会波及面向模型的约定。[AGENTS.md](../../../../AGENTS.md) 和 [architecture.md](../../../../docs/architecture.zh.md) 载有这项规则；bash 三件套是参考模板。本 Agent Note 记录为什么独立变化的角色通常需要拆分，而确实共享的关注点可以保持合并。
