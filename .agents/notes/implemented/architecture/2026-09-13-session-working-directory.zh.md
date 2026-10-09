# Agent Note: Session working directory

Status: implemented

[English](2026-09-13-session-working-directory.md) | 中文

## Problem

固定的 Session 创建目录无法表示在对话中切换检出目录的任务。各工具从不同来源解析路径时，可能读写不同项目；改变进程目录还会影响其他 Session。把可变目录信息放入系统提示词会改变可复用的提示词前缀。

## Decision

`dsh-working-directory` 拥有每个 Session 的一个日志化有效目录。投影从不可变的原始项目初始化，并折叠 `working-directory/change`；消费者读取该服务，而不是从 header 或沙箱根目录派生执行路径。目录变更通过文件系统 provider 验证，在 Session 内串行执行，并只在新目录可用后发布。

`dsh-base` 组合在全局挂载 `working_directory({ cd? })`。该工具读取或改变 Session 目录，使每个 Agent preset 都能选择或恢复它，包括没有文件编辑工具的 preset。Web 组合把操作工具放在 preset 作用域中。

必需的用户上下文快照携带当前值；每次已提交变更都会尝试通过普通 Agent 收件箱排入通知。取消或销毁可能丢弃尚未进入请求的通知，但目录事件仍然保留，供后续请求使用。所选目录消失时恢复到原始项目。恢复目录也消失时返回错误。写权限保持独立。

子代理捕获父代理当前目录或显式覆盖值，并在继承历史之后提交选定目录。已有进程、终端和持久 shell 保留进程局部目录。项目指令、技能和补全跟随有效目录，不改变 Session 身份、归属或运行时组合。

活跃 Session 的技能目录与文件补全通过同一个目录 owner 验证目录。这些读取可在发现操作之前提交恢复并排入通知，使发现的文件与后续操作关联到已提交的 Session 目录。冷态技能目录读取已记录的投影，不激活 Agent。

Web 侧栏终端的环境查询读取有效目录，不验证文件系统或执行恢复，因此目录缺失不会阻止重新连接保留的终端。新终端在创建进程前通过目录 owner 验证和恢复目录；后续 Session 目录变更不会改变该进程的目录。

Playwright MCP 和 Chrome DevTools MCP 在获取 Session 的 MCP 连接时验证有效目录，并在该目录启动服务器。后续目录变更不会重启保留的服务器，也不会改变其进程目录。

文件链接与命令目录标签使用各次操作执行时记录的结果元数据，因此后续目录变更不会使历史记录指向错误的位置。

[提示词变量记录](2026-07-05-prompt-variables-and-tool-guidance-ownership.zh.md)保留严格插值、路由变量归属与工具指导归属。[环境后缀记录](../../archived/bug-fix/2026-09-06-environment-prompt-suffix.md)保留部署、Harness 源码与 Web 指导的有序前缀／后缀位置。本决策拥有目录状态及其用户上下文位置。

## Alternatives considered

**改写 Session header。** header 是存储、归属与权限根目录使用的不可变身份元数据。改写它会混淆当前执行状态与原始项目。

**让 worktree 工具拥有目录状态。** 普通目录变更、文件系统工具和子代理需要同一个值。Git 专用 owner 会重复实现选择与恢复。

**改变进程目录或同步所有 shell。** 并发 Session 与已有子进程具有独立生命周期。Session 变更影响新的目录相关操作，shell 内的 `cd` 则保持局部。

**把目录文本留在系统提示词中。** 可变操作上下文应位于保留历史之后，复用权限状态的用户上下文机制。

## Consequences

运行时提供一个目录 owner，并保留原始项目。消费者一起迁移，包括文件系统、shell、指令、技能、子代理和两种 SDK。目录可能在 harness 之外消失，因此在使用时执行验证和日志化恢复。即使可选上下文被禁用，必需运行时上下文也仍然可见。

`{{cwd}}` 没有循环提供的值；依赖该内置变量的自定义 persona 会触发严格插值错误。部署方按照[系统提示词迁移说明](../../../../packages/core/system-prompt/README.zh.md)移除这些引用。当前目录与恢复目标均不可用时，提示词组装会拒绝模型轮次；[目录服务恢复说明](../../../../packages/session/working-directory/README.zh.md#known-limitations-and-deferred-work)要求恢复目录，或通过 SDK 或 Host 服务选择现有的绝对目录。

验证覆盖 Session 相互独立、相对路径变更、回放、取消、恢复、工具卸载、用户上下文渲染、provider 继承和真实目录操作。
