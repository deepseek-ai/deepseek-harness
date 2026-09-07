# Agent Note: 模型边界处的运行时参数校验

Status: implemented
Archived: 2026-09-04

[English](2026-06-11-runtime-arg-validation.md) | 中文

## 问题

`defineTool`（[统一 schema DSL](2026-07-20-unified-json-value-schema-dsl.zh.md)）为工具作者的 `execute(args)` 提供了经 `InferArgs<S>` 映射的类型化参数。但该类型只是对运行时值的编译期声明，而这个值实际上是模型生成的 JSON：没有任何机制强制模型遵守 schema，因此畸形调用（缺少必需键、声明为数字的位置传入字符串，或字面量超出声明的集合）会以「仅在名义上类型化」的状态到达 `execute`。工具函数体随后要么在处理结构错误的数据时崩溃，要么在不报错的情况下行为异常。

## 决策

`validateArgs(spec, args): string[]` 编译 `ParameterSchemaSpec`，并委托共享的 `validateJsonSchemaValue()` 遍历器，对格式正确的声明返回可读的违规列表。`defineTool` 在定义时对编译后的参数 schema 创建快照，并在调用类型化函数体之前执行校验；存在违规时会抛出 `ToolArgsError`（`INVALID_ARGS`），注册表将其作为模型可据以修正的错误结果返回。

校验器与编译器因此共享完全一致的语义：隐式参数根是开放对象；必需键仅来自 `required: true`；默认值仍是注解；显式嵌套对象遵循其声明的开放性；数组通过 `items` 递归校验；标量字面量约束保证类型正确；`oneOf` 仅在恰好一个分支匹配时才接受。直接注册的工具自行负责输入校验。

## 后果

- 模型会收到有关自身畸形调用的可操作反馈，而不是遭遇不透明的崩溃，弥合了 `InferArgs` 的承诺与运行时现实之间的鸿沟。
- 校验器与 `InferArgs` 必须保持一致；一项[属性测试](../testing/2026-06-11-property-based-testing.zh.md)生成满足 spec 的参数并断言它们通过 `validateArgs`（同时通过针对性改坏参数来断言其会被拒绝），通过自动化检查消除这种漂移风险。
- `ToolArgsError` 是[结构化错误分类体系](2026-06-11-structured-error-taxonomy.zh.md)中 `HarnessError` 的子类，保留其 `code` 字段；读取 `.message` 的调用方不受该层级结构影响。
- 校验开销相对于一次模型调用可忽略不计。

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->
