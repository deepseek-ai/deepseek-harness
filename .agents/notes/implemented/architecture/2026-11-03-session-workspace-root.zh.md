# Agent Note: Session workspace root

Status: implemented

[English](2026-11-03-session-workspace-root.md) | 中文

## Problem

进入 Git 工作树的 Session 只记录当前目录的变化。`working_directory` 工具在模型 `cd` 进子目录或离开项目时记录的是同一种事件，消费方因此无法区分模型移动的光标和已切换的检出：文件视图、变更汇总或写边界要么跟随每一次 `cd`，要么停留在原始项目。实际用法也不支持保留光标：在一位开发者的 58 个提供该工具的已记录 Session 中，模型在 6,229 次工具调用里只调用了它一次，61% 的 shell 命令自带 `cd` 前缀。

## Decision

一个 Session 在一个目录中工作，只有 Host 操作移动它。面向模型的 `working_directory` 工具与委派工具的 `cwd` 参数被移除；模型通过路径和 shell 的单次调用参数 `workdir` 到达子目录。`header.cwd` 仍是不可变的原始项目：Session 身份、工作区归属和恢复目的地。`dsh-working-directory` 拥有该目录。它通过 `set` 或 `ensure` 的恢复记录的每次变更都是 `workspace-root/change`，`workspaceRoot` 投影是最近一条这类事件的目录，在此之前是原始项目。因此从这个版本起启动的每个 Session 中，`rootOf` 都等于 `get`。

`workspace-root/change` 是新增的普通事件类型，作为同版本持久化变更记录在[确认记录](../../../../docs/persistence-changes/2026-11-13-workspace-root-change.zh.md)中。`working-directory/change` 保留在事件词汇表中，已标为 deprecated，没有写入方。已存储的这类事件写于模型还能移动目录的时期，它只移动当前目录，因此已存储的 Session 保持原有的根。旧版本拒绝含有 `workspace-root/change` 的日志；从未移动工作区的 Session 不含该事件。

工作树创建通过 `set` 进入检出目录。模型只有一个进入检出的工具 `enter_worktree`：名称在 Session 所在检出的池中选中一个工作树。已有的工作树通过 `ctx.worktrees.enter` 进入，没有同名工作树时通过 `ctx.worktrees.create` 新建。名称无法离开该池，因此模型仍然不能选择任意目录。`ctx.worktrees.exit` 以 `exit_worktree` 的形式提供，它找到包含 Session 目录的已记录工作树，把 Session 送回创建或进入该工作树时所在的检出。子代理的 header 保留父级的原始项目，并通过 `set` 从父级的工作区根或 Host 选定的目录启动。

消费方按感知目录的对象划分。模型的文件、搜索与进程工具从当前目录解析相对路径。用户看到的、以及描述项目的一切都读取工作区根：沙箱 `workspace-write` 边界、工作区文件服务与桌面文件拖拽、变更记录器、文件树、交付物、在应用中打开操作与 Session 行、新开的侧栏终端、`@` 文件候选、技能目录、项目指令发现和 LSP 工作区。两者是同一个目录，只有含有 `working-directory/change` 事件的 Session 例外。

沙箱策略通过执行环境的文件系统，从根的 `.git` 指针推导出链接检出目录的公共目录并加入解析出的额外可写根，只接受 Git 写出的布局：`<common>/worktrees/<name>`，其 `commondir` 指向 `<common>`、`gitdir` 指回检出目录的 `.git`，因为检出目录自己的指针在 `workspace-write` 下可写。根的结果读取后即保留，在 Host 操作把某个 Session 的工作区移到该根、或已推导目录消失时刷新；工具执行等待该推导完成，会话创建与目录变更提前启动它，推导出的目录不进入模型可见的策略文本。在 Windows 上，推导出的目录遵循[文件工具授权决策](2026-10-29-windows-file-tool-directory-grants.zh.md)：`write` 与 `edit` 执行它们，进程限制保留工作区与私有临时目录授权。移入工作树之后，原始项目只能通过 Git 管理目录写入，不再整体可写。Host 对 Session 并不在其中工作的检出目录做维护时保留原来的边界：归档时移除 worktree、恢复被删除的 worktree、在源仓库中读取其分支，都在 Session 的策略下以记录中的源检出目录为根运行，通过 `resolve({ session, root })` 请求；Session 自身的根可能正是被删除的目录，而进程沙箱无法绑定缺失或正在消失的根。

## Alternatives considered

**保留光标，从已登记的锚推导根。** 在变更上增加可选的 `anchor`、维护锚列表并取包含目录的最长锚，可以区分模型的 `cd` 与检出切换，代价是三个目录、一个重定位操作和一条子会话继承规则。移除唯一面向模型的移动入口之后，这种区分不再必要。

**从工作树插件的创建记录推导根。** 该记录是可忽略的实验性插件记录，格式迁移只尽力保留；已发布的包不能据此推导写边界。

**重定位时改写 header。** header 是存储、归属与权限根使用的身份元数据；[工作目录记录](2026-09-13-session-working-directory.zh.md)已否决改写它。

**在 `working-directory/change` 上增加可选的 `workspace` 标记。** 旧读者忽略该属性，仍能读取所有日志。但服务记录的每次变更都要带一个恒定值，缺少属性成为识别已存储变更的唯一依据；单独的事件为工作区移动命名，并让已存储的事件保持不变。

**通过格式迁移退役 `working-directory/change`。** 已存储的事件不带来源，迁移只能依据相邻事件逐条分类，而已存储的模型 `cd` 仍需要一种只移动目录的记录。[兼容性规则](../../../../docs/persistence-changes/README.zh.md#compatibility-rules)只在现有判别符无法保证安全时才要求升版本。

**按路径进入工作树。** 模型提供的路径会把写边界移到任意已登记的工作树，除非用户逐次批准，否则这正是移除目录工具所排除的。`tools/pre-execute` 监听器可以通过审批服务请求这一批准；本决定把路径形式，以及随之而来的“从工作树内进入同级工作树”，留给之后的变更。池内的名称把边界留在检出之内。

**创建与进入各用一个工具。** `create_worktree` 与 `enter_worktree` 并存时，模型为“进入工作树”这一个动作面对两个工具，还要按工作树是否存在来选择。单一工具与 Claude Code 的 `EnterWorktree` 一致，后者创建工作树，或打开同名的已有工作树。在一位开发者提供过 `create_worktree` 的 79 个已记录 Session 中，模型在 6,599 次工具调用里只调用过它一次，因此移除这个名称影响的已存储 Session 很少。

**在调用之间保留 shell 的 `cd`。** 这是一个隐式的光标。在该开发者的 Session 中，68% 的 `cd` 前缀指向 Session 目录之外，30% 指向 Session 目录本身，限制在工作区内的保留只对约 2% 生效。

**把已存储的变更读作工作区移动。** 已存储的模型 `cd` 会收窄或移动现有 Session 的写边界；缺少某项特性的日志保持旧行为。

## Consequences

消费方读取一个目录：相对路径用 `get`，属于工作区的一切用 `rootOf`。两者只在含有 `working-directory/change` 事件的 Session 中不同，下一次 Host 移动会让它们重新一致。读者继续把该事件折叠为只移动目录的变更，因此以后增加光标不需要改格式。模型只能通过 `enter_worktree` 进入检出：新建的检出，或池中已登记的检出。其他位置的检出需要 Host 操作。ACP、SDK 与 Web 的生产方以规范拼写记录原始项目，因此 Host 移回原始项目时不记录变更。在链接工作树内打开的 Session 可以在 `workspace-write` 下运行 `git commit`，共享的 `.git`（包括其钩子与配置）对该 Session 可写，正如它对主检出目录中的 Session 一样。SDK 的 `setWorkingDirectory` 调用以及在 Host 选定目录启动的子代理，会让 `workspace-write` 边界随目录一起移动。工作树快照夹具覆盖进入、离开和失去工作树。
