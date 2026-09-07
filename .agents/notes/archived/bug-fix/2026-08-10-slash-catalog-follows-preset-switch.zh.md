# Agent Note: 斜杠目录跟随空会话的 preset 切换

Status: implemented
Archived: 2026-09-04

[English](2026-08-10-slash-catalog-follows-preset-switch.md) | 中文

## 问题

preset 把决定 `/` 菜单内容的那些行搬走了。Web 组装禁用了宿主面的 `skill-filesystem`、`tool-skill`、`plan-mode` 和 `command-compact`，改由 preset 提供，因此一个会话有哪些命令和技能，是它自身组成的属性，而不是部署的属性。

浏览器侧两份目录都按会话缓存——`dsh-client-ui-commands` 的 `CommandDirectory`，`dsh-client-ui-skill` 的 single-flight 拉取表——并且 composer 在 scope 出生时就按会话创建时的 preset 预热了它们。随后 hero 上的 chip 允许用户重组这个仍为空的会话，而两份缓存都没有对应的失效边：`commands/change` 是注册表级的，`connection/reset` 需要重连。`agentPresets.recompose` 只是把 agent 的 scope 重新挂接到一个可能已经存在的常驻挂载上，不产生任何注册，注册表级信号因此永远不会为它触发。

于是菜单继续提供会话已经不再运行的那套组成。向下切换后 `compact`、`plan` 和全部项目技能仍列在菜单里；向上切换后留在原地的是更窄的目录——四条宿主面行加客户端自己的 `model` 贡献——而且完全没有技能，这正是 bug 报告描述的现象。只有当某个无关的注册表变化或一次重连恰好使其失效时，目录才会自愈。

## 决策

这次切换的提交点是落账的 `agent-preset/selected` 事件。preset owner 将该提交重新发为 client-safe 的 cordis owner 事件 `agent-preset/selected(sessionId, agentPreset)`，宿主流原样转发它，两份目录各自通过 `ctx.remote.$on` 直接订阅：`ui-commands` 软刷新该键（新快照落地前，旧快照继续服务已打开的菜单），`ui-skill` 让它失效（并中止在途的预热，使一次与切换赛跑的 warm 无法发布过期目录）。

该 owner 事件按会话粒度，不携带目录，只带 preset id。`ui-agent-preset` 会把它折进会话行，因为 `agentPresets.select` 的回执只会到达发起切换的那个客户端，而会话头部标签正是以这一行为准（hero chip 比较下一次选择时读的也是它）。

从落账事件而不是 RPC 处理器的返回值派生 owner 事件，使「这个会话的组成变了」只有一个权威来源：每个已连接的客户端都能观察到这次切换，而不只是发起它的那个标签页；不是发起方的客户端也无需从一个根本不会到来的注册表信号里去推断。

## 考虑过的替代方案

**在客户端自己的 `agentPresets.select` 回调里就地失效。** 改动最小，而且第一轮之后 preset 就锁定，hero 上的 chip 是切换唯一可能的发起处。否决理由是失效逻辑会落在恰好发起 RPC 的那个界面上，而不是提交点：同一个空会话在第二个标签页里仍是过期菜单，将来任何宿主侧的重组也完全没有信号。

**从既有的 `session/event` mux 帧派生客户端事件。** 落账事件本来就会送达每个已订阅的客户端，不需要新增协议类型。因面（face）分离而否决：把 `event.type` 收窄到 `agent-preset/selected` 需要 `SessionEventMap` 增补，而在 Client 程序里加载它只有两条路——引用 `dsh-agent-presets` 工程，那会把宿主的 `ctx.sessions` 合并拖进一个自己也发布同名服务的程序；或者用一次类型断言绕过判别式。

**复用转发的 `commands/change`。** 它是既有的目录失效事件，但它是注册表级的、不带会话、也与技能无关；客户端会把每个会话的命令都重拉一遍，却依然永远刷不新技能目录。

## 后果

转发名单加入了 preset owner 的类型化事件，而每一份由 preset 决定的目录从此有了统一的订阅点：将来任何从组成派生的按会话界面，都在同一个信号上失效，而不必再发明一个。owner 事件仍是落账事实的第二次发布，因此将来若出现一条不落账就重组的切换路径，它将无人宣告。`ui-commands` 保持软失效（已打开的菜单不会变空），而 `ui-skill` 直接丢弃该项，因为技能目录没有「部分可服务」的状态；在重拉窗口内打开的菜单，那一瞬间显示的是没有技能，而不是错误的技能。

## 测试

`api-proxy-agent-preset.spec.ts` 断言已提交的切换恰好转发一次，并带上会话与新 preset；`ui-agent-preset`、`ui-commands` 与 `ui-skill` 的 spec 断言直接 Remote 订阅会合并会话行或只重拉被重组的会话。`agent-preset-selection` web e2e 播种一个项目技能，并在 hero chip 应用 `minimal` 之后断言 `/` 菜单丢掉了 `compact`、`plan` 和该技能，同时保留宿主面的那几行——这是面板跟随组成的整装应用证据。

同一条 e2e 也不再从序列化后的会话列表里读它的 staged-pick 断言：被播种的会话同样记录着 `minimal`，子串匹配在切换落地之前就会通过。现在它按 id 寻址那个活跃会话。

## Related

第二次切换能否到达宿主是另一个缺陷，有各自的成因与修复：[会话行的标识判定](2026-08-10-session-row-identity-covers-the-preset.zh.md)。在它落地之前，`agent-preset-selection.e2e.ts` 只能演练第一次切换——这里的失效边对方向无感，但它所响应的那次切换必须真的发生。
