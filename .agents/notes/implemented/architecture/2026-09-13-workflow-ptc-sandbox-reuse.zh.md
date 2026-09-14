# Agent Note: 工作流复用 PTC Node 沙箱

Status: implemented

[English](2026-09-13-workflow-ptc-sandbox-reuse.md) | 中文

## 问题

动态工作流执行模型编写的 JavaScript 并启动 subagent。worker 线程把脚本执行移出宿主事件循环，但逃逸 VM 的代码可以使用 Node 并拥有宿主进程的文件权限。PTC 已有 Node 进程实现，负责 OS 文件约束、隔离的程序状态、有界输出与控制通信，以及受管清理。维护第二套启动器会重复这些职责。

## 决策

`dsh-workflow-ptc` 通过共享的 Node `PtcRuntime` 实现 `WorkflowEngine`。每次运行在一个 PTC 进程中保留既有 VM 与工作流辅助函数。Host 绑定将 guest 连接到配置的 subagent 提供方及工作流观察器；Host 提供发起调用的 Agent，并解析其 Session 的常设文件策略与 cwd。

VM 定义辅助 API，以及协作式并发、agent 总数和条目上限。它不是安全边界，这些计数器也不是 Host 强制的安全配额。文件强制、V8 堆限制、输出与控制限制、受管进程清理仍由 PTC 及其沙箱／子进程提供方负责。网络访问与提供方特有的约束限制保持与 PTC 相同。

工作流执行传入 `timeoutMs: null`，显式禁用 Node 运行时的经过时间定时器。省略 timeout 或使用数值的 PTC 请求保留配置的默认值与上限；`run_code` 仍只接受正数覆盖值。最初的 VM 片段保留独立的同步超时。调用方的中止信号（包括外层工具截止）仍会取消工作流。

取消立即中止 PTC 进程，以及待启动和活跃子 agent 共享的信号。适配器等待待完成启动与子 agent 资源释放，包括取消后才发布的子 agent。PTC 停止程序；已经进行中的 Host 绑定仍由其调用方负责。不增加工作流清理定时器，也不等待 guest 取消确认。

进度同时只使用一个绑定调用。首批同步发起，后续事件按序排队，并在子 agent 资源释放及最终结果之前完成传递。这避免普通日志突发耗尽 PTC 的待完成调用上限。取消会停止对子 agent 结果的等待，但仍等待子 agent 资源释放。

Node 引导程序发送终态帧后保持控制管道打开，直到 Host 将其关闭。未被等待的绑定回复可能仍在传输，因此子进程提前关闭会让 `EPIPE` 与已经完成的程序结果发生竞争。

[动态工作流决策](../feature/2026-07-05-dynamic-workflows.zh.md)保留脚本、结构化输出、事件与工具语义；本文只取代其执行基底与信任实现。[沙箱化 Node PTC 决策](2026-09-11-sandboxed-node-ptc-runtime.zh.md)保留执行与控制保证；显式 null 截止扩展其服务选项。[agent 作用域运行时设计](2026-07-12-agent-scope-runtime-design.zh.md#workflow-children-are-pending-starts-or-published-records)保留待启动与子 agent 清理的归属规则。

## 曾考虑的替代方案

**保留 worker-thread 执行。** 终止 worker 无法应用 Session 的 OS 文件策略，也无法提供直接 Node 代码所需的受管进程清理。

**创建独立的工作流子进程运行时。** 另一套启动器、控制传输与沙箱适配器会重复维护相同执行职责。PTC 已经接受程序和具名异步 Host 绑定，无需了解工具或 Session。

**用直接 Node 工作流 API 替换 VM。** VM 与辅助函数保留既有脚本语义、同步片段超时与 JSON 物化。实现 OS 约束不需要移除它们。

**对工作流应用 PTC 的数值截止。** 工作流可能等待一长串 subagent。显式 `null` 保留调用方控制的生命周期，不改变普通 PTC 默认值，也不把任意大的数值当作没有截止。

## 后果

工作流与显式启用的 Ralph 执行共享 PTC 的安全与进程生命周期实现。Ralph 在已发布默认组合中保持禁用。脚本仍使用相同钩子与结果信封；不增加新的权威进度台账或 Host 子 agent 数量配额。

取消不等待脚本协作推进。适配器等待子 agent 清理，因此不履行生命周期约定的 subagent 提供方可能延迟资源释放。进程清理保留所选子进程提供方对受管范围的限制；本变更不宣称进程树 CPU/RSS 计量或普遍的后代终止保证。
