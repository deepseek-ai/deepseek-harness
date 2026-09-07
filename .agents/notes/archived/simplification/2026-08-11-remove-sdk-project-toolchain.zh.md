# Agent Note: 移除 SDK 项目工具链

Status: implemented
Archived: 2026-09-04

[English](2026-08-11-remove-sdk-project-toolchain.md) | 中文

## 问题

仓库曾包含一套从未发布且没有消费方的开发者项目产品。`@deepseek-ai/create-sdk` 用于生成可编辑的 Cordis 项目；`@deepseek-ai/dsh-scripts` 提供 `dsh-sdk` 的开发、构建、启动、配置和插件安装命令；`@deepseek-ai/dsh-helper` 协调功能定义与多文件项目编辑；`@deepseek-ai/dsh-telemetry` 上报启动器活动。该设计旨在让生成的项目保持可编辑，并使项目创建与后续配置对依赖、Cordis 配置项、环境变量占位符和归属文件采用同一套定义。

没有任何项目是通过公开发布版创建的，当前仓库和外部消费方也都不需要这套生命周期。保留它就意味着继续维护 4 个包、2 套交互式命令产品、项目模板、包管理器适配器、配置调和、启动器遥测、1 个仓库 skill（技能）及其测试和文档，却没有证据表明这项产品边界应当存在。

同一 `scaffold/` 分组还包含各自独立使用的 SDK 协议、TypeScript 客户端和 JSON-RPC 服务器。这些包为 Python SDK、`dsh-sdk` subagent 提供方和 JSON-RPC 示例提供支持；其运行时协议不依赖生成的项目或被移除的启动器。

## 决策

删除 SDK 项目工具链。`@deepseek-ai/create-sdk`、`@deepseek-ai/dsh-scripts`、`@deepseek-ai/dsh-helper` 和 `@deepseek-ai/dsh-telemetry` 包及其二进制文件、测试、模板、功能目录、项目编辑模型、包管理器支持、启动器遥测和仓库项目创建 skill 均不提供替代实现或兼容层。与其对应的 workspace、构建、测试、打包、文档生成器、vendor scope 重写和依赖记录也一并移除。

保留运行时 SDK。`@deepseek-ai/dsh-sdk-client`、`@deepseek-ai/dsh-sdk-protocol` 和 `@deepseek-ai/dsh-sdk-jsonrpc-server` 保持原样，从 `packages/scaffold/` 移至 `packages/sdk/`；其 npm 名称和协议交互行为保持不变。消费方继续提供一个可执行文件和一份外置 `cordis.yml`，JSON-RPC 服务器仍是由该配置选择的普通插件。[仓库命名约定](../architecture/2026-08-11-repository-naming-contract-and-rename-ledger.zh.md)负责规定 `SDK` 在仓库中的唯一含义和保留的包名；本说明负责记录已删除的工具链。

被取消的开发者项目、项目编辑和后续能力提案予以删除，而不是保留为活跃或已否决记录。本 Agent Note 保留这些提案共有的动机、不交付该产品的决策、放弃的能力，以及重新考虑这一决定的条件。已冻结的归档 Agent Note 仍是历史快照，不作修改。

## 验证

workspace 中不再存在上述 4 个已删除包名或 2 套已移除的命令产品。包聚合配置、源码路径映射、包元数据、测试收集配置、发布约束、生成目录、依赖声明文件和锁文件都只解析 `packages/sdk/` 下的 3 个运行时 SDK 包。运行时 SDK 包测试、已构建服务器的冒烟测试、TypeScript 消费方、仓库文档门禁、构建和 hygiene 检查共同固定了保留的行为，并确保不存在陈旧的包路径。

## 考虑过的替代方案

**只删除初始化器。** 不予采纳，因为 `dsh-sdk`、共享项目模型和启动器遥测都是为了操作该初始化器创建的项目，而现有项目均不需要这些能力。

**保留仅用于报错的包或命令别名。** 不予采纳，因为这些命令都从未公开发布。墓碑会在不存在兼容义务的情况下保留包与可执行文件的接口范围。

**同时删除运行时 SDK 栈。** 不予采纳，因为 Python SDK、进程外 Harness subagent 提供方和 JSON-RPC 示例目前仍是协议、客户端和服务器的消费方。

**将运行时栈继续留在 `packages/scaffold/` 下。** 不予采纳，因为该分组剩余内容均不再负责搭建项目。`packages/sdk/` 直接说明了保留内容的职责，因为 `SDK` 在仓库中只有一个含义：受支持的 Python 与 TypeScript SDK 所使用的 JSON-RPC 客户端／服务器协议。DeepSeek Harness 本身不是 SDK 项目。

## 后果

DeepSeek Harness 不再创建或管理独立的开发者 SDK 项目。自动项目生成、功能树配置、本地插件脚手架、项目本地的开发、构建和启动命令，以及面向开发周期的启动器遥测均有意不再提供；普通应用和运行时分发仍通过各自归属的包和 `cordis.yml` 文件组合插件。

仓库删除完整的支持图，而不是继续保留休眠抽象。重新引入项目工具链必须先有真实消费方，并基于该消费方的工作流提出新提案；默认情况下，不会复活这些包或已删除且不承诺兼容的格式。
