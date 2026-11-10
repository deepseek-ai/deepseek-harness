---
description: "从 Web 对话标题栏查看共享任务板。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-agent-team

[English](README.md) | 中文

## 概述

此包在同一个页头面板中，将共享任务显示在 Subagent 树下方。Host 投影帧持续更新任务状态，无需刷新控件。普通 subagent（子智能体）导航负责成员列表和队友对话。Web bundle 默认加载此包；它不添加模型可见输入。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在根会话的模型与推理等级菜单中打开**启用智能体团队协作**。新 Session 默认关闭。开启后，通过根会话的 Subagent 入口同时查看上方的成员树和下方的共享任务。子会话保留子智能体导航，不显示任务板或 Team 开关，包括尚未发现子代理地址时。子智能体目录和共享任务都为空时隐藏入口；目录或任务记录错误仍保留查看入口。仅当 Team 模式已开启、存在至少一个未删除的共享任务且任务 footer 可用时，才显示区域标题。此时即使目录为空，共享任务上方仍保留不可折叠的“子智能体”区域。其他情况下，菜单仅显示 subagent 导航，不显示区域标题、共享任务模块、空状态文案或分隔线。关闭后保留任务和子代理。团队设置整行在悬停时高亮，点击可切换状态，但独立的信息按钮除外。开关调用 `remote.agentTeams.setEnabled`，等待保存后的投影更新，失败由菜单宿主提示；锁定或保存中不能通过整行切换。旁边的信息按钮可通过悬停、键盘聚焦或点击／轻触查看共享任务协作与额外 token 消耗的说明，不改变开关状态。按 Escape 或点击外部可关闭说明。

会话记录过模型请求后，从菜单开关停用团队需要确认；仅选择模型不会触发确认。请求历史尚未加载时，开关暂不可操作。弹窗说明工具、协作与可能的缓存影响，不会删除任务记录。取消、按 Escape 或关闭弹窗都保持团队状态不变。弹窗关闭后，焦点回到模型选择按钮。确认操作绑定到最初的会话，等待保存完成，失败时保留错误供重试，不依赖模型菜单保持打开。Team 模式没有斜杠命令；菜单切换不会生成 `command/run` 或 `command/done` 记录。

Chat 隐藏历史 `/team on` 和 `/team off` 记录中尚未完成或执行成功的回执。失败回执仍显示 Users 图标、本地化的“智能体团队协作”标题，以及本地化的失败前缀和已记录原因的首个非空行，不翻译原因原文。展开回执可查看完整原始错误。参数无法识别或缺失时仍显示回执。

[Web bundle](../../bundle/web-app/README.zh.md) 默认加载本包。Web Client loader 挂载 `/client` export；root Host export 不执行行为，本包也没有用户配置字段。

### 查看任务板

可开始的 pending 任务使用 idle 灰点，被依赖阻塞的 pending 任务使用 warning 橙点，in-progress 任务使用 ongoing loading，completed 任务使用 done 绿点。

不可折叠的“共享任务”标题使用 Checklist 图标，并显示已完成、进行中和待处理数量；省略零值，文案和分隔符与输入区任务列表一致。紧凑只读行显示主题、状态和展开箭头，13px 主标题与悬停区域对齐子智能体行；展开详情使用 12px 文字。任务行使用 7px 垂直内边距、6px 水平内边距和 7px 间距，使可点击内容与 subagent 行对齐。所有任务详情初始关闭，打开一项会关闭上一项。详情仅显示完整描述（如有），下方以单行显示负责人标签和负责人名称，两者使用相同颜色，间距为 4px。过长的负责人名称以省略号截断，仅在被截断时通过工具提示显示完整内容。任务文字和负责人的工具提示在悬停 500ms 后显示。负责人显示任务保存的 `ownerName`，例如 `lead` 或 `reviewer/checker`，不依赖已加载的 subagent 目录。缺少 `ownerName` 时显示 `ownerId`；两个字段都没有时显示本地化的无负责人标签。共享菜单宽度为 360px，外层内边距为 6px，并受视口可用宽度约束。共享任务上方保留 4px 外边距，不显示分隔线。两个区域标题均保留 7px 图标与文字间距，并在统计数量前额外留出 4px。仅菜单本身滚动，任务列表与详情不单独滚动。Agent 通过工具修改任务；面板不提供修改控件。投影失败以独立警告显示在保留的任务上方，即使没有任务也保持可见。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Client export 通过 Cordis effect 注册语言字典、子代理目录与模型菜单 slot；它不挂载 Remote namespace。销毁插件 fiber 会移除这些注册。

Subagent 目录负责共享面板的滚动、悬停、键盘和关闭交互。本包仅在根会话的树下方提供任务区。任务板通过 `useProjection('agentTeam')` 读取当前 Session 的模式与任务；仅当投影可用、已开启且含有未删除的任务时才显示任务区；投影错误可独立显示，不需要任务区。任务 ID、依赖、准备状态、写入范围及其提示仍保留在任务数据中，但不作为详情字段显示；被依赖阻塞的 pending 任务仍使用 warning 图标。

[Chat 可见性策略](../ui-chat/src/client/contract/chat-visibility.ts) 仅隐藏名称为 `team`、已记录参数去除首尾空白后恰为 `on` 或 `off`，且尚未完成或执行成功的历史命令。其余回执在执行中显示本地化摘要，成功时保留原始结果文本，文本为空则使用本地化的完成提示。渲染既不读取当前 Team 投影，也不解析英文结果文案。过滤与本地化仅影响 Chat 展示：命令记录、日志、轨迹和原始错误均保持不变。

| 文件 | 职责 |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | 语言字典、目录任务区和模型菜单注册 |
| [`src/client/TeamBoard.tsx`](src/client/TeamBoard.tsx) | 从投影派生的任务区 |
| [`src/client/locales.ts`](src/client/locales.ts) | 八种语言的面板与命令文案 |
| [`src/index.ts`](src/index.ts) | 不执行行为的 Host entry |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Web bundle](../../bundle/web-app/README.zh.md)——默认挂载本 Client plugin。
- [Agent Teams 服务](../../team/agent-team/README.zh.md) — 任务和投影行为的权威来源。
- [会话 UI](../ui-conversation/README.zh.md)——稳定 header slot 与 addressed-subagent 导航表层。

-----

<a id="model-experience"></a>
## 模型体验

无直接影响，因为该浏览器 projection 不注册面向模型的输入。

#### KV Cache 影响

无直接影响；Team 工具与普通会话提交负责后续任何模型可见用途。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **无邮箱时间线** — 面板显示任务，不显示消息。
- **没有 lifecycle 或 workspace control**——panel 不能 spawn、rename、delete 或 interrupt teammate，write scope 仍只是提示性 metadata。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
