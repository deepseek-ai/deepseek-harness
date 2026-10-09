# Agent Note: 共享 agents 根目录加入用户全局指令链

Status: implemented

[English](2026-10-05-shared-agents-root-instructions.md) | 中文

## 问题

DSH 只加载一个用户全局指令文件：`$DSH_HOME/AGENTS.md`。同时使用多个 agent 工具的人，会把跨工具共享的指令放在共享 agent 配置根目录（`~/.agents/AGENTS.md`，或 `$DSH_AGENTS_HOME`）——`dsh-skill-filesystem` 已经在该根目录下扫描 skill。这些指令只有被复制或 symlink 到 harness home 之后才能进入 DSH，这会把唯一真源复制进 DSH 自有数据，也让人无法判断会话加载的是哪一份。

## 决策

用户全局指令 scope 有两个有序根目录：先是 `$DSH_HOME/AGENTS.md`，然后是 `<agentsHome>/AGENTS.md`。指令加载器从 `$DSH_HOME` 或 `~/.dsh` 解析 harness home，从 `$DSH_AGENTS_HOME` 或 `~/.agents` 解析 `agentsHome`。`dsh-home-paths` 中的 `resolveAgentsHome` 与 `agentsHomeDisplay` 为 `dsh-agent-instructions` 和 `dsh-skill-filesystem` 共同负责该解析，因此共享根目录只有一个解析器，其波浪号展开与空白环境变量处理都与 harness home 一致。

这两个文件是同一个候选组中的候选：按去除首尾空白后的内容去重，完全相同的副本只从 harness home 渲染一次，候选不可观测时保留该组最后一次成功状态。预算保留内容的重复候选仍参与对账，因此保留的候选被删除或改变时它会被提升为可见；字节预算省略会让该候选及其内容重复项不再被探测。harness home 文件保留更早会话记录过的 `user-global` scope key；共享文件使用 `agents-global`。对账在恢复会话时会探测两个根目录，因此外部编辑、移除或新建文件都会表现为变更通知，而不会重新生成基线。

用户全局 scope 目录是对账用的内部 key，因此不会进入模型可见文本：全局增量声明 `These user-global instructions apply to all work.`，而不指名 scope 目录；首段路径与 scope 目录同名的项目路径会带前导 `.` 渲染，从而保留自己的 scope。

根目录顺序由 `USER_GLOBAL_DIRECTORIES` 固定，发现、基线对账与去重都按它迭代。因此由 harness home 决定内容重复项，并在基线中保持自己的位置；共享根目录中内容不同的文件排在其后。

## 备选方案

**用共享根目录替换 harness home 文件。** harness home 存放 DSH 专有配置，其 `AGENTS.md` 是该包当前记录、测试并渲染的用户全局文件。移除它会剥夺跨工具共享指令者的 DSH 专有层，也会让记录了 `user-global` 状态的会话失去指涉对象。

**仅当 harness home 文件不存在时才加载共享根目录。** 这样两个文件会轮流充当会话可见的用户全局文件，使 DSH 专有文件静默压制共享文件，而不是与之组合。

**把共享文件作为 harness home 中的第二个候选名加载。** `instructionFileCandidates` 命名的是同一个目录内的文件；这两个根目录是不同目录，因此该选项无法表达这条指令链，除非重新定义候选语义。

**重复项改用路径标识而非内容判断。** 常见布局是把 `$DSH_HOME/AGENTS.md` symlink 到 `~/.agents/AGENTS.md`，这是同一个文件的两个路径。路径标识无法丢弃其中任何一个，同一段文本会以两个显示标签渲染两次。

## 影响

- 共享指令无需复制或 symlink 即可加载；symlink 布局仍然只从 harness home 渲染一次。
- 在此变更之前启动的会话，若共享文件存在且内容与 harness home 文件不同，会收到一次变更通知。
- `dsh-agent-instructions` 不暴露 `dshHome` 或 `agentsHome` 配置字段；它的两个根目录属于进程策略。`dsh-skill-filesystem` 保留显式 home 字段，用于选择该提供方自身的 skill 根目录。
- 探测失败时两个用户全局文件共享同一命运：整个组一起保留最后一次成功状态，因为决定哪个成员渲染的是同一个 digest。
- `packages/context/agent-instructions/tests/agent-instructions.spec.ts` 固定了两个根目录的顺序、内容去重、保留候选改变或消失后的重复项提升、全局增量措辞、`replace` 与 `remove` 变更、`$DSH_AGENTS_HOME` 解析、`~/.agents` 显示标签，以及转义后的项目目录名。
