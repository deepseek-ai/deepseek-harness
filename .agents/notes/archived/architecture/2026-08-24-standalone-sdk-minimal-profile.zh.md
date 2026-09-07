# Agent Note: dsh 下的独立 sdk-minimal profile

Status: implemented
Archived: 2026-09-04

[English](2026-08-24-standalone-sdk-minimal-profile.md) | 中文

## 问题

极简 SDK agent 需要显式插件清单。若把它表达为完整 `sdk` profile 上的 overlay，所有 `dsh-base` 服务仍保持挂载，排除逻辑则依赖分散在无关插件中的筛选器与 disable 配置项。以后新增的 base 配置项即使没有进入面向模型的工具清单，也可能改变运行时行为。

由调用方提供完整 Cordis 配置树可以得到确切清单，但会绕过 profile 初始化、组合包解析、持久插件管理、home 与调用 patch 层，以及由 `dsh` 拥有的进程生命周期。极简模式需要在组合层排除功能，同时不能创建另一个 launcher 或 Python 自有应用。

## 决策

### 启动与所有权

`dsh --profile sdk-minimal` 是随附的仅启动时 profile。其 manifest 只列出 `@deepseek-ai/dsh-sdk-minimal`，不列出 `@deepseek-ai/dsh-base`。该组合包在 launcher 的空 profile 根之上插入完整 Cordis 配置树，而 profile patch、home patch 与有序调用 patch 仍在其上保持普通优先级。

`dsh` CLI 仍是唯一应用 launcher。Python 示例通过公开 `profile` 字段与显式 Harness home 选择 `sdk-minimal`。Python 不暴露完整配置或任意 argv 路径。完整 Python 与 TypeScript SDK 的默认值仍是 `sdk`。

该组合包复用 `@deepseek-ai/dsh-sdk-app` 提供命令 help、stdin EOF 与有界关闭。启动提供方接受 profile 名称配置，因此两个 SDK profile 都能呈现自己的实际命令，且无需复制进程生命周期代码。

### 显式组合

该组合包拥有一个 DeepSeek 适配器、SDK JSON-RPC 服务、显式 agent 核心、本地子进程与不受限文件系统提供方、按平台选择的持久 shell、字符串替换 editor，以及位于 `$DSH_HOME/sessions` 的未压缩 JSONL 会话。Linux 与 macOS 挂载 Bash，Windows 挂载 PowerShell。SDK 初始化请求拥有模型 id；`DSH_CONTEXT_WINDOW` 为不在适配器建议目录中的模型提供后备容量。Persona 来自 `DSH_SYSTEM_PROMPT`，凭据来自 `DEEPSEEK_API_KEY`。

Harness 身份、运行时上下文、workspace 指令、skills、面向模型的 job 控制、compaction、settings、托管凭据、遥测、Web 工具、subagent 与其他所有 base 配置项均不存在，而不是被隐藏。该 profile 固定使用 `danger-full-access`、`maxTokensAsSuccess: false` 与仅启动时 patch 加载。

### 自定义与 Web

`dsh plugin --profile sdk-minimal add <package>` 安装持久依赖与组合包层。Profile 自身的 `cordis.patch.yml`、home patch 与 Python `patches` 分别提供持久、机器本地和逐次调用的配置项变更。自定义可以扩展或替换显式配置树，但仍经过同一个 launcher 与 profile 解析。

Python 运行时继续打包 `dsh-web-app` 与前端产物。`dsh web` 会从已安装 wheel 启动这个独立浏览器应用；Python SDK client 不能选择 `web`，因为其中没有 JSON-RPC server 配置项。

## 既有决策与取代关系

本决策部分取代[应用 profile 使用同一个 dsh launcher](2026-08-22-single-dsh-application-launcher.zh.md)中的 base 优先规则与独立配置树否决。显式清单属于产品行为时，可以使用仓库自有且有版本的独立 profile 组合包；由调用方提供的完整配置树与替代可执行程序仍被否决。

本决策也取代 [Python SDK 运行时通过 dsh profile launcher 启动](2026-08-23-python-sdk-dsh-profile-runtime.zh.md)中的极简 overlay 实现，以及 [profile 插件组合包](2026-08-05-profile-plugin-bundles.zh.md)中默认 profile 均以 base 开头的表述。这些 Agent Note 对 launcher 所有权、Python 打包与 home 要求、普通 profile 分层及插件管理仍保持独立权威。没有活跃 Agent Note 被完全取代或符合归档条件。

## 验证

组合包测试固定确切配置项与依赖清单。Profile 模板与配置 dump 测试固定单组合包 manifest、仅启动时生命周期、`dsh-base` 缺席与模块 HMR 缺席。Keyless 源码测试启动真实 `dsh --profile sdk-minimal` 进程、完成一个回合并断言生成的 manifest。Installed-wheel 极简场景通过已提交的模型可见快照固定完整系统提示词和两个对外公布的工具，同时经由打包可执行程序验证持久 shell 状态、editor 文件效果与 JSONL 持久化。

## 考虑过的替代方案

**继续把极简模式作为 `sdk` 上的 overlay。** 否决：筛选面向模型的工具不会移除 base 服务、提示词贡献方、持久化选择或后续运行时行为。该方案还要求共享 SDK server 提供根工具筛选，并要求 system-prompt 配置提供 complete-persona 快捷项；这两个共享接口均不再携带这些组合控制项。

**恢复 Python `cordis` 参数或由环境选择的完整配置。** 否决：这会重新创建 Python 自有应用组合，并绕过 profile 插件管理与 launcher 生命周期。

**创建第二个极简 SDK 启动插件。** 否决：唯一变化是 profile 感知的 help；SDK 启动提供方可以拥有该配置，同时把 EOF 与关闭行为保持在一处。

**从 Python 运行时闭包移除 Web 包。** 否决：wheel 分发普通 `dsh` 应用，而且 Python 部署也可能需要 `dsh web`；这些应用由 profile 选择隔离，而不是由打包差异隔离。

## 后果

极简模型与运行时清单只有在所属组合包变化，或受信任的上层 patch 扩展它时才会变化。代价是刻意重复一棵较小的完整应用树，并在该 profile 中省略共享 settings、凭据、策略控制、遥测与 Web 功能。需要这些服务的用户选择完整 `sdk` profile；两种选择仍共用一个 launcher、一套 profile 词汇与一个打包运行时。
