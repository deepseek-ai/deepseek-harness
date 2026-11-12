# Agent Note: 以 MCP 服务器向其他 harness 提供 Computer Use

Status: implemented

[English](2026-11-09-computer-use-mcp-server.md) | 中文

## 问题

Computer Use 的训练数据应来自多个 agent harness，而不只是 DSH 会话。Codex、Claude Code 以及内部 harness 通过 MCP stdio 服务器接入能力；Codex 自己的 Computer Use 就是一个带持久 JavaScript REPL 的 stdio 服务器。DSH 的 `cua_run_code` 已经按 Agent 组合了保留的程序环境、授权、截图和本机连接，但只有 DSH 的模型回合能调用它。MCP 形态必须保留这些所有者，在多次调用间持久化程序状态，并且在每种 DSH 分发中都能从一条有文档的命令启动。

## 决策

`@deepseek-ai/dsh-cua-mcp` 是 `OPTIONAL_BUNDLES` 中的实验性组合包：它在空 profile 根上用一次 insert 组成独立的 `cua-mcp` profile。只选它这一个组合包的 profile manifest 就是全部安装步骤：启动器加载已存在的 manifest 时不查 `PROFILE_TEMPLATES`，而安装本身已自带该组合包，因此不涉及 pnpm 或 registry。这是唯一的 MCP 应用路径；没有包 bin 或 SDK 逃逸，该组合包不进入 `PROFILE_TEMPLATES`，因为模板不能引用实验包。

服务器运行在 profile 进程内，带着连接的 Agent、不经模型步骤地调用 `ctx.tools.execute`。一个 stdio 连接拥有一个 Agent：在 stdio 传输打开之前创建，stdin EOF 时销毁。每次程序调用都作为该 Agent 的维护活动运行，因此 Agent 销毁时会取消进行中的调用，并等它及其嵌套调用结算之后才关闭 Session。Agent 归属已经决定了保留的程序进程、本机连接和会话级授权，因此连接生命周期与状态生命周期重合。空的默认 preset `cua-mcp` 不组合任何面向模型的条目；该 Agent 不使用 `agentPreset` 指定的 preset，因此提供方为它提供 `cua_run_code`。该 Agent 在专用工作区中工作，即 `DSH_CUA_WORKSPACE`，未设置时为 Harness home 下的 `cua-mcp/workspace`：Agent 的工作目录就是其程序的 `workspace-write` 根，而客户端启动服务器的目录可能是 `/`。

工具面由三个工具构成。`cua_run_code` 就是该 Agent 的 DSH 注册项，经协议服务器的低层 `tools/list` 与 `tools/call` handler 提供：每次列表都从工具注册表投影名称、描述和参数，调用则在 Agent 的 initiator 作用域内把参数原样交给工具执行器，因此提供方的定义是唯一 schema，`description` 按该定义必填，校验与未知名称由 DSH 回答；唯一的剪裁是注册项中的沙箱提权字段，投影省略它们，调用也不得指定。`cua_get_api_reference` 返回 `cua` API 参考，即提供方为该 Agent 注册的指引；它不保存状态，因此连接上的任何对话随时都能读取。`cua_reset` 结束该 Agent 的程序环境并保留 Agent：前端取消正在运行的程序，再调用 `ctx.cuaPrograms.release`，由提供方的程序运行时释放该 state owner 的环境，CUA 提供方把它与 `screenshotRequestTarget` 一起暴露；下一个程序在新进程中启动，本机连接和本会话的授权决定保留。前端围绕这次释放安排自己的调用：reset 在被取消的程序结算之后才返回，程序则等待进行中的释放。投影把每张被 inspect 的截图按程序观察到的请求版本交付，使程序文本中的坐标与交付的图片一致。提供方新增的 `screenshotTarget` 配置取代了没有模型的 profile 无法满足的模型路由查询。

授权有两种模式。`DSH_CUA_CONSENT=allow` 以批准标签为本会话回答连接 Agent 的每个审批问题。默认的 `elicit` 把每个问题作为表单 elicitation 转发给客户端，枚举即问题的选项标签。不新增任何 Session 事件：训练侧只消费 MCP 工具结果，接入 harness 的 transcript 记录调用；DSH 保留嵌套的 `tool/ptc-dispatch` 事件以供诊断。

组合列出自己的依赖闭包（26 行），而不是叠在 `dsh-base` 之上：不加载任何模型适配器、提示侧工具、遥测或会话管理行。`cua-mcp` 不是启动必需条目，无法激活的行由启动器在 stderr 上报告：提供方行未激活时列表里没有 `cua_run_code`，前端未激活时不提供任何服务。客户端配置项由 README 给出，而不是由程序生成。

## 考虑过的替代方案

**通过 TypeScript SDK 启动 `dsh --profile sdk` 的 MCP 服务器。** SDK 协议没有不经模型回合直接运行工具的请求；补上它要改协议和两个 SDK 客户端，截图还要再跨一次进程边界。

**像 Codex 的 REPL 那样在 harness 之外的独立 CUA 服务器。** 授权、沙箱、日志、截图接入和 helper 生命周期都要重写。profile 内的服务器复用这些所有者，并仍是日后剥离的基础。

**带客户端 hook 的隐藏工具 `turn_ended`。** 它唯一的用途是把客户端的回合边界写进无人消费的日志；按键在程序结束时已经释放。

**为根 MCP 调用写 Session 事件。** 数据消费方只需要 MCP 结果；没有模型步骤的 `tool/call` 会虚构一个 Session 从未运行的步骤。

**暴露原始 `cua` 工具或程序沙箱提权。** 原始操作需要外部模型重新学习的逐方法 schema，提权需要该 profile 不具备的审批应答者。

**叠在 `dsh-base` 之上、禁用模型行的 profile 前端。** 组合出的 profile 带着约一百行没有消费者的插件：模型适配器、web 工具、子代理、压缩、遥测和会话管理。显式闭包只有四分之一，且在漂移时大声失败。

**用 `dsh plugin enable|disable` 子命令选中随附组合包。** 它在启动器里重复了插件管理器的仅改 manifest 选择，而且仍然产生以 base 为底的 profile；文档给出的 manifest 只有三行，不需要改启动器。

**由 app-boot 在首次 `dsh --profile cua-mcp` 时初始化的 `dsh.bundle.profile` 声明。** 它让首次启动零步可用，代价是为一个实验组合包在 manifest 新增字段，并在 app-boot、CLI `dsh plugin` 命令和插件管理器里加入 `shippedProfileTemplate` 查找；普通 manifest 只多一个有文档的步骤，且不触碰这些包。CUA 从实验状态毕业后，一条 `PROFILE_TEMPLATES` 条目就能得到同样的零步启动。

**为 `cua_run_code` 手写 MCP schema 与描述。** 第二份定义几天内就漂移了：描述 663 对 2,164 个字符，`description` 可选对必填。投影注册项去掉了这份副本；SDK 的 `registerTool` 只接受 Standard Schema 值，且不允许 `tools/list`、`tools/call` 与自定义 handler 混用，所以两个工具都走低层 handler。

**把 `cua` API 参考放进工具描述或服务器说明。** Claude Code 2.1.309 对 MCP 工具描述和服务器说明都只转发前 4,096 个字符并追加 `… [truncated]`，2026-11-10 用 20,000 个字符的探针文本测得；`dsh-mcp-client` 原样转发同一描述。参考约 13,000 个字符，因此作为工具结果传递，注册项 3,200 个字符的描述留在预算之内。

**把参考放在每个环境首个程序结果的开头。** 服务器观察不到模型保留了哪些结果：`dsh-mcp-client` 这类客户端用一个连接承载多次对话，被取消或失败的首次调用会丢弃其结果，上下文压缩之后这段文本也会消失。记录已交付的标志由程序调用和重置两处写入，二者没有共同的排序点。无状态的只读工具让缺少参考的模型自己去取；2026-11-11 的十五次探针对话中，经 `dsh-mcp-client` 的 DeepSeek 模型与 Claude Code 2.1.309 都在首个程序之前调用了它。

**在 PTC 程序工具工厂上提供 reset 操作。** 带 `reset(agent)` 的工厂句柄让工具执行器成为环境恢复的第二个所有者，清理失败后还带着自己的阻塞状态。程序运行时的 owner release 本来就能结束一个环境，同一所有者的下一次运行会启动新环境；前端串行化该连接的调用，因此由它这个调用方围绕释放来安排这些调用。

**reset 时更换连接的 Agent。** 新 Agent 意味着新 Session：本机连接关闭，会话授权要重新询问，拒绝记录也被遗忘，这正是重新连接的效果。reset 丢弃的是程序持有的东西；授权和本机连接属于连接，不是程序环境的一部分。销毁 Agent 时，如果正在运行的程序无法被中断，还要等待运行时的停止宽限期，默认三秒。

**`--print-client-config codex|claude-code|json` 选项。** 为当前安装渲染准确命令需要 `node:sea` 来区分单文件可执行程序与脚本启动，而打包全部可选组合包的浏览器 worker 镜像没有注册 `node:sea`；文档给出的配置项带有同样的超时与输出预算，不需要这项依赖。

## 后果

每个安装都携带该组合包；macOS 与 Windows 两个原生提供方是它的可选依赖，各由一行挂载，且只在对应的 Host 上加载，`verify-default-product-isolation` 让该组合包留在默认模板之外。把组合包叠在 `dsh-base` 之上的 profile 会出现重复的行 id，不受支持；Web 插件页通过 `HIDDEN_BUNDLES` 隐藏该组合包，而 Host 清单仍把它报告为可选组合包。没有提供方的 Host 列出 `cua_get_api_reference` 与 `cua_reset`，二者都指出缺少提供方，调用 `cua_run_code` 以 `unknown tool` 失败。客户端会在进程退出、`cua_reset` 或 Agent 销毁时看到状态丢失并重新创建对象。授权 elicitation 依赖 2025 版 MCP 请求模型；使用 2026-07-28 修订版的客户端改用 `allow`。工具描述、服务器说明与参考文本由 profile 的期望输出测试固定；程序工具的描述和参考随已安装的 CUA 包变化。模型只有调用 `cua_get_api_reference` 才能得到参考，因此不放行该工具的客户端，其模型只有执行规则可用。提供方描述超过 4,096 个字符时，Claude Code 的模型只看到被截断的部分。
