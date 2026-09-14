---
description: "DeepSeek Harness 包工作区：packages/ 下的 npm 包如何分组、每个组负责什么，以及约束它们的约定。"
kind: "package-group"
---

# 包

[English](README.md) | 中文

## 概述

harness 由 `packages/` 下的 npm 包组装而成，按能力系列分组：会话与 agent loop（智能体循环）、面向模型的工具、shell 与文件系统执行、Web 访问、subagent 等等。把本页当作顶层地图使用：先找到拥有某能力的组，再打开其 README 查看包列表。每个包都以 `@deepseek-ai/dsh-*` 为作用域、只属于一个组；每个组的 README 都是该能力系列的权威包映射。

## 目录

- [包分组](#package-groups)
- [发布预期](#release-expectations)
- [依赖](#dependencies)
- [包 README 约定](#package-readme-contracts)
- [开发备注](#dev-note)

-----

<a id="package-groups"></a>
## 包分组

每个包只属于一个组；新包加入现有组，新组则更新其自身 README 与本表。

| 组 | 职责 |
|---|---|
| [`core/`](core/README.zh.md) | 产品 API 主干：会话、提示词、工具、agent 服务与具体循环 |
| [`api/`](api/README.zh.md) | Remote BFF 装配与 Typert RPC 网关 |
| [`typert/`](typert/README.zh.md) | 类型图生成、产物加载与运行时注册表 |
| [`goal/`](goal/README.zh.md) | 同会话 goal 的持久化与生命周期 |
| [`schedule/`](schedule/README.zh.md) | 仅限会话内的定时后续操作 |
| [`feedback/`](feedback/README.zh.md) | 人类反馈的采集与命令 |
| [`identity/`](identity/README.zh.md) | 共享匿名身份 |
| [`llm/`](llm/README.zh.md) | LLM（大语言模型）能力系列：抽象服务 + 提供方适配器 |
| [`subprocess/`](subprocess/README.zh.md) | 子进程能力系列：Service Definition + 本地进程树提供方 |
| [`ssh/`](ssh/README.zh.md) | POSIX 远端连接及配套文件系统、子进程与沙箱提供方 |
| [`shell/`](shell/README.zh.md) | Bash 能力系列：执行器 seam、本地实现、面向模型的工具 |
| [`terminal/`](terminal/README.zh.md) | 持久 PTY 能力系列：限定所有者范围的会话、本地实现、面向模型的工具 |
| [`ptc-runtime/`](ptc-runtime/README.zh.md) | PTC 执行能力族：Service Definition + 沙箱 Node 提供方 + PTC mode Consumer |
| [`computer-use/`](computer-use/README.zh.md) | 按名称独占注册桌面提供方 |
| [`browser-use/`](browser-use/README.zh.md) | 按名称独占注册浏览器提供方 |
| [`sandbox/`](sandbox/README.zh.md) | 进程限制 seam；bwrap、Landlock、Seatbelt 后端 |
| [`fs/`](fs/README.zh.md) | 文件系统能力系列：seam、本地实现、面向模型的文件工具、发现工具 |
| [`lsp/`](lsp/README.zh.md) | LSP 能力系列：seam、通用 stdio 提供方和 `lsp` 工具 |
| [`skill/`](skill/README.zh.md) | skill（技能）能力系列：提供方注册表、本地提供方、面向模型的目录／loader |
| [`compaction/`](compaction/README.zh.md) | 压缩（compaction）能力系列：Service Definition + 基础提供方 + 命令 Consumer |
| [`context/`](context/README.zh.md) | 模型可见请求上下文：workspace 指令、时间上下文、引用 |
| [`subagent/`](subagent/README.zh.md) | subagent 能力系列：提供方注册表约定和面向模型的委托工具 |
| [`jobs/`](jobs/README.zh.md) | 通用后台任务运行时和面向模型的作业控制工具 |
| [`experimental/`](experimental/README.zh.md) | 预稳定原型，包含显式私有例外 |
| [`workflow/`](workflow/README.zh.md) | 工作流 seam、PTC 进程引擎、面向模型的 `workflow`／`ralph` 工具 |
| [`webhook/`](webhook/README.zh.md) | 已验证外部事件、受信规则与即发即弃 Workspace 会话 |
| [`web/`](web/README.zh.md) | Web 能力系列：seam、搜索／获取提供方、面向模型的 Web 工具 |
| [`attachment/`](attachment/README.zh.md) | 持久附件标识、校验、本地内容寻址存储 |
| [`spill/`](spill/README.zh.md) | spill 能力系列：存储 seam、本地实现、工具结果 spill 策略 |
| [`todo/`](todo/README.zh.md) | 面向模型的 `todo_write` 工具 |
| [`plan/`](plan/README.zh.md) | Plan 协作状态，提供直接进入命令与经评审的退出 |
| [`preset/`](preset/README.zh.md) | 由 preset `cordis.yml` 按会话组装 agent |
| [`guard/`](guard/README.zh.md) | 循环卫生守卫：建议性重复调用提醒 + `tools/execute` 截止时间强制执行器 |
| [`bundle/`](bundle/README.zh.md) | 可安装的 `dsh --profile` 补丁层 |
| [`extensions/`](extensions/README.zh.md) | agent 运行时自修改：实时插件／服务检查与模型所写挂载／卸载 |
| [`mcp/`](mcp/README.zh.md) | 将外部 Model Context Protocol 服务器的工具接入为原生工具 |
| [`hooks/`](hooks/README.zh.md) | 钩子桥接 + 共享的 Claude Code／Codex 线协议库 |
| [`session/`](session/README.zh.md) | 持久会话数据平面：持久化 seam + 后端、投影 seam、基于日志的标题、会话上报 |
| [`session-query/`](session-query/README.zh.md) | 会话检索系列：逻辑语料库、有界读取、血缘、语义过滤、SQLite 全文搜索 |
| [`settings/`](settings/README.zh.md) | 用户设置 seam + 基于文件的提供方 |
| [`credentials/`](credentials/README.zh.md) | 凭据引用与凭据记录 seam + 环境变量优先于 `.env` 的提供方 + 需要向人询问的授权流程 |
| [`storage/`](storage/README.zh.md) | 非会话存储中枢 + 后端 + 领域形式 |
| [`workspace/`](workspace/README.zh.md) | Workspace 实体 |
| [`sdk/`](sdk/README.zh.md) | 进程外 SDK：JSON-RPC 协议与 TypeScript 客户端／服务器 |
| [`acp/`](acp/README.zh.md) | 仅面向自动化的 ACP（Agent Client Protocol）服务器 |
| [`interaction/`](interaction/README.zh.md) | 人机协作平面：批准／交互 seam、权限预设、命令、询问用户的工具 |
| [`boot/`](boot/README.zh.md) | 共享的 app bin 启动粘合层 |
| [`host/`](host/README.zh.md) | web GUI 宿主半侧：API 网关 + HTTP 路由服务器 |
| [`client/`](client/README.zh.md) | web GUI 浏览器半侧：shell、协议层、对象服务、slot、`ui-*` 插件 |
| [`test-support/`](test-support/README.zh.md) | 测试基础设施（testkit、回放、Loader 冒烟测试） |
| [`runtime-diagnostics/`](runtime-diagnostics/README.zh.md) | 运行时诊断：按包归属的运行时不变式检查与报告 |
| [`util/`](util/README.zh.md) | 组间共享的低层零依赖工具（`Branded<B>`、home／路径辅助函数、超时、留存） |

-----

<a id="release-expectations"></a>
## 发布预期

大多数组属于产品组，提供稳定 API。例外：`experimental/` 发布时不提供稳定性或支持承诺，`test-support/`、`runtime-diagnostics/` 与 `util/` 是兼容性预期较低的支持组。

-----

<a id="dependencies"></a>
## 依赖

依赖图由工具生成：[docs/module-graph.md](../docs/module-graph.zh.md)（`pnpm run gen-module-graph`，CI 中有新鲜度门禁）。

**扩展插件依赖 Service Definition，绝不依赖具体提供方。** `dsh-agent-loop` 可替换；UI、钩子和工具插件使用 `dsh-agent`。组合包可以依赖主干插件。能力在需要独立演进时分离 Service Definition／Service Provider／Consumer 角色；详见[能力 seam](../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md)。

-----

<a id="package-readme-contracts"></a>
## 包 README 约定

每个包 README 都覆盖用途、配置、扩展点与[模型体验](../docs/cookbook/adding-a-package.zh.md#4-write-the-package-readme)，列入模型无关[省略允许清单](../scripts/verify-package-readme-model-experience.ts)的包除外。它还要包含 `## Known Limitations and Deferred Work`，或列入其[允许清单](../scripts/verify-package-readme-limitations.ts)。包约定——导出、服务访问、不变式、测试——见 [packages/AGENTS.md](AGENTS.md)。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
