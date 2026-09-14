# Agent Note: 反馈弹窗、分类与确认 toast

Status: implemented

[English](2026-09-08-feedback-dialog-and-categories.md) | 中文

## 问题

Web 客户端有两条互不相连的反馈路径，且都没有可见结果。`/feedback <text>` 记录一条 Session 备注并在转录里渲染一行确认；赞踩对立即记录评分，自由文本则通过锚定在该行下方的备注浮层填写。两条路径都不告诉用户提交了什么、去了哪里，都不收集分类，而点踩这个用户最愿意解释的场景什么也不问。Issue #3515 及其设计稿要求：一个弹窗，可从输入框菜单、不带文本的 `/feedback` 和点踩三处打开，带七个固定分类、可选描述、成功 toast，以及已记录评分的实心图标；点赞保持立即记录。

## 决策

`command-feedback` 在其客户端可用的 `./types` 导出中以 `FeedbackCategory` 联合类型与 `FEEDBACK_CATEGORIES` 元组拥有分类表，`feedback/record` 变为 `{ text?, category? }`：空白文本记为缺省，两个成员都没有的条目仍会记录，因为反馈所授权的日志投递本身就是内容。同一个包通过 `TypertRemoteService` 发布 `sessionFeedback.record` Remote，按 id 找到 live Session 后调用已有的 `recordFeedback` 生产方，因此弹窗记录的是与命令相同的事件，只是没有命令簿记。`message-feedback` 给 `MessageFeedbackItem` 与 `MessageFeedbackPutRequest` 加上可选 `category`，按元组校验已存值，并把分类变化算作实质编辑。

`ui-message-feedback` 成为 Web 反馈界面。每个 Session 一个 `FeedbackSurface`，拥有消息反馈控制器、负责草稿、提交与 toast 序号的 `FeedbackDialogController`，以及两者之间的路由：消息目标经消息控制器 put 一条带弹窗分类与备注的所选评分，Session 目标经 `ctx.remote.sessionFeedback` 记录。`conversation.input.overlay` 的 `FeedbackDialog` 条目从弹窗 store 渲染 Modal 与 Toast 基元。宿主 `feedback` 命令上的装饰让菜单选中或不带参数的回车为 Session 打开弹窗，而 `/feedback <text>` 仍到达宿主；它使用 `CommandUiSpec` 中的 `action` 种类：裸调用消费触发 token 后运行一个客户端回调，不提交任何内容。后续的[对称消息反馈提交](2026-09-10-symmetric-message-feedback-submission.zh.md)决策拥有评分入口规则：任一未记录的评分都会打开弹窗，再次点击已记录的评分则撤回。备注浮层、`clearNote` 与 `clear` 继续保持移除，因为弹窗是唯一的备注编辑器。

弹窗是共用的 Modal 卡片，宽度按设计稿；设计稿里「包括当前对话的日志」复选框不做，因为日志随每个反馈事件一起投递，不是可选项。超长描述仍在提交时以 `note-too-large` 失败；弹窗保留草稿并通过警告 toast 展示本地化错误。

## 考虑过的替代方案

**把分类编进备注文本。** 自由文本里的前缀不解析就无法过滤，还会混进遥测上传的原样备注；载荷里的持久 id 才是消费方能分组的东西。

**让弹窗经命令平面以 `/feedback <text>` 提交。** 命令拒绝空文本、带不了分类，还会写一行设计稿已用 toast 取代的确认；Remote 记录同一个事件且没有这两个约束。

**在弹窗之外保留备注浮层。** 同一条备注有两个可达性不同的编辑器，会让该行在某些宽度下变成两行，正是当初引入浮层要避免的缺陷，而且设计稿只有两个拇指。

**每个消息控件各自一个 Toast。** 输入框浮层已经按 Session 挂载一次，弹窗又拥有 toast 序号，因此一个持有者同时服务两种消息评分路径与 Session 弹窗。

**在 `CommandUiSpec` 里新增 dialog 种类。** 一个消费 token 后运行客户端回调的 action 已经够用；「文件」行使用同一个 `action` 种类，一份定义即可服务两个条目。

## 后果

新增分类意味着把它加进联合类型、宿主元组、弹窗的标签记录和 `feedback` 词典；客户端打包纯度门禁止从宿主包做值导入，因此弹窗以 `Record<FeedbackCategory, true>` 重述分类表，键的顺序就是标签顺序，完整性由编译器检查。冻结的已发布 v2 载荷清单仍把 `feedback/record` 列为仅有 `text`：它管辖从旧代际迁移来的产物，那些产物不可能携带新成员，而同版本恢复应用的是已安装词汇。固定浮层几何的 `message-feedback-layout` Web 场景随浮层一起删除。message-feedback 与 feedback-release 的 Web 期望输出和反馈子系统文档在同一个 PR 中更新；SDK 的反馈生产方会记录一条带分类的 Session 备注和一条带分类的差评，因此两个 SDK 期望输出都携带新成员。
