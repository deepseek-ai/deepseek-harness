# Agent Note: 跨家族文件沙箱——统一策略归属、沙箱化 fs 提供方、fs 升级对等

Status: implemented

[English](2026-07-14-cross-family-fs-sandbox.md) | 中文

## 问题

`SandboxMode` 所声明的语义涵盖文件系统效果，但最初只有 `ctx.shell` 强制执行该策略。fs 工具（`write`/`edit`）在进程内经由 `ctx.fs` 变更宿主文件系统，那里的 OS argv 包装在机制上毫无意义——[沙箱 Agent Note](2026-07-06-sandbox.zh.md) § 进程内工具记录了这一点，并把跨家族强制执行留作一个暂缓阶段，附带一个未决问题：进程内强制执行是各 seam 各自表达，还是变成一个统一的 harness 能力。本 Agent Note 就是那个阶段，并给出答案：一个共享的策略归属，在每个家族各自正确的层级上做 per-seam 强制执行。

这个缺口并不只有 read-only 一种形态。一个受限编码 agent（智能体）的产品模式是 `workspace-write`：bash 已经可以在工作区根目录下写入，而其外的一切都被拒绝，所以只能全部拒绝的 fs 强制执行会严格劣于禁用 fs 工具——模型会尝试在工作区内 `write`，被拒，然后学会绕道 `bash` heredoc。因此跨家族强制执行必须涵盖完整的模式阶梯，包括 `workspace-write` 要求的路径包含判定（规范化目标；`..`/符号链接/绝对路径逃逸），以及与 bash 相同的升级手段。

第二个强制执行家族还暴露了原布局中的一个归属问题。部署默认值（`mode` + `workspaceRoot`）配置在 `dsh-bash-sandbox` 上，而 per-session 覆盖事件是 `shell/sandbox-mode`，由 `dsh-shell` 的 session-mode 工具集折叠与写入。当 fs 强制执行同一套策略时，要么 fs 读取 bash 的配置与事件（一个能力家族依赖同级插件的配置），要么各家族各持一份副本——两份 `workspaceRoot` 会漂移进沙箱 RFC 警告过的割裂世界：bash 受限于一个根，而 fs 围住另一个根。

## 决策

三个相互协调的部分全部在叶子 `cordis.yml` 中组合，均不触及 `agent-loop`。

### `ctx.sandboxPolicy`——mode 与工作区根的统一归属

`packages/sandbox/sandbox-policy/`（`@deepseek-ai/dsh-sandbox-policy`）注册 `ctx.sandboxPolicy`，即部署沙箱策略的唯一所有者：

- `Config`：`mode`（封闭的 `SandboxMode` 联合，默认 `read-only`）与 `workspaceRoot`（默认进程 cwd，解析为绝对路径）。配置错误会在加载时明确报错。
- per-session 覆盖事件 `sandbox/mode`，由本包注册在必需注入的 `ctx.sessionProjections` 注册表上的 `sandboxMode` 投影单元折叠（`stateVersion` 1、host-only；`stateOf(session, 'sandboxMode')` 即 host 读取），连同它的写入路径（`setSandboxMode(session, mode)`）与 `SANDBOX_MODES`。该事件是策略状态——被两个家族消费——所以它归于此处，而不归于任一能力的 seam。它的形状与仅日志（log-only）语义遵循 `approval/*` 的先例，且贡献方与读取方都必需注入 `sessionProjections`（[必需投影 seam](../architecture/2026-08-19-session-projection-mandatory-seam.zh.md)）。
- `resolve({ session?, mode? })` 返回完整的单次调用 `SandboxExecutionPolicy`：显式批准的模式 > 会话的投影覆盖 > `defaultMode`，而会话中不可变的 cwd > 配置的 `workspaceRoot` 回退值。
- 保留 `defaultMode` / `workspaceRoot` 访问器，作为部署回退值与能力宣告依据。

`dsh-bash-sandbox` 自身不再携带任何沙箱配置——它注入 `sandboxPolicy`，仅在直接调用时使用其中的部署回退值。`dsh-tool-bash` 与 `dsh-tool-fs` 把当前会话传给 `ctx.sandboxPolicy.resolve()`，因此两者每次调用都会取得相同的生效模式与 cwd 根目录；`dsh-permission-presets` 预设与 ACP（Agent Client Protocol）bridge 经由迁移后的 setter 写入。拥有 bash 与 fs 执行的 seam 仍不依赖会话——会话依赖归策略包与工具消费方所有。

### `dsh-fs-sandbox`——在提供方内部强制执行

`packages/fs/fs-sandbox/`（`@deepseek-ai/dsh-fs-sandbox`）镜像 `bash-local`/`bash-sandbox` 的拆分：`SandboxedFileSystem extends LocalFileSystem`，注册为 `ctx.fs`，注入 `sandboxPolicy`。读取（`resolve`/`stat`/`readText`/`streamText`/`listDir`）原样透传——每种模式都允许读。两个变更操作在委托给继承来的原子写之前按模式强制执行：

- `read-only` 直接拒绝 `writeText`/`editText`。
- `workspace-write` 把规范化后的目标围栏于可写根集合——`dsh-sandbox` 中的 `writableRoots(policy)`：工作区根加上平台临时目录（`/tmp`、`os.tmpdir()`），各自 realpath——与 Seatbelt profile 授予的是同一个集合，所以 fs 围栏是这一个模式含义在 bwrap/Landlock/Seatbelt profile 之外的第四种方言，因此不会出现「write 工具不能写 `/tmp` 而 bash 能」的不对称。规范化路径写法采用词法包含的快速路径；当 Windows 以大小写不同的路径、长文件名或 8.3 短文件名表示同一目录时，系统会逐级遍历祖先目录并比较文件系统身份，而不会把边界弱化为依据文本前缀猜测包含关系。目标在委托前被立即重新规范化（`resolve` 对最深的既有祖先做 realpath），因此自工具解析该目标以来被换出的祖先符号链接会被捕获。
- `danger-full-access` 不加围栏地委托。

拒绝是结构化的 `FS_SANDBOX_DENIED`，携带生效模式——区别于 `FS_PERMISSION_DENIED`（宿主 EACCES 是世界在拒绝；这里是策略在拒绝）。无文本推断：进程内围栏确切知道它拒绝了什么。per-call 载体是 `writeText`/`editText` 上一个末尾可选的 `SandboxExecutionPolicy`（文件系统侧对应 `ShellExecRequest.sandboxPolicy`）；该 seam 保持无会话依赖，而裸的本地后端会忽略它。`FileSystem.sandboxMode` 是能力事实（在基类与 `fs-local` 上为 `undefined`，在 `SandboxedFileSystem` 上为默认值），所以工具层按组合真相来宣告升级。

威胁模型写在包 README 里：一道位于可信代码中、针对模型可控路径的策略围栏，而非内核边界——操作是 seam 自身的，只有目标路径不可信，所以「先规范化再判包含」足以完整覆盖这一调用面（`ptc-runtime` 的「containment, not a security boundary」先例）。对不可信代码的内核级隔离仍是 `ctx.shell` 的职责。resolve 到系统调用之间残留的竞态被就地重新规范化收窄，只有平台原语（`openat2` `RESOLVE_BENEATH`）能彻底消除它，而在此不值得为其付出可移植性代价。

### 工具对等——一个拒绝标记、一条升级流程

`dsh-tool-fs` 把当前会话解析成完整策略，并传给每次变更，同时将 `FS_SANDBOX_DENIED` 映射为模型已从 bash 认识的标记：`[sandbox: file access denied under <mode> mode]`。当 `ctx.fs.sandboxMode` 在注册时报告一个受限模式，`write` 与 `edit` 宣告相同的 `sandbox_permissions` + `justification` 字段，向模型说明同样的同一轮次重试方式，并在执行前处理同样的 `ctx.approval` 请求——四种结果及其逐字的 fail-closed 文案沿用自[沙箱 Agent Note](2026-07-06-sandbox.zh.md) § 升级（执行时根据调用的生效模式检查是否严格加宽；授权只改变当前调用的模式，并保留其会话根目录；不产生任何新会话事件）。

共享部分住在 `dsh-sandbox`，它拥有模式类型：`WIDER_MODES`、升级目标枚举、参数配对校验、拒绝/提示标记构造器，以及 `approveEscalation`——有序的 fail-closed 编排。`approveEscalation` 接收一个最小的结构式 approver（`EscalationApprover`，对 agent 与 call-id 类型泛型化），而非审批服务类型，所以 `dsh-sandbox` 不获得对 approval 或 agent 包的依赖：每个工具把自己的 `ctx.approval`、agent、call id 与工具名作为原料传入。`dsh-tool-bash` 与 `dsh-tool-fs` 都使用它们；跨文件重复检测门禁确保单一来源不走样。

[base profile 组合](../../../../packages/bundle/base/cordis.patch.yml)加载 `dsh-sandbox-policy` 与 `dsh-fs-sandbox`，把 `mode`/`workspaceRoot` 配置留在策略条目，并让 `fs-observation-policy`（read-before-edit）正交地叠加其上。系统提示仍然不陈述沙箱模式——标记会在真正重要的那一刻教会模型边界，遵循沙箱 Agent Note 所述的实时证据原则。

### 强制执行点：提供方，而非 intent gate

沙箱 Agent Note 最初的跨家族草图把 fs 强制执行放在 `fs/write-intent`/`fs/edit-intent` 事件上。本 Agent Note 改为在提供方中强制执行，基于两个机制性事实：intent slot是单决策、先到先得（已被 `dsh-fs-observation-policy` 占据，其约定明确规定，出现第二个决策者即属配置错误），且 intent 事件只由 `dsh-tool-fs` 派发——一个直连 `ctx.fs` 的调用方（一个 Cordis 挂载插件、一个自定义工具）会绕过它们，而提供方级强制执行按构造覆盖每一个调用方。

### 范围之外

- **`ctx.web` 的网络策略**——`SandboxMode` 所声明的语义只涵盖文件系统效果；在 bash `curl` 畅通时给一个仅限 web 的网络旋钮会是一道假边界。待某个 bash 后端能强制执行网络策略（bwrap `--unshare-net`、Landlock ABI v4+）时再议。
- **`subagent-acp` 消费方**——沙箱 RFC 中未变的延后阶段。
- **单个会话中的额外可写根目录**——解析后的策略携带一个主要 `SessionHeader.cwd`；ACP `additionalDirectories` 仍是独立的 bridge 与策略设计问题。
- **统一的 per-tool 沙箱运行时**——因沙箱 RFC 中的理由继续否决。

## 考虑过的替代方案

- **在 `fs/*` intent 事件上强制执行（沙箱 Agent Note 的原始草图）**——因 § 强制执行点 中的两个机制性事实被否决：单一 slot、先到先得且已被占据，以及对直连 `ctx.fs` 调用方的绕过。提供方级强制执行覆盖每一个调用方，并镜像 bash 的换实现形态。
- **在 `tools/pre-execute` 中执行**——否决：监听器在 `resolve()` 之前看到模型的原始路径字符串，因此它会重新实现 cwd 默认化与符号链接规范化，并且仍与真正的 resolve 竞态。这使其不适用于 `workspace-write`，因为后者需要对规范路径作出判定。
- **在 `dsh-tool-fs` 中做内联检查**——否决：只覆盖工具路径（与 intent 事件同样的绕过），并在规范目标已存在之上重复了一层 resolve 知识。
- **在 `dsh-fs-local` 上加一个 `mode` 标志而非同级后端**——否决：能力事实必须是组合真相，正如 `dsh-bash-local` 对 `dsh-bash-sandbox`；一个配置标志会让工具的宣告取决于配置，而 bash 家族已经确立了同级包形态。
- **经受限 helper 子进程做内核级 fs 变更**——否决：每次写入都要启动一个进程；`editText` 的读-匹配-写临界区不得不整体搬进子进程才能保持原子；而威胁面（可信操作、不可信路径参数）不需要内核——可信代码中的围栏就是完整答案，而不可信代码隔离仍在 `ctx.shell`。
- **带加载期一致性校验的 per-family 策略配置**——否决：一个事实两个归属，靠一个必须枚举每个未来的强制执行家族的校验来打补丁；策略服务让漂移不可表达，而非被检测到。
- **把覆盖事件留在 `dsh-shell` 里作 `shell/sandbox-mode`**——否决：该事件是被两个家族消费的策略状态；保留 bash 命名会迫使 `dsh-fs-sandbox` 依赖 bash 词汇。预发布阶段，该改名是同一变更内的迁移，附带快照重录，无任何 shim。
- **把升级编排从 approval/agent 包导入 `dsh-sandbox`**——否决：那会倒置分层（一个基础词汇包依赖 UI/agent 包）。结构式 approver 让逻辑单一来源于 `dsh-sandbox`，而依赖留在本就持有它们的工具层。
- **fs seam 上一个合并的 mutation-options 对象**（per-call 载体最初草拟的形状）——因摩擦被否决：它会把 `signal` 拆进变更专用的选项包，而读取仍保持位置参数。一个末尾可选的 `SandboxExecutionPolicy` 匹配 bash 的携带并忽略模式，并使 `signal` 在整个 seam 上保持对称。
- **在 `SandboxPolicy` 上增加额外的可写根授权**——照旧延后：`writableRoots()` 由既定模式含义推导；临时授权是沙箱 RFC 留下的升级作用域问题。

## 后果

已交付的部分——§ 测试的各层各自钉住：

- 在 `read-only` 下，`write`/`edit` 返回 `[sandbox: file access denied under read-only mode]` 标记，磁盘不受触动；`read`/`listDir` 与 `dsh-fs-local` 行为一致。
- 在 `workspace-write` 下，变更落在工作区根与临时目录下，其外被拒；包含矩阵——`..` 穿越、指向外部的绝对路径、一个既有的、指向外部的工作区内符号链接目录、在这样一个符号链接下新建的文件，以及根路径的等价别名形式——在真实磁盘上拒绝每一种逃逸，同时允许文件系统认定为同一目录的路径。
- 一个被拒的 fs 变更，携带 `sandbox_permissions` + `justification` 重试一次，会经组合的审批链提示；一次授权让恰好那一次调用在更宽的模式下运行且写入落盘；rejected/cancelled/unavailable 各自产生其逐字的 fail-closed 文案且不做任何变更。
- 一次 `permission` 预设切换同时管辖两个家族：会话切换模式后，下一次 bash 调用与下一次 fs 变更都从同一个 `sandboxMode` 投影遵循新模式。
- cwd 根目录不同的并发会话通过同一组服务实例携带不同策略；两个家族都不会缓存某个会话的根目录供下一次调用使用。
- 一次无 per-call 盖章的直连 `ctx.fs.writeText` 会被围栏于部署默认值。
- `write`/`edit` 上的升级字段恰好在被挂载的 `ctx.fs` 受限时存在，在 `dsh-fs-local` 下不存在。
- `agent-loop` 未被触动——一切都依托于 `ctx.sandboxPolicy`、`ctx.fs` seam、`SessionEventMap` 合并以及工具执行流水线。

代价与接受的限制：

- **fs 围栏是策略边界，而非内核边界。** 它的威胁面是模型选定的路径，而非对抗性宿主进程；resolve 到系统调用之间残留的 TOCTOU 被收窄而非消除，README 已如实声明。内核边界仍属 bash。
- **`dsh-bash-sandbox` 获得对 `ctx.sandboxPolicy` 的硬依赖。** 每个沙箱化组合要么加一个 `cordis.yml` 条目，要么在加载时明确报错——这是有意的预发布奠基之举；示例在同一变更内更新。
- **围栏与 runner 的对等是推导出来的，而非断言的。** fs 围栏与 Seatbelt profile 都从 `writableRoots` 取其可写集合，一个对等单元测试钉住这些集合；一个 runner profile 若在不经该函数的情况下改变其可写集合便会漂移。
- **标记与升级教学如今服务于两个家族。** 措辞改动是 `dsh-sandbox` 中一个构造器背后的协调编辑；重复检测门禁与钉住的快照维持单一来源，代价是 fs 与 bash 无法在不拆分该构造器的情况下有意地在措辞上分道。

## 测试

- 单元：`dsh-sandbox` 钉住升级阶梯、标记构造器、参数配对校验，以及 `approveEscalation` 的有序 fail-closed 序列（非加宽、无 approval、无 agent、各结果），外加 `writableRoots`/`canonicalPath`。`dsh-sandbox-policy` 钉住部署回退、会话模式/根目录解析、显式模式优先级、`sandboxMode` 投影单元的折叠与 setter、加载期模式拒绝，以及 HMR（热模块替换）安全。`dsh-fs-sandbox` 在真实文件系统上钉住按策略执行的围栏与包含矩阵（内部、临时目录、绝对路径-外部、`..`、指向外部的符号链接目录、其下的新建文件、路径等于根、文件系统根、以分隔符结尾的根、等价别名形式），外加 per-call 覆盖与 HMR 安全。`dsh-tool-fs` 钉住宣告门控、完整策略解析、拒绝标记映射，以及完整的升级矩阵（授权、拒绝、无服务、无 agent、配对、非受限守卫）。`dsh-tool-bash`、`dsh-bash-sandbox` 与 `dsh-permission-presets` 使用同一套策略工具集。
- 无密钥 e2e：一个真实 Cordis 上下文创建两个 agent，其会话的 cwd 根目录各不相同；系统并发运行正式发布的 bash 与 fs 工具，再通过外部可观察结果验证各自在所属项目中的写入成功，而两次跨项目写入都被拒绝。
- 快照：acp-agent 示例组合 `dsh-sandbox-policy` + `dsh-fs-sandbox`；被钉住的 header 携带 fs 升级字段与 `sandbox/mode` 事件名，一次性重录。
