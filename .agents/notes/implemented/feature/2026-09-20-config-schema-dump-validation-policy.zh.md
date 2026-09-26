# Agent Note: 配置 schema dump 的验证策略

Status: implemented

[English](2026-09-20-config-schema-dump-validation-policy.md) | 中文

## Problem

`dsh --profile <name> --dump-config-schema` 在不挂载插件的情况下，把原生 Schemastery Config 声明投影为 JSON Schema。原生验证会修改输入、求值 `!!js` 表达式并执行 transform 回调；静态文档无法完整重现这些行为。评审中有三项选择存在争议，若不记录会被反复重提：投影部分近似时 `complete` 和退出码的含义、收集器检查哪些行，以及投影如何处理无法建模的原生行为。

## Decision

- **部分投影以 1 退出。** 只要存在错误诊断、任何 `partial`、`unsupported` 或 `error` 条目，或同一插件名解析出多个 Config 定义，`x-cordis.complete` 即为 false 且 CLI 以 1 退出，即使 stdout 已包含有效且有用的 schema。退出码回答的是该文档能否替代原生验证，而不是是否产生了输出。只需要 schema 的调用方读取 stdout 并忽略退出码；`x-cordis` 下的诊断会在受影响的每个条目上说明各项限制。
- **发现面向声明，并包含禁用行。** 收集器遍历 Loader 将接收的每一行，包括字面量禁用或表达式禁用的行，并导入它们的模块。因此禁用行的导入或 include 失败会使可启动的 profile 被标为不完整。唯一的例外遵循 Loader：未设置 `group: true` 的禁用 group 或 include 从不创建其子项，所以缺失的承载 config 记录为没有子项的树，entry schema 也不验证其子声明。
- **放宽而不是模拟原生修改。** 当原生解析可能在后续验证读取前改变输入（容器写回适配值、字典键改名、loose 回退、lazy 元数据传播到共享节点）时，投影保留可获得的声明细节，同时并列一个不受限制的备选项，并记录一条限制。它绝不模拟该修改。放宽的范围限定于该机制：只有容器会写回适配值，因此作为前序 union 分支的裸原始类型 transform 保留 `anyOf`。

[CLI 参考](../../../../apps/cli/reference/README.zh.md#config-schema-dump)记录了由此产生的行为；[app-boot](../../../../packages/boot/app-boot/README.zh.md) 负责收集器 API。

## Alternatives considered

**输出有效文档并仅给出警告，以 0 退出。** 被否决：把 schema 交给编辑器或 agent 的消费者会把近似文档当作权威。非零退出迫使调用方显式决定。

**发现时跳过禁用行。** 被否决：禁用行是用户很可能重新启用的声明，其 schema、id 目标和导入失败正是编辑 agent 所需。跳过还会导致 `configRef` 目标随 `disabled` 切换而变化。

**为祖先被禁用的子项提供放宽的子列表变体。** 暂被否决：它需要一套去掉必填约束的并行 `entryList` 和 `entry` 规则。禁用的 `group: true` 行之下的子项以及插入到禁用 group 的 patch 按启用状态验证，参考文档已如此说明。

**在投影中模拟原生修改。** 被否决：transform 回调是 dump 不得执行的插件代码，而重现写回顺序会把投影器与 Schemastery 内部实现耦合。带限制说明的放宽维护成本更低，也不会拒绝原生验证接受的输入。

## Consequences

使用不受支持承载插件的已发布 profile 会报告 `complete: false` 并以 1 退出，同时仍输出可用的 schema，因此消费者必须读取 `x-cordis.diagnostics` 来区分近似文档与不可用文档。每次放宽都配有一条限制诊断，生成的 schema 能验证每个已发布 profile 的 `--dump-config` 输出。
