---
name: tencent-meeting
description: 腾讯会议插件：通过 tmeet 使用腾讯会议的会议创建与查询、受邀者管理、录制与转写、智能纪要和元宝纪要、会议报告、会中控制和事件订阅。用户提到腾讯会议、会议号、会议录制或纪要时，先加载本技能，再读取 tmeet-skill 子指南。
---

# 腾讯会议插件

## DSH 指引

- 在面向用户的回复中，把这项集成称为“腾讯会议插件”。`tmeet` 由腾讯会议插件安装，按当前 runtime context 给出的绝对路径运行，不要直接按名称运行。不要执行 `npm install -g @tencentcloud/tmeet`，也不要用其他方式另装或升级 `tmeet`。
- `tmeet` 的登录保存在这台电脑的默认配置目录，与用户自己终端里的 `tmeet` 共用。除非用户要求，不要执行 `tmeet auth logout`。
- 首次运行 `tmeet` 业务命令前，先读 `tmeet-skill` 子指南。本节与该子指南冲突时以本节为准：跳过它“安装与初始化”一节的安装检查；跳过运行 `scripts/agent_init.py` 的要求，DSH 不提供这个脚本，`tmeet` 不依赖它。
- 命令提示未登录或需要重新登录（例如 `user config is empty`、`user identity expired`、`refresh token failed`）时，先请用户在「插件」中打开腾讯会议插件页面，点击“连接腾讯会议”并完成授权；用户完成后再继续。只有用户要求在本次对话中完成登录时，才执行 `tmeet auth login --no-browser`：它先输出授权链接，再最多等待 5 分钟，把链接完整告诉用户。它会把登录凭据写到工作区之外，保存被拒绝时这次授权也会作废：第一次运行就把 Shell 工具的 `sandbox_permissions` 设为能写工作区之外的最窄模式，并填写 `justification`。
- 其他 `tmeet` 命令在现有沙箱中运行；只有凭据、锁或日志写入被拒绝时，才设置 `sandbox_permissions`。
- 不要索取或输出 AccessToken、RefreshToken 等凭据。

## 子指南索引

- `tmeet-skill`：腾讯会议官方 CLI 的使用说明，涵盖全部命令、查询命令的选择准则、安全规则、需要用户二次确认的操作和常见错误；首次运行 `tmeet` 业务命令前先读。会议、录制、报告、通讯录、会中控制、纪要、应用信息、事件和问题排查各模块的参数与示例在它的 `references/` 中。

## 打开子指南

- 子指南不是独立的 skill，不要用 `skill` 工具加载；用文件读取工具打开本技能目录下的 `skills/tmeet-skill/SKILL.md`。
- 子指南中的相对路径（例如 `references/tmeet-meeting.md`）相对子指南自己的目录 `skills/tmeet-skill/`。
