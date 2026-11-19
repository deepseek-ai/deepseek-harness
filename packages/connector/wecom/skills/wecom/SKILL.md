---
name: wecom
description: 企业微信插件：通过 wecom-cli 使用企业微信的通讯录、消息、日程、在线会议、待办、邮件、微盘、文档、在线表格、智能表格、智能文档和 PPT。用户提到企业微信或这些功能，或给出 doc.weixin.qq.com、drive.weixin.qq.com 链接时，先加载本技能，再按索引读取对应子指南。
---

# 企业微信插件

## DSH 指引

- 在面向用户的回复中，把这项集成称为“企业微信插件”。`wecom-cli` 由企业微信插件安装，按当前 runtime context 给出的绝对路径运行，不要直接按名称运行。不要执行 `npm install -g @wecom/cli`，也不要用其他方式另装或升级 `wecom-cli`。
- `wecom-cli` 的授权保存在这台电脑的默认配置目录，与用户自己终端里的 `wecom-cli` 共用。
- 首次运行业务命令前，先读 `wecomcli-shared` 子指南并按它检查授权。本节与该子指南冲突时以本节为准：它 Step 1 的版本检查不需要安装或升级；它 Step 3 的初始化改为下一条。
- 未授权时，先请用户在「插件」中打开企业微信插件页面，点击“连接企业微信”并用企业微信扫码授权；用户完成后重新检查授权。只有用户要求在本次对话中完成授权时，才执行 `wecom-cli auth init --noninteractive`：它会输出扫码链接和二维码，并最多等待 5 分钟扫码，把扫码链接告诉用户。它会把凭据写到工作区之外，保存被拒绝时这次扫码也会作废：第一次运行就把 Shell 工具的 `sandbox_permissions` 设为能写工作区之外的最窄模式，并填写 `justification`。
- 其他 `wecom-cli` 命令在现有沙箱中运行；只有凭据、缓存或日志写入被拒绝时，才设置 `sandbox_permissions`。
- 命令返回 `errcode` 853004，也就是 `cli token expired` 时，通常是 `wecom-cli` 换到了新 token，却写不进工作区之外的配置目录，于是返回了原错误：授权没有失效，也不需要升级。不要向用户转述返回里的 `help_message`，也不要请用户重新授权，设置 `sandbox_permissions` 和 `justification` 重跑同一条命令。重跑后仍返回 853004，才请用户在企业微信插件页面重新授权。
- 不要索取或输出 Bot Secret、token 等凭据。

## 子指南索引

- `wecomcli-shared`：授权检查和所有子指南共用的输出约束（ID 类字段不外露）；首次运行 `wecom-cli` 业务命令前先读。
- `wecomcli-contact`：按姓名、拼音、英文名或别名搜索通讯录，查询 userid、部门和职务。
- `wecomcli-message`：查询可以发消息的会话，向单聊或群聊发送文本、Markdown、图片、文件、语音或视频。
- `wecomcli-calendar`：不含在线会议链接的日程、会议室预订和查忙闲；用户只说“开会”“约个会”时，先按本指南或 `wecomcli-meeting` 的消歧流程追问，不要直接创建。
- `wecomcli-meeting`：含会议号或入会链接的在线会议的创建、查询、纪要、转写、更新和取消；消歧规则同上。
- `wecomcli-todo`：待办的创建、完成、查询筛选和修改。
- `wecomcli-email`：邮件的收发、搜索和详情；只有用户明确提到邮箱或邮件时，才用它发送日程或会议邀请。
- `wecomcli-disk`：微盘（网盘、共享空间）中文件的列出、搜索、元信息、位置、上传、下载和重命名；在线文档的内容读写交给对应的文档子指南。
- `wecomcli-media`：按 media_id 下载媒体文件，或上传本地文件换取 media_id；只搬运文件，不解析内容。
- `wecomcli-doc-manage`：各类文档的搜索（含最近浏览）、改名、成员权限和加入规则。
- `wecomcli-smartpage`：智能文档；用户只说“文档”“新建文档”“整理成文档”等未指定类型时使用，也负责把 .md 导入为文档。
- `wecomcli-doc`：doc 文档；仅当用户明确说 doc、docx、word、在线文档或 office 文档，或给出 `doc.weixin.qq.com/doc/` 链接时使用。
- `wecomcli-smartsheet`：智能表格的记录、字段、视图、图表和样式；用户没有明确说“在线表格”时默认使用。
- `wecomcli-sheet`：在线表格；用户明确说“在线表格”或“excel 表格”、要导入 CSV 或 Excel，或给出 `doc.weixin.qq.com/sheet/` 链接时使用。
- `wecomcli-pptx`：生成、编辑在线 PPT，或把本地 .ppt、.pptx 导入为在线文档；只读取本地 PPT 内容时改用 `wecomcli-media`。

## 打开子指南

- 子指南不是独立的 skill，不要用 `skill` 工具加载；用文件读取工具打开本技能目录下的 `skills/<名字>/SKILL.md`。
- 子指南正文按名字提到的技能（例如“wecomcli-shared 技能”“改用 wecomcli-meeting 技能”）就是 `skills/<名字>/SKILL.md`，同样用文件读取工具打开。
- 子指南中的相对路径（例如 `references/...`、`../wecomcli-calendar/...`）相对该子指南自己的目录 `skills/<名字>/`。
