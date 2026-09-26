# Agent Note：已记录的 user-source 归属兼容性

Status: implemented

[English](2026-09-17-persistence-attribution-policy.md) | 中文

## 问题

生产者拥有的消息 source 会传递性地出现在多个持久化事件类型中。即使已有读取方无需该生产者也能保留字段，新增归属 kind 仍会改变这些联合类型的指纹。仅供请求使用的提示不需要持久身份，但将其构造成 Session 消息会为联合类型增加不必要的 source 分支。

## 决策

核心拥有的 user-message source 属性绑定[已记录的兼容性策略](../process/2026-09-17-persistence-schema-review.zh.md)。生产者另行将其 wire 字面量 kind 声明为仅用于归属。双方保存的 schema 必须具有兼容的策略状态，符合条件的添加才能获得同版本分类。已有分支继续接受结构比较；缺失策略、未标记的添加、删除以及已有语义分组的变更继续采用严格分类。固定的 system、model 和 tool source 字段不参与。

tmux-context 生产者将位置归属标记为符合条件。其自身投影使用 kind 避免重复注入，而未安装该生产者的读取方保留已记录内容及 source 的每个 JSON 属性。该标记承诺读取方不依赖生产者，并不禁止生产者内部的去重。

`RequestMessage` 接受持久化 `Message`，或仅含 content、没有 `id` 和 `source` 的 user 专用 `RequestUserInput`。LLM 服务和 provider 序列化器接受两者；Session 写入、Agent 交付及持久化标题请求输入要求持久化消息。Auto Review 的外层提示和压缩摘要器的最终指令使用仅供请求使用的输入，并保留内容与冻结行为。调用方不会获得隐式持久化转换。Assistant 回放元数据和工具结果关联保持原有要求。

已定稿的 V4 确认记录保存 user-source 策略，并移除两个仅供请求使用的 source 注册。原有前驱和 header 迁移保持不变。这不构成删除已接受分支的通用例外：[producer-source 迁移](2026-09-09-producer-owned-message-sources.zh.md)独立于活动 source 声明保留生产者映射与扩展命名空间，包括历史的仅供请求使用的 kind。目录生成和比较仍由[持久化参考](../../../../docs/persistence-changes/README.zh.md#compatibility-rules)负责。

## 考虑过的替代方案

**将所有 source 添加视为破坏性变更。** 这会要求为读取方已能安全保留的归属信息提升 Session 格式版本，无法区分它与语义变更。

**放宽所有可辨识联合或从当前名称推断兼容性。** 通用例外会接纳语义分支。当前声明不能确定旧快照作出的承诺，结构相等也不能确定 source 属性的归属。

**为每个请求使用持久化消息。** 独立提示会保留人为制造的身份和不必要的 source 声明。显式的 user 专用分支允许移除它们，同时让带类型的 Session 接口继续要求持久身份。

**将历史 context 形式收窄到当前写入方示例。** 写入方示例不能确定已发布读取方接纳的全部值。这些面向读取的分支继续保留。

## 影响

符合条件的添加仍会改变相关事件指纹，并要求确认记录。Review 者必须验证生产者的归属承诺；类型分析不能确定回放语义，也不能发现不透明值中隐藏的行为。

Codec 到 Session 的测试在未安装生产者时保留未知 user 归属和额外 JSON 字段。Provider 等价测试比较仅供请求使用的输入与持久化输入，类型断言则拒绝在持久化写入处使用仅供请求使用的输入。已记录的 Session 世代及 V3→V4 转换不依赖目录策略和渲染。
