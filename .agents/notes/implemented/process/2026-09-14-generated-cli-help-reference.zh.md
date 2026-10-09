# Agent Note: 从命令帮助生成 CLI 参考

Status: implemented

[English](2026-09-14-generated-cli-help-reference.md) | 中文

## Problem

启动器选项、profile 选项和嵌套命令由不同部分负责。手工维护的命令参考可能遗漏子命令或保留过时的默认值。

## Decision

CLI 参考采集受支持的 `dsh` 启动器帮助、插件转发器帮助和各随附 profile 的帮助，并递归发现每页 `Commands:` 段落列出的子命令。随附 profile 的名称来自 `PROFILE_TEMPLATES`。每页都保留完整的帮助文本；相同的别名帮助只展示一次，并列出所有调用形式。

生成过程使用临时 Harness home 和 Agents home。帮助在应用开始工作前退出，不需要服务器或模型。插件转发器在 pnpm 参数之前提供自己的帮助；pnpm 命令之后的选项仍作为 pnpm 输入。

生成的双语页面保留 CLI 输出的原始语言。`verify-cli-help` 比较完整页面和配对记录，并随文档检查一起运行。

## Alternatives considered

另一份命令清单或专供帮助使用的运行时 API 会重复解析器的定义。读取实际帮助，可以让参考文档始终对应用户收到的说明、选项、默认值和示例。

## Consequences

命令变化通过同一个生成器更新参考文档。审阅者可以直接比较完整帮助，无需自行拼接各个命令的调用结果。
