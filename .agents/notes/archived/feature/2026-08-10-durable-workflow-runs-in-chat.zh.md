# Agent Note: Chat 中的持久工作流运行

Status: implemented
Archived: 2026-09-04

[English](2026-08-10-durable-workflow-runs-in-chat.md) | 中文

## 问题

普通工作流工具行拥有模型调用与最终工具结果，但这两条记录无法说明哪些成员真正开始、如何分组、各成员是完成、失败还是取消，也无法说明进程停止时哪些工作尚未结束。实时 `workflow/*` 事件只存在于当前进程，因此刷新或稍后重新打开 Session 会丢失运行历史。

Web Client 已经能够从持久 Session 事件组装由业务拥有的 Conversation Node。工作流历史因此需要：能够把一次已接受运行关联到调用 Session 的生产方、作为前缀也始终有意义的最小持久协议，以及不夺走现有工具卡所有权的独立 renderer。

## 决策

`dsh-tool-workflow` 把每个已接受的顶层运行投影到调用 Agent 的 Session。`tool-workflow/run-start` 记录稳定 `runId` 与已校验名称；匹配的工作流成员事件记录成员序号、精确标签、可选精确阶段、子 Session id 与结果；只有在结果已取得且 `run.dispose()` 完全停稳后，`tool-workflow/run-end` 才记录停止原因。嵌套 transport 执行照常运行，但不会写工作流记录，因为它不拥有独立 Chat 行。

记录只供观察。任一次 Session append 首次失败后，本运行会停止所有后续写入、只记录一次告警，并且绝不改变取消、结果映射或 dispose。每种失败位置都留下空记录或合法连续前缀：已开始运行可以缺少后续成员或运行终点，已开始成员也可以缺少成员终点。包 invariant 会在冷加载与实时 append 时拒绝重复运行 start、无效或复用的正成员序号、无配对或重复成员 end、仍有开放成员时结束运行，以及运行结束后的任何更新。

workflow 包通过 `@deepseek-ai/dsh-workflow/types` 提供浏览器安全的运行与观察词汇；包含活跃 `Agent` 的请求和控制句柄继续只属于 Host。`@deepseek-ai/dsh-tool-workflow/types` 拥有四类 Session 事件。Client 只导入这些类型 face，因此 Host 与 Client TypeScript 程序共享持久合同，而不会合并 Host Cordis Context。

`ui-workflow-run` 注册一个 `workflow-run` Conversation Definition 和一个 keyed Chat renderer。每条事件都能独立给出同一 `runId`；run-start 初始化 State，后续事件按日志顺序更新；只有 update 的历史尾页会保持 pending，直到 prepend 补入唯一 start。最终节点保留引擎拥有的 key，并以 run-start 锚定在原工具调用之后，从运行中到终态始终保留同一个 React 父级。

renderer 为每一层分配不同视觉职责。运行使用 32 像素 module-platform 背景行，常驻向右／向下 chevron，并以内联状态点加状态文字表达结局，不使用胶囊。阶段使用 32 像素 disclosure 行，在可伸缩主区显示标题与成员数，在固定尾部精确显示聚合状态且不重复状态点。成员使用 16 像素状态点槽、可省略名称区和固定 64 像素状态列。阶段只在成员真正开始时出现，并按精确阶段字符串分组；字段缺省与空字符串保留不同身份和本地化名称。成员结算只改变状态，不删除或重排成员。所属 Turn 或 Step 关闭时，缺少运行或成员终点会显示为已中断；存在持久终点时仍以它为权威。[状态驱动的工作流 disclosure](2026-08-11-workflow-run-status-driven-disclosure.zh.md)拥有这些事实变化时运行与阶段内容的可见性。

导航从两个当前权威派生，不写入持久记录。只有持久成员状态仍为运行中，且当前普通 Session 列表包含同一 id、`origin: 'subagent'`、`parentId` 等于当前父 Session、`running: true` 时，成员行才可交互。带下划线的成员文字是唯一可见提示；键盘聚焦时，名称区显示 2 像素 business-primary 焦点环，固定状态列继续只表达生命周期，而不写动作说明。renderer 只调用注入的普通 `sessions.open(id)` 回调。仅地址化、远程、父级不符或终态成员继续可见，但保持静态。

[七状态 Figma 参考](https://www.figma.com/design/tguwzZRmHCjbq58mfsqT0M?node-id=5-2)固定运行展开／收起、完成历史／展开、失败与取消、恢复后中断以及暗色窄列的信息层级。仓库的 `DisclosureRow`、`StateDot`、图标、语义 token 和 keyed-node 行为仍是实现权威；参考稿不引入运行时字段或状态 owner。

## 验证

包测试覆盖顶层与嵌套准入、零成员与并发运行、先 dispose 后写终点的顺序、四个 append 失败前缀，以及冷／实时 invariant 拒绝。Conversation 测试比较完整 replace、只有 update 的 prepend 和实时 append，并覆盖精确阶段身份、终态与中断状态、disclosure 状态、列表事实导航、HMR 移除与重新注册。shipped Web replay 复用现有工作流父／子模型 fixture，驱动真实 worker、spawn provider、Session 持久化、浏览器 bundle、运行中子级导航、终态保留、原工具行并存、暗色窄列 token 与刷新重建。

## 曾考虑的替代方案

**把工作流内容附加到现有工具卡。** 拒绝，因为 `ui-tool` 与工具定义拥有该行的展示和交互。工作流专属 appendix 会耦合两个独立 keyed 业务生命周期，并恢复已移除的工具后附加模型。

**持久化服务端 projection 或新增 workflow wire 通道。** 拒绝，因为 Session 事件已经提供持久化、实时传输、分页和 gap repair。另一个 service、cache 或 transport 会复制同一事实并建立第二个生命周期 owner。

**展示声明阶段，或从脚本文本推断静态工作流图。** 拒绝，因为只有成员 start 事件能证明工作真正发生。`meta.phases`、`phase()` 叙述、分支和脚本语法都不是一次运行的权威拓扑。

**保留终态子级导航。** 拒绝，因为工作流记录证明历史身份，不证明当前可访问性。冷 Session 或远程 Session 的打开需要独立目录与授权合同；本节点不作这种承诺。

## 后果

工作流进度与父对话保存在同一日志中，能跨刷新与进程恢复；执行所有权仍属于工作流 run holder，原工具卡保持不变。持久协议增加四类小事件和一个包所有的 invariant；首次写入失败会刻意牺牲后续观察，而不是牺牲工作流正确性。浏览器 State 按已加载窗口派生，状态驱动的 disclosure 生命周期把复盘选择留在本地，导航会随列表事实消失。设计只展示真实运行成员与状态，并放弃静态图、输出、日志、控制操作和终态成员打开。
