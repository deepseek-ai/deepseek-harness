# Agent Note: 裁剪 skill 注册表中未使用的接口

Status: rejected — 直接在运行时注册 skill 是为第三方插件保留的有意扩展路径。

[English](2026-07-12-prune-unused-skill-registry-api.md) | 中文

## 问题

skill（技能）服务的嵌入式运行时子系统中，`ctx.skills.register()` 没有任何生产调用方。它引入了一个保留的 `runtime` 提供方名称、一套运行时 map/rank/source、重复策略、缓存键中的第二个 revision、规范化逻辑、dispose（资源释放）函数以及相应测试——而所有已交付的 skill 都使用提供方约定。`SkillSummary.whenToUse` 和 candidate/definition 的 `path` 被解析和复制，但没有任何生产消费方读取它们：模型目录只渲染 name/description，资源加载使用 `resourceBase`，提供方自行管理其定位器。有意开放的 `metadata` 扩展点保留不动。

## 提案

移除 `SkillRegistry.register()`、`SkillRegistration`、运行时伪提供方及保留名称规则、运行时 revision/缓存分支，以及仅用于运行时的 source/rank 规范化逻辑。需要嵌入式 skill 的测试改为注册一个小型真实提供方。保留 `providerRevision` 作为进行中发现操作的 epoch，但已完成的目录缓存仅以 cwd 为键：每次提供方变更同步清除缓存，await 之后的 revision 比较已能阻止插入陈旧结果。从 skill 约定和本地提供方副本中移除 `whenToUse`、`SkillCandidate.path` 与 `SkillDefinition.path`，同时保留提供方的 locator/root 路径；保留 `metadata`、`disableModelInvocation`、`source`、`provider`、`locator` 和 `resourceBase`，因为它们要么是有意开放的扩展词汇，要么是生产消费的字段。

同步修订 skill 系统 Agent Note、README、JSDoc、目录文件与测试。agent（智能体）作用域的系统提示词段、工具提供方和变量明确不在本提案范围内：[agent 作用域贡献者约定](../../../../packages/core/scope/README.zh.md)有意允许在 `setup(agentCtx)` 期间通过 agent 拥有的上下文注册这三者，因此仓库内没有固定的作用域注册并不能证明它们未被使用。

## 曾考虑的替代方案

**保留面向嵌入方的运行时 skill 注册。** 这是已实现的 skill Agent Note 中有意提供的同步直接定义便利接口。一个小型提供方包装层可以在 effect 拥有的生命周期下暴露相同的嵌入数据，但它必须实现异步 `list()`/`get()`、携带提供方身份，并接受提供方处理重复项的语义。本提案选择只保留一条统一的提供方路径，而非维护第二套排序、校验、缓存失效与查找路径。

## 验收标准

- skill 收集只有一条提供方驱动的路径，已完成缓存仅以 cwd 为键，revision epoch 仅用于使进行中的发现操作失效；保留的 skill 字段要么有生产读取方，要么有记录在案的有意扩展约定。
- agent 作用域的系统提示词段、变量、工具提供方、工具守卫，以及原生模式和 PTC mode 下的 structured-output 提交行为保持不变。
- 类型检查、覆盖率、快照、doc-sync（文档同步门禁）、module-graph 校验、构建与 hygiene 全部通过。

## 风险

这是对预发布 skill 注册表的编译可见收缩。外部编程式 `list()`/`get()` 消费方将失去 `whenToUse` 路由提示和 candidate/definition 的 `path`；已交付的模型目录从未渲染它们，资源解析保留了显式的 `resourceBase` 加上提供方自有的不透明 locator，但这些字段并非观测等价。skill 本地 frontmatter 解析必须继续保留并校验所支持的 metadata schema，外部提供方仍可提供嵌入式、文件系统、远程或其他 skill 来源。
