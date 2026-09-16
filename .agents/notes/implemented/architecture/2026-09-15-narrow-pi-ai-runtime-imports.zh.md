# Agent Note：收窄 pi-ai 运行时 import

Status: implemented

[English](2026-09-15-narrow-pi-ai-runtime-imports.md) | 中文

## 问题

基础 bundle 会在没有配置路由时挂载 `dsh-llm-pi-ai`，让 Models 设置页能够提供 pi-ai provider。为了 model helper 而 import pi-ai 聚合入口还会求值其导出的 TypeBox namespace，即使所有 Session 都使用 `dsh-llm-deepseek`，每次应用启动也会额外加载数百个模块。

## 决策

`dsh-llm-pi-ai` 不再运行时 import pi-ai 聚合入口。Catalog 与登录元数据继续使用 `providers/all`；协议实现继续使用现有 `api/*.lazy` 入口；overflow 检测使用 `utils/overflow`。包内 `models.ts` 提供适配器所需的三个 model helper。Collection 来自 pi-ai 公开的 `builtinModels()` 实现，并在安装路由 provider 前清空。Provider constructor 实现本适配器传入的静态单协议分支。Reasoning level 选择按照 pi-ai 的升级顺序读取其公开 `Model` 元数据。

聚合入口的 type-only import 会被 TypeScript 擦除，因此予以保留。构建产物的 import profile 会解析 153 个 pi-ai 模块，不包含 TypeBox 模块或 pi-ai 聚合入口。

## 考虑过的替代方案

- **给 pi-ai 增加 `models` export。** 拒绝，因为本包可以直接使用已经公开的 provider、API、utility 与 model metadata interface，无需修改上游 export map。
- **动态 import 聚合入口。** 拒绝，因为休眠适配器不需要其中任何内容；完全排除该入口会直接删除工作，而不是把工作移动到之后的操作。
- **复制 pi-ai 完整的 Models 实现。** 拒绝，因为 `builtinModels()` 已经返回包含其认证与存储行为的上游实现。清空其中的 provider 可以保留该实现，无需维护 fork。

## 后果

应用仍会加载 `providers/all`，因此配置与授权界面保留完整的已安装 provider 目录。构建 adapter snapshot 时会短暂构造并清空内置 provider set，再安装已解析的路由 provider。包内 provider constructor 只接受静态 model 和一个协议实现；若要增加动态 model、filter 或多协议自定义路由，必须同时扩展该本地函数及其测试。
