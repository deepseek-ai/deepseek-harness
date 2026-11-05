# Agent Note: Agent terminals in the Web sidebar

Status: implemented

[English](2026-10-12-agent-terminal-panel.md) | 中文

## 问题

DSH 原有两套互相看不见的终端。Agent 的[持久终端](2026-07-16-persistent-pty-sessions.zh.md)运行在私有 PTY 中，人既看不到也无法接管；[Web 侧栏终端](2026-09-09-web-sidebar-terminal.zh.md)属于人，Agent 无法访问。同类产品让 Agent 在人能看到的终端里运行命令，也能读取人看到的内容。Agent 启动的长时间进程（例如开发服务器）应当出现在人工作的地方，而且不需要新的模型工具或第二套权限模型。

## 决定

实验包 [`terminal-panel`](../../../../packages/experimental/terminal-panel/README.zh.md) 注册一个 `ctx.terminals` 后端，其会话就是通过[终端控制器](../../../../packages/api/terminal-controller/README.zh.md)打开的侧栏终端。6 个 `terminal_*` 工具的名称、schema 和结果都不变；[实验终端 bundle](../../../../packages/experimental/terminal-bundle/README.zh.md) 用这个后端替换 `terminal-bash`。

### 按创建者划分所有权

终端按打开者划分。Agent 终端记录 `origin: 'agent'`，初始为 `control: 'agent'`；人在浏览器中第一次键入的输入会把控制权交给人。浏览器只在键盘、粘贴、输入法、拖放、指针或触摸操作之后的短时间内把输入标记为键入，因为 xterm.js 通过同一个数据事件报告终端协议应答；焦点上报和滚轮产生的方向键从不计入，因此聚焦或滚动 Agent 终端不会接管它。接管之后，控制器拒绝 Agent 的写入、信号和关闭，读取照常可用，`terminal_close` 只释放注册表会话而不结束 shell。人自己打开的终端永远不允许 Agent 写入；`user_terminal_list` 和 `user_terminal_read` 读取它们，`readUserTerminals: false` 会移除这两个工具。

### 权限

Agent 终端按 bash 工具解析出的 Session 沙箱策略启动，控制器像 `terminal-bash` 一样通过 `ctx.sandbox` 包裹受限 shell。终端里的命令不能申请提权；指引让模型把被拒绝的命令改用 bash 执行。切换 Session 的沙箱模式既不会被阻止，也不会停止已打开的 Agent 终端，终端中的进程像 bash 后台任务一样保留启动时的策略。与后台任务不同，终端会持续接收命令，因此 Session 解析出的策略一旦不同，`terminal_send` 就拒绝输入并提示模型另开终端；读取、发送信号和关闭照常可用。用户终端沿用其自身决策中的[系统用户权限](../architecture/2026-09-16-user-terminal-permissions.zh.md)。子 agent 会被拒绝，因为它们的终端不会出现在人正在查看的 Session 中。

### 就绪判定与读取

后端不向 shell 启动过程添加任何内容，因为 SSH 等远程执行环境没有 Host 上的文件。输出静默、且 shell 的进程组或 provider 报告正在读取终端输入的程序占据前台时，一次发送返回 `stdin_read`；安静的命令变为 `inferred_idle`，忙碌的命令变为 `timeout`。在 macOS 上前台检查可能启动两次 `ps`，所以只在静默之后、以有界的频率执行。结果从一次发送所在逻辑行起点的标记开始，渲染控制器的 headless 屏幕；后台读取会把标记移过已消费的完整行。

### 呈现

控制器为每个 Session 推送终端列表。正在显示的 Session 会为每个尚未展示的运行中 Agent 终端打开侧栏标签页（侧栏折叠时会展开），并为 Agent 控制的终端标出徽标，接管后的受限终端则标出沙箱徽标，悬停可看到沙箱模式。仍由 Agent 控制的终端离开列表时，它的标签页随之关闭。

## 考虑过的替代方案

**人与 Agent 共用同一个终端。** 它能覆盖在原地重跑失败命令的场景，但输入交错、前台程序变化（例如 ssh 或 sudo 提示），以及在持有人登录状态、未受限的终端里运行 Agent 命令，都意味着每次写入都需要审批。读取人的终端、再在 Agent 终端里重跑，可以覆盖同样的场景。

**为可见终端新增一套工具。** 模型会看到两套重叠的终端工具。按创建者划分所有权，正好符合注册表“会话属于打开它的 Agent”的规则，因此一个后端就够了。

**把 `terminal-bash` 会话只读镜像到侧栏。** 这些 shell 使用受控提示符、`TERM=dumb` 和清洗后的行输出，没有可供 xterm.js 显示的屏幕，人既不能输入，Agent 也读不到人的终端。

**注入 shell 集成以精确判断命令完成。** 注入启动文件输出的提示符标记能给出精确的就绪状态和退出码，但这些文件必须存在于每个执行环境和沙箱内；静默加前台检查在 provider 能检查进程的任何地方都可用。

**沿用 Agent 在切换模式时的沙箱栅栏。** `terminal-bash` 在有终端打开时拒绝切换模式；对于人可能已接管的可见终端，这会无限期阻止权限变更；只统计 Agent 控制的终端，仍会迫使人在收紧权限前先关掉 Agent 的开发服务器。模式收紧时关闭 Agent 终端，则会结束人可能正在观察的进程。

## 影响

Agent 的长时间工作对人可见、可被人中断，人也可以直接让 Agent 查看自己的终端而不必复制文本。Agent 从人终端中读取的屏幕文本会进入 Session 日志和模型请求，由 `readUserTerminals` 开关控制。就绪判定是推断的：静默的 shell 内建命令会被当作 `stdin_read`，在 macOS 上等待输入的程序要到 `idleSilenceMs` 后才返回。被接管的终端无法交还，后端需要挂载终端控制器的 Web 或 Desktop 组合。

控制器与侧栏测试覆盖接管、键入识别、拒绝、读屏、标记和终端列表流；后端测试在假时钟上覆盖每种等待原因、取消、释放和子 agent 拒绝，集成测试通过注册表驱动真实 shell。`terminal-panel-tools` 快照记录了指引、schema 和用户终端结果。
