# Agent Note: Alpha Session 迁移拒绝所有未知历史事件

Status: implemented

[English](2026-08-31-alpha-historical-unknown-event-refusal.md) | 中文

## 问题

同版本 Session 读取只有在 producer 把信封标记为 `ignorable: true` 时，才可以安全跳过未知事件。保持基数的迁移有更严格义务：它必须证明每个保留 payload 在目标代际中仍具备正确语义。未知 JSON payload 可能包含编译期品牌无法发现的 Session 序号、生命周期事实或模型可见状态。

静默复制这类事件，会在后续迁移边改变事件位置时留下陈旧数字引用。静默省略它会丢失持久数据。保留精确且不可变的 v0 generation 不能让任何一种转换后的 v1 结果变得无损。

## 决策

Alpha v0-to-v1 迁移边拥有冻结且完整的已发布 v0 事件与 payload 清单。它在目标 staging 前拒绝每个未知历史事件类型，包括标记了 `ignorable: true` 的事件；除明确分类为 owner 不透明 JSON 的字段外，它也拒绝已知 payload 的意外成员。可合并扩展的嵌套判别字段同样属于这项显式策略：未知 content-block type、message-source kind、assistant finish-reason kind 与 turn-ending reason kind 会作为 owner 不透明 JSON 保留，已知分支则接受结构校验。诊断会点名事件类型、序号和保持不变的源 generation。

该规则只适用于跨越历史格式迁移边。普通当前格式读取保留既有信封行为：未知必需事件被拒绝，带 `ignorable: true` 的未知事件仍可读取。因此新的 v1 外部事件继续使用既有同版本扩展 seam，但不会自动获得未来格式迁移能力。

每个第一方源事件类型都在迁移边包中拥有可执行 disposition 与目标 validator。catalog 在构建时静态确定且与 profile 无关，因此 producer 插件是否挂载不会改变旧产物能否迁移。

## 后果

某些由仓库外信息型插件产生的 v0 Session 可能拒绝 alpha 迁移，即使 v0 codec 能解码它们。拒绝不会发布后继，因此无后缀 v0 路径、字节与 inode 仍然权威且不变。操作者可以从诊断识别阻塞类型，并完整访问其原始文本。

社区反馈将决定下一步策略。后续版本可以添加显式外部 owner 迁移接口、在保留精确源代际时允许省略明确 ignorable 的历史事件，或继续严格拒绝。Alpha 标记不预先承诺任何选项。

`SessionSeq` 与 `SessionLogOffset` 让已知第一方数字字段可审计，但无法分类未知 runtime 对象中的数字。因此迁移规则不能根据没有识别到品牌字段来推断安全。

本记录仅在历史格式迁移方面取代 [保留可忽略外部 Session 事件](2026-08-30-retain-ignorable-external-session-events.zh.md)。原决定对同版本 append 与 reload 仍然有效。

## 考虑过的替代方案

- **逐字复制未知 ignorable 事件**——保留字节，但不能证明不透明数字或生命周期事实在结构迁移后仍有效。
- **丢弃未知 ignorable 事件**——让迁移保持可用，但不再无损，并让该标记授权删除数据。
- **在未知 JSON 中搜索类似数字字段的名称**——启发式无法建立语义身份，还会制造虚假信心。
- **动态询问已挂载插件**——让迁移可用性取决于某个部署组合，并在缺席 producer 能挂载前失败。
- **等到第一条结构迁移边再拒绝**——会让 v1 包含从未建立安全解释的历史值；恒等演练正是把策略变成可执行规则的时点。
