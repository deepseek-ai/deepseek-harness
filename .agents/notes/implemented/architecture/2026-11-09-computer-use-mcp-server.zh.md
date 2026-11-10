# Agent Note: 以 MCP 服务器向其他 harness 提供 Computer Use

Status: implemented

[English](2026-11-09-computer-use-mcp-server.md) | 中文

## 问题

Computer Use 的训练数据应来自多个 agent harness，而不只是 DSH 会话。Codex、Claude Code 以及内部 harness 通过 MCP stdio 服务器接入能力；Codex 自己的 Computer Use 就是一个带持久 JavaScript REPL 的 stdio 服务器。DSH 的 `cua_run_code` 已经按 Agent 组合了保留的程序环境、授权、截图和本机连接，但只有 DSH 的模型回合能调用它。MCP 形态必须保留这些所有者，在多次调用间持久化程序状态，并且在每种 DSH 分发中都能从一条有文档的命令启动。

## 决策

`@deepseek-ai/dsh-cua-mcp` 是 `OPTIONAL_BUNDLES` 中的实验性组合包：它在空 profile 根上用一次 insert 组成独立的 `cua-mcp` profile，并通过 `dsh.bundle.profile` 声明该 profile，因此首次 `dsh --profile cua-mcp` 就从这一个组合包初始化 profile。这是唯一的 MCP 应用路径；没有包 bin 或 SDK 逃逸，该组合包不进入 `PROFILE_TEMPLATES`，因为模板不能引用实验包。

服务器运行在 profile 进程内，带着连接的 Agent、不经模型步骤地调用 `ctx.tools.execute`。一个 stdio 连接拥有一个 Agent：客户端初始化后创建，stdin EOF 时销毁。Agent 归属已经决定了保留的程序进程、本机连接和会话级授权，因此连接生命周期与状态生命周期重合。空的默认 preset `cua-mcp` 让该 Agent 只获得 `cua_run_code`，因为提供方只为已组合 preset 注册程序工具。

工具面由两个工具构成。`cua_run_code` 转发 `code`、缺省为 `CUA program` 的可选 `description` 和 `timeoutMs`；每个连接的首个结果携带执行规则和完整的 `cua` API 参考，使工具描述保持在客户端限制之内。`cua_reset` 通过 `ctx.cuaPrograms.reset` 释放程序环境，CUA 提供方现在把它与 `screenshotRequestTarget` 一起暴露。投影把每张延后的截图按程序观察到的请求版本交付，使程序文本中的坐标与交付的图片一致。提供方新增的 `screenshotTarget` 配置取代了没有模型的 profile 无法满足的模型路由查询。

授权有两种模式。`DSH_CUA_CONSENT=allow` 以批准标签为本会话回答连接 Agent 的每个审批问题。默认的 `elicit` 把每个问题作为表单 elicitation 转发给客户端，枚举即问题的选项标签。不新增任何 Session 事件：训练侧只消费 MCP 工具结果，接入 harness 的 transcript 记录调用；DSH 保留嵌套的 `tool/ptc-dispatch` 事件以供诊断。

组合列出自己的依赖闭包（25 行），而不是叠在 `dsh-base` 之上：不加载任何模型适配器、提示侧工具、遥测或会话管理行；CUA 或 PTC 包新增服务注入时，必需启动条目会大声失败，直到 patch 补上该行。初始化不需要 `dsh plugin` 步骤，因此 Python runtime wheel 和离线训练 Host 都不需要访问 registry。`--print-client-config codex|claude-code|json` 为当前安装渲染客户端配置项。

## 考虑过的替代方案

**通过 TypeScript SDK 启动 `dsh --profile sdk` 的 MCP 服务器。** SDK 协议没有不经模型回合直接运行工具的请求；补上它要改协议和两个 SDK 客户端，截图还要再跨一次进程边界。

**像 Codex 的 REPL 那样在 harness 之外的独立 CUA 服务器。** 授权、沙箱、日志、截图接入和 helper 生命周期都要重写。profile 内的服务器复用这些所有者，并仍是日后剥离的基础。

**带客户端 hook 的隐藏工具 `turn_ended`。** 它唯一的用途是把客户端的回合边界写进无人消费的日志；按键在程序结束时已经释放。

**为根 MCP 调用写 Session 事件。** 数据消费方只需要 MCP 结果；没有模型步骤的 `tool/call` 会虚构一个 Session 从未运行的步骤。

**暴露原始 `cua` 工具或程序沙箱提权。** 原始操作需要外部模型重新学习的逐方法 schema，提权需要该 profile 不具备的审批应答者。

**叠在 `dsh-base` 之上、禁用模型行的 profile 前端。** 组合出的 profile 带着约一百行没有消费者的插件：模型适配器、web 工具、子代理、压缩、遥测和会话管理。显式闭包只有四分之一，且在漂移时大声失败。

**用 `dsh plugin enable|disable` 子命令选中随附组合包。** 它在启动器里重复了插件管理器的仅改 manifest 选择，而且仍然产生以 base 为底的 profile；组合包声明的 profile 不需要任何步骤。

## 后果

每个安装都携带该组合包及其可选的 macOS 提供方依赖；`verify-default-product-isolation` 让它留在默认模板之外。必需启动条目 `cua-mcp` 在前端无法激活时让 profile 大声失败。客户端会在进程退出、`cua_reset` 或 Agent 销毁时看到状态丢失并重新创建对象。授权 elicitation 依赖 2025 版 MCP 请求模型；使用 2026-07-28 修订版的客户端改用 `allow`。首个结果中的参考文本由 profile 的期望输出测试固定，并随已安装的 CUA 包变化。
