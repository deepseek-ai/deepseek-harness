# Agent Note: 会话头部单一任务列表——jobs 与 activity 只在 UI 投影层合并

Status: implemented
Archived: 2026-09-03

[English](2026-08-25-unified-task-list.md) | 中文

Superseded: 本文描述的双名册 join 已随 activity seam 一并移除——job 行现在就是完整名册；见 [jobs 吸收 record](../architecture/2026-09-01-jobs-absorb-activity-record.zh.md)。

## 问题

[activity 观察面](2026-08-24-activity-observation-seam.zh.md)的 Web 呈现落地为[后台任务列表](2026-08-08-web-background-job-display.zh.md)旁边的第二个会话头部按钮。一次后台 bash 会同时登记在两个面里——`ctx.jobs` 负责控制、`ctx.activities` 负责观察——于是同一份工作渲染了两次：一次在"后台任务"里带生命周期与时长，一次在"活动"里带可展开的实时输出。两个行集合高度重叠、名字却不同的近似弹层，读起来像产品事故；而活动列表的扁平行（live 与 settled 混排、单行、无时长）也缺乏视觉层次。

## 决策

服务面保持正交；合并只在 UI 投影层逐行发生一次。

- **`ctx.jobs` 与 `ctx.activities` 仍是两个服务。** jobs 是控制面：模型可见的 id、模型消耗式的 `readOutput` 游标、`stopping`、`kill` 与 `reported` 完成通知契约。activity 是瞬态观察面：非消耗式绝对偏移、模型不可见、重启即无。合并服务会迫使一个注册表同时携带消耗式与非消耗式两种游标，并模糊这个刻意不进 session log 的面与"模型可见 ⟺ 已记录"不变量的边界。
- **`dsh-client-ui-activity` 渲染唯一的合并列表；`dsh-client-ui-jobs` 删除**（预发布阶段，不留兼容层），合并入口占用原 job 列表的 slot 顺位。每个 `jobsBySession` 行与携带其 `correlation.jobId` 的 activity 逐行 join：job 提供身份、生命周期（`stopping` 只存在于此）、时长与模型可见 `detail`；activity 提供可展开的输出面板。没有 job 的 activity（workflow 运行）保留自己的行；job 不在投影里的 activity 也不会被丢弃。没有 activity 注册表时 job 行照常渲染——只是没有面板，合并控件退化为与旧 job 列表完全等价。
- **用户可见词汇统一为"任务"（task）**——`N 个任务进行中` / `N tasks running`——因为对用户而言每一行都是在跑的工作，而"后台任务"排除了 workflow 运行、"活动"命名的是内部面而非用户概念。词典命名空间与包名保持 `activity`：内部名遵循命名台账，不跟随展示文案。
- **层次**：进行中的行在前（命令为主行、kind 徽章加状态为副行、时长每秒跳动），已结束的行折为降权单行；每个非空分组带自己的标题（进行中 / 已结束）。没有可观察 activity 的行渲染为无展开交互的静态行。

刻意不合并的：subagent 委托行保持裸 job 行（subagent 面板是它的呈现面），前台命令留在工具卡片里——两者都不接活动生产者。

## 曾考虑的替代方案

- **合并服务层**——因上述游标语义与模型可见性理由否决。
- **保留 job 列表、把输出挂上去**——workflow 运行（无 job 的 activity）无处安放，第二个列表终究得活下来。

## 浏览器验收带来的细化

在真实应用里驱动合并列表得出四个呈现决策，全部限定在展开面板与头部条带：

- **头部条带顺序为 preset → 任务 → subagent 目录。** 根会话的后代数量从面包屑（`header.lineage`）移入操作区（order 30）并去掉 `/` 分隔符——根会话没有可面包屑的层级；子会话保留 `根 / 子` 切换器，那里的 `/` 是真实层级。移位后的席位由 `SubagentCatalogAction` 拥有；谱系 renderer 在根会话上不再渲染任何东西。
- **面板的复制控件复制命令**（`TerminalBlock.copyText`）而非输出：长命令在行内被省略号截断，控件是它唯一的完整来源，而输出本身就是下方可选中的文本。提供 `copyText` 还让控件在任何输出出现之前就保持渲染。
- **面板以滚动取代折叠**：命令与输出行完整换行（`--dsl-terminal-command-whitespace` / `--dsl-terminal-line-whitespace: pre-wrap`，输出区因此永不横向滚动），输出区以固定高度封顶（`--dsl-terminal-output-max-height`），`maxLines: Infinity` 禁用头尾折叠。
- **面板不画运行状态点**（`TerminalBlock.runStateDot: false`）——上方的行已携带同一状态——并通过 `--dsl-terminal-gutter` 收回状态点落区。面板左侧竖线随之移除。

四项全部以 `TerminalBlock` 的可选项落地（prop 或 `--dsl-terminal-*` 变量），工具卡片保持既有的折叠/省略/状态点行为不变。

## 测试

组件套件覆盖 join（job 生命周期优先、activity 提供面板、裸 job 行、独立 activity）、分段、时长与面板选项；`pnpm vitest run packages/client/ui-activity packages/client/ui-primitives packages/client/ui-subagent` 运行它们。无密钥 web e2e 对（`background-job-list`、`live-activity-stream`）按 ARIA golden 端到端回放合并列表；`agent-preset-selection` 钉住头部条带顺序。

## 后果

- 两个 web e2e 场景（`background-job-list`、`live-activity-stream`）现在断言同一个"任务"列表；job 场景的行获得了实时输出面板，这正是 join 端到端生效的证据。
- live 行上的人工 kill 控件仍被 job-display note 记录的 jobs `reported` 契约问题阻塞。
- `job` 词典命名空间随包一起消失；`activity` 拥有合并后的全部文案，包括时长词汇。
