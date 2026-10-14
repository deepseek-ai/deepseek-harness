---
description: "实验组地图：可公开安装的预稳定原型。"
kind: "package-group"
---

# packages/experimental

[English](README.md) | 中文

## 概述

实验性能力可按需安装和组合，但不提供产品支持承诺。包命名和发布遵循[实验包策略](../../scripts/experimental-package-policy.ts)。[可选组合规则](../../.agents/notes/implemented/architecture/2026-09-21-experimental-capabilities-as-optional-bundles.zh.md)决定哪些能力以默认关闭状态随安装提供，并在 GUI 插件管理器的官方分组显式启用。

## 目录

- [实验性、可选与官方](#status)
- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="status"></a>
## 实验性、可选与官方

**实验性**表示整个公开能力仍在评估中，不属于产品支持承诺。其行为或 API 可能变更，能力也可能被撤回；工程、安全、文档、测试和已发布数据的义务仍然适用。只有其完整公开约定均为实验性或仅限内部使用的包才属于本组；产品包中的实验选项仍归原产品职责所有。

**可选**表示用户显式选择该能力。**官方**表示项目维护并在插件页列出该包。两者均不表示成熟度；发布、默认安装和界面可见性也不决定成熟度。组外产品包承担维护职责，其公开 API 仍遵循仓库的预稳定政策。

晋升需要明确的产品职责、公开行为与限制、当前消费者、发布内容以及测试证据。晋升时将包移入对应产品组，应用该组的命名规则，并同时更新受影响的消费者。[子树规则](AGENTS.md)规定依赖隔离和发布要求。

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`tool-session-query`](tool-session-query/README.zh.md) | 按工作区授权的模型会话搜索、追踪与事件读取 | — |
| [`session-search`](session-search/README.zh.md) | 可选实验性全局会话搜索工具 | — |
| [`ralph-bundle`](ralph-bundle/README.zh.md) | 带隔离 workflow 引擎的可选重复委派 | — |
| [`terminal-bundle`](terminal-bundle/README.zh.md) | 可选全局持久终端工具 | — |
| [`badge-skill-bundle`](badge-skill-bundle/README.zh.md) | 可选 powered-by-dsh 徽章技能 | — |
| [`session-titles-bundle`](session-titles-bundle/README.zh.md) | 随对话中人类提示更新的可选标题 | — |
| [`hook-protocol`](hook-protocol/README.zh.md) | 钩子桥接的通信类型与持久事件 | — |
| [`hooks-claude-code`](hooks-claude-code/README.zh.md) | Claude Code 钩子桥接 | — |
| [`hooks-codex`](hooks-codex/README.zh.md) | Codex 钩子桥接 | — |
| [`webhook`](webhook/README.zh.md) | 已认证投递分发与 Workspace Session 创建 | `ctx.webhookRuntime` |
| [`webhook-github`](webhook-github/README.zh.md) | 带签名的 GitHub webhook 入口 | — |
| [`session-title-all-prompts-llm`](session-title-all-prompts-llm/README.zh.md) | 根据所有人类提示生成会话标题 | — |
| [`tool-terminal`](tool-terminal/README.zh.md) | 持久终端工具 | — |
| [`tool-ralph`](tool-ralph/README.zh.md) | 有界重复委派任务 | — |
| [`skill-badge`](skill-badge/README.zh.md) | powered-by-dsh 徽章技能 | — |
| [`translator`](translator/README.zh.md) | 免登录 Google 与 Bing 文本翻译 | `ctx.translator` |
| [`client-ui-cot-translation`](client-ui-cot-translation/README.zh.md) | 展开的思考内容翻译与原文控件 | `ctx.cotTranslation` |
| [`cot-translation-bundle`](cot-translation-bundle/README.zh.md) | 默认禁用的思考内容翻译组合 | — |
| [`speech-to-text`](speech-to-text/README.zh.md) | 具名语音识别 Provider | `ctx.speechToText` |
| [`speech-to-text-sensevoice`](speech-to-text-sensevoice/README.zh.md) | 托管本地 SenseVoice 推理 | — |
| [`api-speech-to-text`](api-speech-to-text/README.zh.md) | 带认证的临时转写 Remote | `ctx.speechController` |
| [`client-ui-voice-input`](client-ui-voice-input/README.zh.md) | 麦克风录音与版本检查后的草稿插入 | — |
| [`voice-input-bundle`](voice-input-bundle/README.zh.md) | 默认禁用的可选语音输入组合 | — |
| [`agent-team-profile`](agent-team-profile/README.zh.md) | Agent Teams 协作、工具与 Web UI 组合包 | — |
| [`agent-team`](agent-team/README.zh.md) | 具名 teammate，成员之间直接消息与持久共享任务板 | `ctx.agentTeams` |
| [`client-ui-agent-team`](client-ui-agent-team/README.zh.md) | Web Team roster、任务板与 teammate 导航 | — |
| [`auto-review`](auto-review/README.zh.md) | 显式 Web 层，在每个原生或 PTC inner 工具调用前使用同一模型审查 | — |
| [`claude-code-mods`](claude-code-mods/README.zh.md) | 把 Claude Code 模组作为插件运行：钩子链落在 harness 扩展点上，并在提示框上方绘制横幅 | `ctx.claudeCodeMods` |
| [`client-ui-claude-code-mods`](client-ui-claude-code-mods/README.zh.md) | 在提示框上方绘制模组树并把按钮点击发回的 Web 横幅 | — |
| [`ptc-runtime-python`](ptc-runtime-python/README.zh.md) | PTC 执行 seam 的 CPython 子进程后端 | `ctx.ptcRuntime` |
| [`computer-use-cua-driver-mcp`](computer-use-cua-driver-mcp/README.zh.md) | 通过 MCP 使用已安装的 Cua Driver | `ctx.computerUse` |
| [`computer-use-cua-driver-native`](computer-use-cua-driver-native/README.zh.md) | 嵌入 Cua Driver 原生 npm 运行时 | `ctx.computerUse` |
| [`browser-use-playwright-mcp`](browser-use-playwright-mcp/README.zh.md) | 通过 MCP 提供 Playwright 浏览器工具 | `ctx.browserUse` |
| [`browser-use-chrome-devtools-mcp`](browser-use-chrome-devtools-mcp/README.zh.md) | 通过 MCP 提供 Chrome DevTools 检查与浏览器控制 | `ctx.browserUse` |
| [`browser-use-stagehand-native`](browser-use-stagehand-native/README.zh.md) | Stagehand 浏览器操作与显式配置的原生模型 | `ctx.browserUse` |
| [`browser-use-runtime`](browser-use-runtime/README.zh.md) | 实验性提供方共享的 Session 浏览器资源 | — |
| [`inspector`](inspector/README.zh.md) | 用于 Host 调试、Client Runtime 检查、网络采集与 Cordis 树的跨 realm CDP hub | `ctx.inspector` |
| [`session-inspector`](session-inspector/README.zh.md) | 展示原始 Session 日志与 Chat 节点的 Sidebar 表格 | — |
| [`inspector-profile`](inspector-profile/README.zh.md) | 用于 Session 日志与 Chat 节点检查的可选 Web 组合包 | — |
| [`tool-agent-team`](tool-agent-team/README.zh.md) | 让模型创建、发消息与协调 teammate 的九个工具 | 按作用域注册工具到 `ctx.tools` |
| [`tool-worktree`](tool-worktree/README.zh.md) | 创建并进入工作树的可选 bundle 与模型工具 | `ctx.tools` |
| [`webworker-packer`](webworker-packer/README.zh.md) | 构建浏览器 worker 预览所消费的 gzip 压缩虚拟文件系统（VFS）镜像 | 库与 CLI（命令行界面），不使用 ctx key |
| [`webworker-runtime`](webworker-runtime/README.zh.md) | 在专用浏览器 worker 中运行 harness 插件树 | 库与 worker 入口，不使用 ctx key |
| [`worktree`](worktree/README.zh.md) | 创建具名 Git 工作树并改变调用 Session 的当前目录 | `ctx.worktrees` |

-----

<a id="related-documentation"></a>
## 相关文档

- [实验包发布说明](../../scripts/experimental-package-policy.ts)——默认公开与私有例外。
- [工作树](../../docs/subsystems/worktrees.zh.md)——显式创建分支与检出目录。
- [计算机操作](../../docs/subsystems/computer-use.zh.md)——桌面提供方选择。
- [浏览器操作](../../docs/subsystems/browser-use.zh.md)——浏览器提供方选择与 Session 所有权。
- [Agent Teams 子系统](../../docs/subsystems/agent-team.zh.md)——持久 Team 类型与 `ctx.agentTeams` 服务 API。
- [实验子树规则](AGENTS.md)——实验状态放宽了什么、不放宽什么。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
