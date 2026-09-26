# Agent Note: What stays host-plane once presets own the agent plane

Status: implemented

[English](2026-08-10-host-plane-ownership-after-presets.md) | 中文

## 问题

[逐会话 agent preset](2026-09-18-declarative-agent-presets.zh.md) 把每一个面向模型的行搬上了 agent 平面，此后的每一处修复都是一个仍按搬迁之前的世界写成的读取点。`tasks` 因为 realm 之外的 preset 行要解析它而搬回宿主；`goals` 因为同样的理由从未离开；而当所有面向模型的工具都变成祖先贡献之后，子 agent 的 `toolFilter` 也已被修好（[子 agent 加入父方 preset](../bug-fix/2026-08-10-child-agents-join-their-parent-preset.zh.md)）。

还有两个读取点仍站在这条线的错误一侧。

`dsh-token-meter` 在宿主侧被禁用，改挂进每个 preset 的 `compaction` realm。它不接受任何配置，每次折叠都以 `Session` 建键，也不注册工具或提示段——但它拥有 `tokenUsage`、`contextPressure` 与 `contextBreakdown` 三个投影单元，而 `sessionProjections` 是一张进程级、没有作用域分层的表。因此从某个 preset 内部注册的单元会替所有会话作答：一个 `minimal` 会话是否显示 context meter，取决于本次启动以来有没有**别的**会话挂过 `standard`；而只跑过 `minimal` 的进程根本不显示。

没有加入任何 preset 的 agent 也无人指出。加入是一条 scope 父链链接；缺了它，`tools`、`system-prompt` 与 `skill` 的视图都解析到空的全局层，模型什么也收不到——不报错，也没有空目录可看，只是一个无法行动的 agent。被委派的子 agent 在 preset 存在的整段时间里都是这样运行的，而同一个洞在每一个早于 preset 的入口点上都开着。

## 决策

**meter 属于宿主平面。** `dsh-token-meter` 回到宿主组装，并离开各 preset 的 `isolate` 映射，于是 `compaction-basic` 与 `tool-result-pruner` 在自己的 realm 内部解析到那一份宿主实例。preset 保留 realm 与压缩后端——preset 选择的是它的 agent 是否压缩，而不是它的 token 是否被计。这正是 `tasks` 与 `goals` 已经采用的判据，只是这次适用于一个因**投影**触达面而不该归 preset 所有的 Service：当一个单元的空值与真实值无法区分时，只要它注册进的那张表是进程级的，它就不能是逐组装的。

**未加入的 Agent 在使用模型时失败。** 不变量 companion 检查 `system-prompt/assemble`，因为未绑定的 Agent 可以合法地稍后通过 `recompose` 绑定。纯 Host 和历史 scope 提示词读取没有 Agent，不属于此检查范围。

投影 key 是否存在不能代表逐会话能力（[会话投影](../../../../packages/session/session-projection/README.zh.md)）。通过 `cordis_mount` 挂载的临时插件属于组装，而非调用会话（[Cordis 工具](../../../../packages/extensions/tool-cordis/README.zh.md)）。[声明式 preset](2026-09-18-declarative-agent-presets.zh.md) 负责代际保留，在最后一个引用释放后回收退役树。

## 测试

`apps/cli/tests/web-agent-presets.e2e.ts` 在创建任何 Agent **之前**，于已启动的 Web 组装上读取 `ctx.get('tokenMeter')`——preset 侧的 meter 会待在 `isolate` realm 里，对 `ctx.get` 不可见，因此这次读取是一次所有权断言而不是挂载顺序的巧合——随后断言一个 `minimal` 会话的快照带齐三个单元。

`packages/preset/agent-preset-registry/tests/invariant.spec.ts` 拒绝未加入的 Agent 组装，并接受已加入的 Agent、Host 读取和历史 scope 读取。

## 考虑过的替代方案

**把 meter 留在 preset，改为给投影注册表分层。** 这是更精确的修法，代价也大得多：`snapshot`、`checkpoint` 与主动驱动都需要一次「会话 → 作用域」的解析，而冷读在没有 api-proxy 的 `presenterScopeFor` 时并不具备。相对于一个完全没有 per-preset 状态的 Service，这不成比例，因此改为把通则写在注册表上。

**对未加入的 agent 否决发布。** 大声胜过静默，注册表也支持这么做——同步的 `agent/created` 监听器抛出会把创建整体回滚。否决的理由是：在名单之外组装 agent 是合法的——`recompose` 写明了它随后绑定的那个裸 agent，而 ACP 桥、SDK server 与 headless bundle 都会创建一个。否决会把能力缺口变成一次故障。

**让配套也在 `agent/created` 处检查加入情况。** 否决：发布时分不清漏掉的加入与之后才会被绑定的 agent，因此该检查会拒绝一条已写明的路径。提示词组装分得清。

**基于同样的投影理由，把 `plan-mode` 与 `tool-todo` 也搬离 agent 平面。** 否决：两者确实是逐 preset 的能力，且对从不使用它们的会话，其单元算出的就是空值，而客户端本来就按值读取（`plan.active`、空列表）。只有空值与真实值无法区分的单元——meter——才被迫归宿主所有。

## 后果

context meter 成为逐会话的事实，而不再是挂载历史的函数。代价是 preset 不能再选择不做 token 记账；随附的 preset 没有一个这么做，`minimal` 现在也写明它放弃的是自动压缩而非记账。

不变量覆盖加载了 `dsh-invariants` 的组装。生产入口必须显式组装 Agent；仅安装注册表不会自动绑定。
