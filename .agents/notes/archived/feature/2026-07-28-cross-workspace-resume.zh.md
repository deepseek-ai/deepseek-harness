# Agent Note: 跨 workspace 会话恢复

Status: implemented
Archived: 2026-09-04

[English](2026-07-28-cross-workspace-resume.md) | 中文

## Problem

`/resume` 只能触达在启动目录中创建的会话，因此要回到昨天在另一个项目里的工作，就得记住它的路径、退出 TUI、再到那里重新启动。造成这一限制的原因有两个，彼此独立，只修其中一个都不会有任何变化。

存储是那个决定性的原因。已交付的 TUI 组合把持久化根默认成相对路径 `./.sessions`，于是每个启动目录都独占一份互不相交的 JSONL 根目录，以及一份互不相交的派生 `session-query.db`。来自另一个项目的会话并不是在列表中被过滤掉的——它们根本不存在于列表读取的存储中。JSONL 后端本来就会在*同一个*根目录*内部*按 cwd 分区，所以分区被叠加了两层：一层按根目录，一层在根目录内部。

接着选择器又过滤了一次。它在展示前丢弃 `cwd` 与当前会话不同的记录，而 `summarizeResumeCandidate` 又独立地把不同的 `cwd` 标记为 `disabledReason: 'different workspace'`，于是一个确实进入了存储的外部会话既被隐藏，也会被拒绝。

最后，恢复流程从不切换目录。宿主通过 `process.execve` 重新执行 `dsh --resume=<id>`，而它会继承 cwd。会话*头部*的 cwd 会从日志中还原，但 `dsh-fs-local`、bash 执行器以及 glob／grep 解析路径时依据的是进程 cwd，所以恢复一个外部会话会在回放它的 transcript（文本记录）的同时，作用到错误的项目上。

## Decision

共享 CLI（命令行界面）配置提供 Harness home 下的同一个会话根目录，选择器获得 workspace 范围，交接过程携带目标目录。

**存储。** 共享 base 在 `apps/cli/config/base.cordis.yml` 中拥有默认值：其 `session-persistence-jsonl` 配置项调用由 app-boot 提供的 `dshHomePath('sessions')`，该函数使用规范的 `DSH_HOME` 解析器及其标准的 `~/.dsh` 回退值。因此 TUI、Web 与 headless 使用同一个默认值，无需针对会话的启动器补丁或 slot。若 overlay 或个人 patch 显式声明根目录，它会整体替换该配置项的 `config`，并继续作为部署的权威选择。

**是范围，不是排除。** 当前 workspace 之外的 workspace 是一种展示范围，而不是禁用理由。`showResume()` 汇总每一条记录，`ResumePicker` 持有一个 `'workspace' | 'all'` 的 `scope`，默认为当前 workspace，因此常见场景毫无变化。Tab 切换范围；范围行会说明当前生效的范围，以及另一个范围下的数量；在全 workspace 范围中每一行都报告自己的 workspace，而该标签只在展示它的范围里才加入可搜索文本。切换范围会清空查询和选中项，使高亮行始终属于可见列表；而逐行的 workspace 行会让该范围下的每一行在终端里多占一行，可见条数预算已经把这一点计入。

因此 `summarizeResumeCandidate` 去掉了 `'different workspace'`，并新增 `'session has no recorded workspace'`。这是一条真正新增的拒绝理由，而不是改名：没有 `cwd` 的头部没有指明任何目录供宿主进入，所以即便它的日志完好也无法完成交接。

**交接。** `TuiResumeHost.handoff` 在 `SessionId` 之外还接收目标 `cwd`。`preflightResume` 把两者一起解析并一起返回，因此调用方无法从它展示过的那一行里重新推导出一个陈旧目录——在列表展示与预检之间 `cwd` 发生了变化的记录，会在*重新读取到的*目录中恢复，这也是原先「拒绝发生变化的 cwd」的行为如今变成携带新路径完成交接的原因。已交付的宿主在 dispose（资源释放）应用之前切换目录：不可达的目录必须在调用方还能恢复终端时就拒绝，因为拆卸之后已经没有任何所有者可供汇报。恢复始终使用默认的 `dsh --resume` 接口，因为 `meta` 会拒绝父级选项；交接过程已经进入持久化保存的目标目录。

## Alternatives considered

**从 `dsh` 启动器给 `persistenceRoot` 打补丁，而不是改动组合包默认值。** 在发现 loader 补丁会整体赋值 `config` 之后否决。个人的 `~/.dsh/config.yaml` 覆盖层已经用一份局部配置给 `tui-agent` 那一项打了补丁，这恰恰就是 `persistenceRoot` 一开始会退回到组合包默认值的原因；启动器补丁要么会被该覆盖层擦除，要么必须压过它，从而让覆盖层再也无法设置这个字段。把默认值放在组合包里能经受任何局部补丁，并让这项事实只有一个归属。

**保留 `./.sessions`，并额外扫描 Harness home 根目录。** 否决：两个根目录意味着两份 SQLite 索引，以及一份合并列表——其中各行的活跃状态与版本权威来源并不相同，而这一切只是为了保住不做迁移的决策本就已经放弃的那部分日志可见性。

**把现有的项目本地日志迁移到共享根目录。** 被需求方否决。项目 `./.sessions` 下的会话仍留在磁盘上，从该目录显式执行 `dsh --resume <id>` 仍可恢复，只是不再出现在 `/resume` 中。

**把所有 workspace 铺成一个扁平列表。** 否决：这会丢掉绝大多数场景想要的「本项目」默认值，而在一个繁忙的 home 目录里，当前项目的会话会和无关会话争夺注意力。

**让宿主从还原后的会话头部推断目录。** 否决：会话头部是面向模型与提示词的状态，在启动*之后*才还原，而目录必须在 `execve` *之前*进入。显式传递它能让这个顺序在 seam 处保持可见。

## Consequences

- 已经存放在项目本地 `./.sessions` 下的会话会从 `/resume` 中消失。这是不做迁移所接受的代价。
- 恢复一个会话可以改变进程的工作目录，因此恢复外部会话不是单纯的 transcript 还原——每个解析路径的工具都会随之移动。
- Harness home 现在保存着这台机器上每个项目的会话日志。它的增长不再受单个 checkout 约束，而本记录也没有引入任何保留策略。

## Testing

TUI 测试覆盖默认范围隐藏其他 workspace 但报告其数量、Tab 显示它们并带上逐行 workspace 标签、再按 Tab 返回时清空查询与选中项、按 workspace 标签搜索、无 cwd 的记录仍可见但不可选，以及交接同时收到 id 和在预检时重新读取到的 workspace。原先「拒绝发生变化的 cwd」的用例现在断言交接携带新目录。构建后的 CLI PTY 测试会检验共享配置默认值与每进程派生的查询索引。无密钥 TUI 快照固定选择器的两个范围，包括范围行、逐行 workspace 行，以及页脚中的 Tab 提示。手动执行的一次跨 workspace 恢复在进程层面验证了替换后进程的工作目录变为目标 workspace。
