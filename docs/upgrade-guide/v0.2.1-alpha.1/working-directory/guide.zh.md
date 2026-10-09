---
kind: upgrade-guide
description: "Session 工作目录替代内置 cwd 配置，工具展示元数据也会在嵌套 PTC 调用中生成。"
---

# 迁移工作目录配置与工具展示

[English](guide.md) | 中文

## 变更

下一版本移除 loop 的内置 `{{cwd}}` 提示词变量，以及 `@deepseek-ai/dsh-subagent-acp` 和 `@deepseek-ai/dsh-subagent-dsh-sdk` 的 `cwd` 配置键。自定义提示词模板保留未解析的 `{{cwd}}` 时，会在模型请求发出前失败。Session 当前执行目录作为必需的 user context 提供，并与原始 `Session.header.cwd` 分开持久化。

新子代理使用启动请求中显式提供的 `cwd`，未提供时捕获父代理的当前目录。已有进程保留各自的目录。切换执行目录不会改变原始项目，也不会授予额外写权限。

工具 `output.presentationMeta` 也会在成功的嵌套 PTC 调用中运行。投影仅假设原生顶层调用的作者需要调整实现。投影异常会使该次嵌套调用以 `ToolOutputError` 失败；程序读取的规范值与模型内容不变。

## 迁移

1. 在 home、profile 或本次调用的 `personaSuffix` 配置，以及 preset 的 `suffix` 字段中，移除引用 `{{cwd}}` 的目录语句，保留其他文本。suffix 变为空时省略或清空该字段。[工作目录服务](../../../../packages/session/working-directory/README.zh.md)负责提供目录上下文。
2. 从 profile patch 中的 ACP 与 DSH-SDK 子代理 provider 行移除 `config.cwd`。为单个子代理选择目录时，在其[启动请求](../../../subsystems/subagent.zh.md)中传入 `cwd`。改变父代理执行目录时，先调用 `working_directory({ cd: "/absolute/project" })`，再启动子代理。
3. 在相关 Session 中调用 `working_directory({})` 并确认报告的目录。启动一个不带目录覆盖的子代理并检查其执行目录；子代理需要另一个 checkout 时，显式提供启动 `cwd`。仅用 `Session.header.cwd` 读取原始项目标识或权限根目录，当前目录操作使用工作目录服务。
4. 保持自定义 `output.presentationMeta` 投影纯净，并从调用参数和规范结果返回可用于 JSON 的元数据。分别执行原生调用和嵌套 PTC 调用，确认记录的元数据指向操作的实际目标，同时不改变调用结果。

动态上下文 provider 会在请求准入时再次求值，晚于 pre-step 监听器与路由准备。返回当前状态，不依赖每个步骤只求值一次。对已注册上下文的转换应在其 provider 内完成；准入刷新会替换缓存文本，同时保留仅由组装添加的上下文，以及已接纳的系统提示词、工具 schema 与变量。
