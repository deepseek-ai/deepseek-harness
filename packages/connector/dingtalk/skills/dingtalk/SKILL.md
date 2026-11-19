---
name: dingtalk
description: 钉钉插件：通过 dws 使用钉钉的日程与会议室、待办、群聊与机器人、通讯录、文档、钉盘、知识库、AI 表格、邮箱、AI 听记、审批、考勤、日志、白板、AI 搜问和事件监听等功能。用户提到钉钉或这些功能，或给出 alidocs.dingtalk.com 等钉钉链接时，先加载本技能，再按索引读取对应子指南。
---

# 钉钉插件

## DSH 指引

- 在面向用户的回复中，把这项集成称为“钉钉插件”。`dws` 由钉钉插件下载，按当前 runtime context 给出的绝对路径运行，不要直接按名称运行。不要用 npm、官方安装脚本或 `dws upgrade` 另装或升级 `dws`，也不要运行 `dws skill setup` 把技能装进 Agent 目录。
- `dws` 的登录保存在这台电脑的 `~/.dws` 和系统钥匙串，与用户自己终端里的 `dws` 共用。除非用户要求，不要执行 `dws auth logout`。
- 本节与子指南冲突时以本节为准。
- 检查登录状态只用 `dws auth status --readonly --format json`，子指南要求运行 `dws auth status` 时也这样运行。不带 `--readonly` 的检查要写 `~/.dws`，写入被文件沙箱拒绝时会把已登录报告成“未登录”，不能作为依据。
- 只有上面的检查返回 `authenticated: false`，或命令明确提示登录失效时，才请用户在「插件」中打开钉钉插件页面，点击“连接钉钉”并完成授权；用户完成后再继续。只有用户要求在本次对话中完成登录时，才执行 `dws auth login --no-browser`：它在 stderr 输出授权链接，再最多等待 6 分钟，把链接完整告诉用户；授权回调地址是 `127.0.0.1`，用户必须在这台电脑的浏览器中打开链接。它会把凭据写到工作区之外，保存被拒绝时这次授权也会作废：第一次运行就把 Shell 工具的 `sandbox_permissions` 设为能写工作区之外的最窄模式，并填写 `justification`。
- 其他 `dws` 命令先在现有沙箱中运行。访问钉钉数据的命令都要写 `~/.dws` 下的锁文件：命令因为打不开锁文件，或写不了凭据、缓存、日志而失败时，是文件沙箱拒绝了写入，不是未登录，不要请用户重新连接，设置 `sandbox_permissions` 和 `justification` 重跑同一条命令。本次对话出现过一次这种拒绝后，后面访问钉钉数据的命令第一次运行就这样设置。
- 登录或命令提示组织尚未开启 CLI 数据访问权限时，告诉用户需要组织管理员在钉钉开发者后台开启 CLI 访问，也可以在授权页向管理员申请。
- 不要索取或输出 token、refresh token、Client Secret 等凭据。

## 子指南索引

- `dingtalk-shared`：全局执行契约和跨产品导航；泛称钉钉、跨产品编排、需要判断链接类型或产品边界不清时先读。
- `dingtalk-calendar`：日程、会议室、闲忙和参会人；视频会议的发起和会中控制见 `dingtalk-misc`。
- `dingtalk-todo`：待办的创建、指派、完成、查询和循环待办。
- `dingtalk-chat`：群聊与消息的收发和搜索、建群和群管理、机器人和 Webhook、群文件。
- `dingtalk-contact`：通讯录精确查询：按 userId 查详情、部门和职位，按完整手机号反查用户；按姓名模糊找人见 `dingtalk-aisearch`。
- `dingtalk-aisearch`：AI 搜问：按语义找人，按主题或行为跨来源检索。
- `dingtalk-doc`：钉钉在线文档的查找、读写、块、评论、附件、导入导出、版本、模板、权限和分享。
- `dingtalk-drive`：钉盘与文档空间中的文件：查找、最近文档、上传下载、移动、重命名、删除、权限，以及与本地文件夹同步。
- `dingtalk-wiki`：知识库与空间：创建、查找、成员、库内节点组织和动态。
- `dingtalk-aitable`：AI 表格（多维表）：建表、记录与字段、筛选排序和公式、导入导出、仪表盘和数据同步。
- `dingtalk-mail`：钉钉邮箱的收发、搜索、回复、转发和附件。
- `dingtalk-minutes`：AI 听记：摘要、逐字稿、行动项、录音、思维导图和分享权限。
- `dingtalk-event`：个人消息、审批、通话邀请、待办和互动卡片等事件的长连接监听。
- `dingtalk-aicard`：离线创建、编辑和校验钉钉 AI 卡片（A2UI）JSON。
- `dingtalk-tag`：数字员工的创建、查询、修改、发布和删除。
- `dingtalk-misc`：低频产品合集：审批、智能合同、考勤、直播、DING 消息、开放平台、Agoal 目标、日志周报、电子表格、白板、技能市场、组织大脑、Markdown 和 HTML 文件、行为授权和多组织 profile。

## 打开子指南

- 子指南不是独立的 skill，不要用 `skill` 工具加载；用文件读取工具打开本技能目录下的 `guides/<名字>/SKILL.md`。
- 子指南正文按名字提到的技能（例如“走 dingtalk-misc”“先读取 dingtalk-shared”）就是 `guides/<名字>/SKILL.md`，同样用文件读取工具打开。
- 子指南中的相对路径（例如 `references/...`、`../dingtalk-shared/SKILL.md`）相对该子指南自己的目录 `guides/<名字>/`。其中的脚本（例如 `scripts/calendar_today_agenda.py`）也在该目录下，运行时使用脚本的完整路径。
