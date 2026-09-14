# Agent Note: PTC 运行时词汇

Status: implemented

[English](2026-09-12-ptc-runtime-vocabulary.md) | 中文

## Problem

PTC 模式及其执行提供方需要在包清单、服务查找、公共类型、配置和文档中使用同一个可搜索的名称。混合的运行时前缀使维护者难以从 profile 追踪到提供方实现及打包后的引导程序。

## Decision

执行能力使用 `ptc-runtime` 包族、`PtcRuntime` 类型和 `ctx.ptcRuntime`。Node 与私有实验性 Python 提供方共享这套词汇。Profile 条目标识符、内部引导选择器、编译器引用、包导出和生成目录使用相同名称；不提供兼容包或第二份服务注册。

运行时包与 SDK 语言类型的 PTC 名称取代[早期命名决定](../../archived/architecture/2026-08-25-rename-code-mode-to-ptc.md)记录的例外，使提供方与调用方使用同一套可搜索的词汇。

面向模型的 `run_code` 操作、其 `code` 源码参数和稳定失败标识保留描述性名称。一般源码术语、错误码、外部项目名称与 URL、历史迁移标识符以及封存 Agent Note 保留原有含义和记录拼写。这一命名决定不改变程序执行、沙箱权限、期限、绑定或 Session 格式。

## Alternatives considered

**保留单独的通用运行时前缀。** 提供方仍独立于工具和 Session 的所有权，但其包名与服务名标识 PTC 执行能力。单独的前缀会增加第二个名称，却没有分离出独立演进的功能。

**替换每一处“code”。** 程序源码、操作名称、外部引用和历史记录描述不同对象。替换这些内容会改变运行时命名决定之外的公共操作或已记录事实。

**发布旧名称别名。** API 尚未稳定，仓库中的每个消费方共同迁移。别名会保留重复的包和服务身份，使后续查找含糊不清。

## Consequences

部署配置和源码消费方共同使用 PTC 包名与配置标识符。已有的 `run_code` 记录与错误路由仍可读取。机械审计比较重命名前后的源码 token，保留外部 URL 和冻结记录，并检查每一处残留旧运行时名称；构建后的 profile、包和 snapshot 检查覆盖静态导入无法验证的消费方。
