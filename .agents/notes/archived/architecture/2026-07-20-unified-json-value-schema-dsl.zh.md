# Agent Note: 统一 JSON 值 schema DSL

Status: implemented
Archived: 2026-09-30

[English](2026-07-20-unified-json-value-schema-dsl.md) | 中文

## 问题

工具参数使用一套精简的作者侧 schema DSL，subagent／工作流的结构化输出则使用另一套原始 JSON Schema 子集和校验器。两套词汇在根类型、标量约束和校验方式上并不一致；如果继续沿用这种划分，类型化的规范工具输出约定要么还需重复实现两条路径，要么只能接受部分投影无法强制执行的 schema。

## 决策

`dsh-tools` 以两种表示形式统一管理一套 JSON 值 schema 词汇。`ValueSchemaSpec` 是可描述任意 JSON 根类型的作者侧形式；`ParameterSchemaSpec` 是其隐式对象属性映射形式，每个属性可标记 `required: true`。`JsonSchemaNode` 是原始协议形式。两种形式都支持字符串、有限数值、整数、布尔值、null、数组、对象、类型正确的标量 `enum`／`const`，以及要求恰好匹配一个分支的 `oneOf`；`{ type: 'json' }` 仅是作者侧语法糖，会编译为仅含注解、不施加约束的原始节点。

显式的作者侧对象必须声明 `additionalProperties: true | false`。隐式参数根对象和原始 JSON Schema 保留标准的默认开放语义。schema 记录只能包含自有且可枚举的字符串键，schema 数组必须是稠密的内建数组，系统只从自有属性读取受支持的关键字；因此，自定义原型、继承的约束、symbol 和 JSON 不可见的附加内容都无法让编译、投影和校验观察到不同的声明。内建的普通 Object 和 Array 容器跨 JavaScript 运行域后仍视为普通容器，而子类和伪造构造函数的原型仍视为非普通对象。

`InferValue<S>` 和 `InferArgs<P>` 根据同一份声明推导 TypeScript 值，`valueSchemaSpecToJsonSchema()` 和 `parameterSchemaSpecToJsonSchema()` 也将这些声明编译为 JSON Schema。精确类型推导以 16 层容器为界，超过后使用 `JsonValue`，从而避免 TypeScript 的类型实例化栈限制作者能声明的嵌套深度。`assertSupportedJsonSchema()` 会拒绝不受支持或位置错误的关键字；`validateJsonSchemaValue()` 则以无损 `JsonValue` 边界校验受支持的子集，不允许 `undefined`、负零、非有限数、稀疏数组、循环引用、非普通对象、函数、symbol 及其他需要强制转换的值。作者侧 schema 编译、原始 schema 断言、值校验、schema 到 TypeScript 的渲染、注册表脱离引用，以及动态 Cordis 的跨运行域规范化与克隆均使用显式工作栈，因此运行时嵌套只受可用内存限制，不受 JavaScript 调用栈限制。

对象根限制属于消费方规则，不属于 schema 词汇本身。subagent 和工作流中由调用方定义的结构化输出通过 `assertObjectJsonSchema()` 和 `ObjectJsonSchema` 保持对象根限制；工具输出可以使用任意根类型。动态 Cordis 注册会把跨 JavaScript 运行域传入的 schema 重建为宿主拥有的 JSON 值，保留原始包装层的默认开放语义，并要求直接使用 DSL 声明的对象明确选择开放方式，然后再调用同一编译器。动态边界会在规范化之前拒绝 JSON 不可见的记录键和非普通 schema 数组，因此不会静默丢弃约束，也不会触发自定义迭代逻辑。

## 备选方案

- **保留两套独立的参数与结构化输出 schema 系统：**不予采纳。每新增一种输出结构，都必须分别修改类型推导、编译、校验和代码生成，而这种重复并未形成有意义的职责边界。
- **使用 Schemastery 处理工具参数：**不予采纳。Schemastery 通过 Standard Schema 面向校验与转换，而不是生成 JSON Schema。采用它会增加一层适配器，却不能产出面向模型的协议 schema 或共享的输出词汇。
- **采用完整 JSON Schema 或 Ajv：**不予采纳。harness 必须拒绝所有无法投影到生成 SDK 和校验器中的结构；如果接受更大的语言子集，强制执行能力和模型指引就会与事实不符。
- **让所有对象默认开放或默认封闭：**不予采纳。这两种选择都会隐藏一项影响重大的作者决策。只有保持旧有形态的隐式参数根对象和外部原始 schema 才有意保留默认值。
- **把 `oneOf` 定义为首个匹配分支：**不予采纳。这样一来，分支顺序会改变校验语义，重叠分支也会掩盖值的歧义。

## 影响

- 参数校验、输出校验、schema 到 TypeScript 的代码生成、subagent／工作流门禁和动态注册共用一套强制执行的词汇。
- 输出声明可以推导对象、数组、标量或 null 根类型；subagent／工作流的结构化输出仍在其现有服务边界保持对象根限制。
- 显式的对象开放方式和类型正确的字面量约束会让格式错误的声明在编写或注册阶段快速失败，而不是拖到后续模型调用时才失败。
- 有界类型推导会为常规声明保留有用的精确类型，并将异常深的尾部结构退化为 `JsonValue`；运行时 schema 强制执行在任意深度仍保持精确。
- 原始工具仍可直接注册范围更广的 JSON Schema，但统一代码生成会把不受支持的 schema 视为未知类型，不会假装自己能够强制执行。
- 每个属性的 `required: true` 仍是工具作者约定；原有推导路径暴露可选性缺陷后，类型级回归覆盖会锁定必填键不得为可选。
- 运行时测试和编译期测试覆盖所有根类型、恰好匹配一个分支时的重叠／无匹配行为、原始 schema 的默认开放语义、显式开放方式、有损 JSON 值、类型推导、核心投影和动态投影中的深层嵌套、动态注册中 JSON 不可见的键，以及非普通 schema 数组。
