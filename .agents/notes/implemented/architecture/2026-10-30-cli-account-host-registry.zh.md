# Agent Note: CLI 应用账号的 Host 注册表

Status: implemented

[English](2026-10-30-cli-account-host-registry.md) | 中文

## Problem

飞书、企业微信、钉钉和腾讯会议等 CLI 应用插件在插件页显示其厂商 CLI 保存的账号：带状态和按钮的区块、标题旁标签、开启引导、确认和提示。每个插件的账号运行时本来就在 Host 上运行，而每个插件需要的界面都一样。如果在浏览器中注册账号，每个插件都要提供一个浏览器包，带着自己的账号 Remote、流、展示推导和字典，尽管这个包知道的内容 Host 全都知道。

## Decision

[`@deepseek-ai/dsh-client-ui-cli-account`](../../../../packages/client/ui-cli-account/README.zh.md) 中的 Host 服务 `ctx.cliAccounts` 保存这些账号。应用插件的 Host 行注册其 `CliAccountRuntime` 作为来源，以及页面按钮可以启动的操作及其成功文本、文案，和把账号视图映射为 display 的展示函数，display 中的文本为 `LocalizedText`。它在 `ctx.inject(['cliAccounts'], …)` 内注册，因此没有注册表的 profile（如 headless）加载插件时不带页面。Web 应用组合加载注册表。

注册表通过一个 `cliAccounts` Remote 提供所有账号：`watch` 流式推送每个账号的条目，`start` 和 `cancel` 按包路由，并且只接受已注册的操作。一个浏览器一半渲染所有账号的界面，并保存属于单个浏览器的状态：只在发起操作的浏览器中打开授权链接，只在那里报告提示，并在自己的操作未完成时忽略点击。所有账号共用的文案位于套件字典；其余文案都以 `LocalizedText` 的形式来自插件，由浏览器按当前语言解析。

## Alternatives considered

**在浏览器中注册。** 每个插件的浏览器一半向浏览器中的 `ctx.cliAccounts` 注册，并跟随自己的账号 Remote。这需要每个插件各有一个浏览器包和一个 Remote，而浏览器一半只是重复 Host 已经知道的内容。把套件列入 `PLATFORM_MODULES`，让这些包能在运行时导入它，会使一个功能包成为 shell 基线的一部分。

**在浏览器中推导展示。** Host 可以流式推送原始账号视图，由每个插件的浏览器展示函数映射。这仍然需要每个插件一个浏览器包。在 Host 上生成 `LocalizedText` 让每个插件的文本留在其 Host 行中，浏览器仍可在不往返 Host 的情况下解析语言。

**把单个浏览器的状态放到 Host 上。** 把链接和提示发布给所有浏览器，会在每个打开的窗口中打开授权链接，并把一个用户的操作报告给所有窗口。把这些状态留在浏览器中，链接只在用户要求的地方打开，结果也只报告给该浏览器。

## Consequences

CLI 应用插件不为账号提供浏览器代码，也不提供账号 Remote；其 Host 行注册账号，由套件渲染。每个浏览器在 Web 应用加载时为所有账号打开一条流，Host 为每条新流检查每个空闲账号。Host 行加载失败的插件不显示账号区块，插件页仍会列出该插件包及其加载失败。显示词汇是固定的：五个阶段、命令为 `start`、`cancel` 或 `open` 的按钮、附加行，以及带分类诊断的失败信息；需要其他控件的插件要扩展套件。

Host 测试固定注册、每条新流触发的检查、变化合并、操作路由和卸载。客户端测试固定在发起操作的浏览器中打开链接、提示、未完成操作保护，以及每个账号的插槽注册及其移除。
