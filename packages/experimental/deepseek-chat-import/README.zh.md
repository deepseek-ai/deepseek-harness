---
description: "DeepSeek 官网会话导出导入：在浏览器中上传 deepseek_data ZIP，把其中最近的会话存为所选工作区中的会话。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-deepseek-chat-import

[English](README.md) | 中文

## 概述

把 DeepSeek 官网（chat.deepseek.com）导出的会话带进 DSH 并继续对话。启用这个可选 bundle 后，“新建会话”右侧的按钮把 `deepseek_data-*.zip` 文件上传到 Host，Host 把最近的会话存为你所选工作区中的会话。导入的会话保留原始标题和时间，显示原有的提问及其附带文件、思考、联网搜索卡片、阅读链接和回答。设计与取舍见 [Agent Note](../../../.agents/notes/implemented/feature/2026-11-11-deepseek-chat-export-import.zh.md)。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在 GUI 中打开插件页，点击“更多”进入“实验性插件”，打开“DeepSeek 会话导入”。安装包默认附带该 bundle 但处于关闭状态；“更多”列表中 bundle 的展示与启用方式见[插件管理页面](../../client/ui-plugin-manager/README.zh.md#use-this-package)。关闭后按钮与上传路由随之移除，已导入的会话保留。

该 bundle 插入一个 Host 行，显式组合也可以直接挂载：

```yaml
- id: deepseek-chat-import
  name: '@deepseek-ai/dsh-deepseek-chat-import'
```

Host 半包注入 `typert`、`connection`、`sessionPersistence` 和 `workspaceRegistry`，挂载了 `sessionProjectionCache` 与 `attachments` 时读取它们。浏览器半包注入 `remote`、`slots`、`locale` 和 `sessions`，通过 ui-sidebar 的 `sidebar.session.action` HOC 插槽包裹新建会话行：原样返回行内容并追加自己的按钮，对不能导入的 Peer 则只返回行内容。只有 owner 能导入：上传路由只接受 owner Peer，`limits()` 拒绝其他所有 principal，按钮也只对能调用 `deepseekChatImport/limits` 的 Peer 显示。

### 导入会话导出

1. 在 DeepSeek 官网导出全部会话，下载 `deepseek_data-*.zip` 文件。
2. 点击“新建会话”右侧的上传箭头按钮。
3. 在“导出文件”中选择该 ZIP 文件。在“工作区”中保留预选的当前会话所在工作区，或选择其他工作区，或选择“添加工作区…”添加一个目录。
4. 点击“导入”。在服务页面上，进度条显示上传百分比；如果页面通过自己的传输通道携带压缩包，则没有字节进度，进度条直接从 Host 读取压缩包开始。两种情况下随后都显示写入会话时的“正在导入 n/K”；关闭对话框会取消请求。
5. 对话框报告导入了多少个会话、导入到哪个工作区、多少个较早的会话超出上限、多少个会话无法导入。无论导入以何种方式结束，会话列表都会刷新，失败或取消之前已写入的会话随之出现。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxSessions` | `1000` | 一次导入最多写入的会话数，按导出索引中最近更新的顺序取会话。 |
| `maxUploadBytes` | `536870912`（512 MiB） | 一次上传可携带的最大导出压缩包；导入期间整个压缩包保存在内存中。 |
| `maxEntryBytes` | `268435456`（256 MiB） | 压缩包中单个条目声明的最大解压后大小；更大的条目永远不会被解压。 |
| `maxTitleBytes` | `80` | 导入标题的最大 UTF-8 字节数；应与组合中 session-title 的 `maxTitleBytes` 保持一致。 |

### 导入结果

- 每个官网会话生成一个会话。导入的链以 `current_message_id` 指定的消息结尾；该字段缺失、为 `null` 或指向不存在的消息时，以 id 最大的消息结尾。其他分支丢弃。
- 会话由 `chat_session_index.json` 选出：按其中的 `updated_at`（相同则按 `inserted_at`，再按 id）取最新的 `maxSessions` 个，按压缩包顺序逐个导入。其中某个会话失败时，由索引中下一个更旧的会话补位。
- 标题沿用原标题，折叠空白并截断到 `maxTitleBytes`，固定为用户标题，导入后不触发标题生成。规范化后为空的标题不写入。事件时间沿用导出时间且单调不减；思考的 `elapsed_secs` 计入后续 step 的时间。
- 没有文本、已保存图片和文件的用户消息保留一个空文本块：这一行照常显示，但 DeepSeek 请求序列化会像对待其它空用户消息一样把它丢掉，该轮提问因此不在模型上下文里（首轮没有文本时，请求会直接从 assistant 消息开始）。
- 导出包含图片文件（png、jpg、jpeg、webp 或 gif）且附件服务保存成功时，用户消息中的图片成为图片附件。其余图片与所有非图片文件成为合成的文件卡片，显示文件类型图标、名称和导出中的大小；卡片不能打开、没有字节，也不指向任何已保存对象，因此模型按句柄里的路径去读什么也读不到。Host 日志记录每张图片未保存的原因。
- 联网搜索写成 `web_search` 调用，打开的网页写成 `web_fetch` 调用，显示为标准搜索与抓取卡片。导出记录为失败的搜索写成错误结果。仍在进行中的搜索、没有地址的打开网页和以图搜图都略去，官网的回复里也不显示它们。
- `READ_LINK` 记录按链接页面逐行写成 Markdown 链接 `[title](url)`；缺少标题时以 URL 作为链接文本，缺少 URL 时只写标题。`PARTIAL_FILE_READ`、`TOOL_FIND`、`TIP` 和 `CONTENT_RISK` 记录不导入，官网同样不把它们显示为回答正文。
- 回答被内容过滤撤回（`CONTENT_FILTER`）的提问与该回答一起略去：两者都不显示，模型也看不到。没有其他 turn 的会话不导入。
- 其他状态不是 `FINISHED` 的回答、模板回答以及没有可导入内容的回答不进入模型上下文；该 turn 以错误行结束，显示原因与固定的 `DEEPSEEK_EXPORT_*` 代码。提问保留。
- 再次导入同一导出会再写入一组会话。

### 失败

在流式扫描之前检测到的失败不写入任何内容。每个会话在写入前都完成转换，并经 `Session.create` 校验种子；失败的会话被跳过，不影响其他会话。压缩包结构在扫描中途损坏时，会以 `unreadable-archive` 失败，而在那之前交付的会话已经写入；失败应答不会列出它们。对话框显示每种原因的本地化说明；Host 报告的 `too-large` 失败改为显示 Host 自己的说明，其中给出它所应用的上限。

| 原因 | 何时出现 |
|---|---|
| `too-large` | 文件超过 `maxUploadBytes`，或某条目声明或实际存储的字节数超过 `maxEntryBytes`（包括 `manifest.json` 与 `chat_session_index.json`）；浏览器先检查文件大小，Host 读到 `maxUploadBytes` 即停止，超过 `maxEntryBytes` 的条目永远不会被解压。 |
| `unreadable-archive` | 文件不是可读取的 ZIP 压缩包，`manifest.json` 已损坏，未压缩（stored）条目声明的大小与其实际字节数不一致，或有两个中央目录条目同名。 |
| `missing-manifest` | 压缩包中没有 `manifest.json`。 |
| `missing-index` | 压缩包中没有可读取的 `chat_session_index.json`。 |
| `unsupported-version` | `manifest.json` 声明的 `export_format_version` 不是 3。 |
| `no-conversations` | `chat_session_index.json` 没有列出任何会话。 |
| `workspace-not-found` | 所选工作区已不存在。导入过程中出现时，导入停止，已写入的会话保留。 |
| `busy` | 该 Host 上已有另一个导入正在进行。 |

超过上限、已损坏、无法解析或转换的会话文件，以及无法存储的会话，会被跳过并计入结果；Host 日志写明原因。压缩包无法提供的图片成为文件卡片，Host 日志同样写明。取消时已写入的会话保留。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

### 模块

| 文件 | 职责 |
|---|---|
| [`src/protocol.ts`](src/protocol.ts) | 上传路径 `/api/deepseek-chat-import/archive` 及其相对文档的形式 |
| [`src/upload.ts`](src/upload.ts) | `createUploadRoute()`：请求校验、有界的内存缓存、流式 NDJSON 应答与取消 |
| [`src/archive.ts`](src/archive.ts) | `openExportArchive()`：ZIP 中央目录、只解压调用方所需条目（受 `maxEntryBytes` 约束）的流式扫描，以及按名读取单个条目 |
| [`src/format.ts`](src/format.ts) | zod 校验 `manifest.json`、会话文件和本包映射的 fragment 类型 |
| [`src/conversation.ts`](src/conversation.ts) | 纯函数 `selectBranch()` 与 `convertConversation()`：消息树到种子事件 |
| [`src/importer.ts`](src/importer.ts) | `importDeepseekChatExport()`：索引选择、图片扫描、会话扫描、写入与附加工作区 |
| [`src/index.ts`](src/index.ts) | `DeepseekChatImportService`、它的 `Config`、单一导入槽位、路由注册与 `@Remote limits()` |
| [`src/client/`](src/client/index.ts) | 按钮、对话框、经页面载体或 XHR 的浏览器上传，以及 locale 字典 |
| [`cordis.patch.yml`](cordis.patch.yml) | 可选 bundle 的行 |

### 上传

浏览器先调用 `limits()`，大于 `maxUploadBytes` 的文件不发送。服务页面用 `XMLHttpRequest`（以获得上传进度）把文件 POST 到相对文档基址解析的 `api/deepseek-chat-import/archive?workspaceId=…`。Host 跑在页面之外执行上下文中的页面（例如静态 Cloudflare Pages 预览）改为提供 `__DSH_TRANSPORT__.fetch`：压缩包经该载体传输，不报告字节进度，因此对话框直接进入读取与导入阶段。Host 在 `ctx.connection.fetch` 上把该路径注册为精确路由，只有 owner Peer 能访问。路由要求 `application/octet-stream`，占用服务的单一导入槽位，解析工作区，把流式请求体读入一个按 `content-length` 分配的缓冲区，直到读完或超过上限。上传内容从不写入磁盘。应答为 `application/x-ndjson`：写入会话期间是 `{ type: 'progress', done, total }` 行，最后是一行 `{ type: 'outcome', outcome }`，其中 `outcome` 为 `{ ok: true, value }` 或 `{ ok: false, error: { reason, message } }`；浏览器在完整的行到达时读取；遇到第一行不是合法协议值时立即结算为无效应答，并取消余下的流，后续 outcome 无法覆盖它。关闭对话框、连接断开或卸载插件都会中止导入，卸载只有在导入停止写入后才完成。

### 事件映射

每个 USER 消息开一个 turn：`turn/start`、`step/start`、`user/message`。第一个 turn 还在 `user/message` 之前写入一条空的 `system/message` 作为受保护的 surface 头，恢复的 Agent 会用真实的系统提示替换它；它不产生模型消息，也没有可见的行。正常完成的回答按 fragment 顺序切成 step：THINK 和 RESPONSE 追加到当前 step 的 `assistant/message`，联网搜索与打开网页追加为工具调用。带 `stage_id` 的工具调用在取值不变时同属一个 step，取值不同时开新 step；由正文开启的 step 采用第一个加入它的调用的 stage，因此不是最后一个 step 一定带有调用。工具调用之后再出现思考或正文就开新 step。turn 以 `turn/end { kind: 'completed' }` 结束。被排除的回答不写 `assistant/message`，以 `turn/end { kind: 'error' }` 结束。assistant 消息来源为 `deepseek-chat-export` / `deepseek-chat-export`，`stream` 为空，不写 `usage`、请求头或模型选择。完整的 fragment 与状态映射表见 [Agent Note](../../../.agents/notes/implemented/feature/2026-11-11-deepseek-chat-export-import.zh.md)。

### 写入

导入不创建 live Agent，一次只处理一个会话。索引选出会话后，第一遍流式扫描在任何会话被解析之前保存每个选中会话的图片，第二遍在会话到达时逐个转换并写入。会话扫描只查已保存的引用，因此压缩包条目顺序不影响结果，主路径也不再按名读取任何图片。缺失、超限、损坏、类型不支持或被附件服务拒绝的图片成为合成的文件卡片，并记一条 Host 警告。写入前检查工作区仍已登记且目录存在。随后 `Session.create()` 做与 live 会话相同的种子校验；`sessionPersistence.create()` 写入 header 与事件，句柄 flush 后关闭。投影缓存的 `coldSnapshot()` 刷新侧栏读取的标题与活动时间，`attachSession()` 把会话加入工作区。header 的 `createdAt` 是第一个事件的时间，`cwd` 是工作区的规范路径。存储的日志不含 `session/end-seed`；首次打开时普通恢复路径追加它。导入在会话之间让出事件循环。冷写入不发 `session/created`，所以浏览器在每次尝试后都调用 `sessions.refresh()`。

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [设计 Agent Note](../../../.agents/notes/implemented/feature/2026-11-11-deepseek-chat-export-import.zh.md)——格式差异、映射、备选方案与后果。
- [Session 持久化](../../session/session-persistence/README.zh.md)——导入写入的存储。
- [工作区注册表](../../workspace/workspace/README.zh.md)——工作区成员关系。
- [联网工具](../../web/tool-web/README.zh.md)——导入的调用复用的搜索与抓取结果和卡片。

-----

<a id="model-experience"></a>
## 模型体验

### 导入的历史

#### 模型看到什么

导入本身不发送模型请求。用户在导入的会话中继续对话时，模型看到导入的提问、思考、`web_search` / `web_fetch` 调用与结果、回答，阅读链接记录的 Markdown 链接行，以及合成文件卡片的文件句柄——后者对应的字节并不存在；被内容过滤的轮次、被排除的回答、模板文本、提示、页内查找、部分读取说明和 `CONTENT_RISK` 免责声明不出现。合成的文件卡片以文件句柄进入上下文，句柄写明文件名与大小，但它给出的路径没有任何字节；没有任何内容的提问不发送消息。抓取结果只有页面标题、URL 和“页面正文未包含在导出中”的说明。

#### Token 影响

恢复后的首个请求发送全部导入的历史。导入的思考按无签名 thinking 发送，增加该请求的输入 token；导入的图片在支持图片的路由上发送，在其他路由上替换为通用的省略说明。

#### KV Cache 影响

恢复后的首个请求没有可复用的缓存前缀；此后的请求与普通会话一样在此基础上延伸。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **压缩包保存在内存中**——导入期间整个上传内容保存在 Host 内存中，受 `maxUploadBytes` 约束，另加一个转换后的会话、同一时间的一张图片条目，以及已保存图片的引用；同一 Host 一次只运行一个导入。索引未选中的会话和图片都不会被解压。
- **同步解压**——流式扫描用 fflate 的 `UnzipInflate` 同步解压每个选中的条目。声明很小的 `originalSize` 却携带高压缩比数据的条目会一直解压到条目结束，`maxEntryBytes` 只阻止这些字节被保留。构造出来的压缩包可以让 Host 长时间忙于解压，之后该条目才被拒绝。
- **重复的本地文件头**——重复检测只覆盖中央目录。第二个本地文件头改成已有条目名时不会被发现，因此压缩包可以交付比索引列出的更多的会话，写入数量也没有额外限制。
- **压缩包损坏时的部分写入**——压缩包结构在部分条目交付之后损坏时，会以 `unreadable-archive` 失败，而那些会话已经写入；失败应答不会列出它们。
- **`read()` 截断**——`ExportArchive.read` 最多返回条目声明的大小，解压结果更大时截断到该大小；`stream` 把同一情况报告为大小失败。manifest、索引与补位会话按名读取，因此其中一项可能被截断。每次按名读取还会重新解析整个中央目录：manifest 与索引各付一次，补位会话再付一次。
- **通道形态下没有上传百分比**——页面经 `__DSH_TRANSPORT__.fetch` 携带压缩包时不报告字节进度，对话框只显示读取与导入阶段。
- **只支持一种导出结构**——导入器针对 2026-11-12 结构：`current_message_id`、`stage_id`、工具状态、链接与查找字段以及新的记录类型。该结构新增的字段按可选读取，因此更旧的 v3 压缩包仍能导入，但它不是支持目标。
- **只支持上传 ZIP**——不能导入解压后的导出目录或 Host 路径。
- **重复导入产生重复会话**——再次导入同一导出会写入新的会话；导入不记录哪些会话已经导入过。
- **合成文件卡片**——导出中缺失、类型不支持、超过 `maxEntryBytes` 或被附件服务拒绝（例如超过大小上限）的图片，以及所有非图片文件，都成为没有字节的卡片：不能打开，也不指向任何已保存对象。非图片文件的本体不在导出中。
- **没有事件引用的图片**——第一遍图片扫描会在任何会话被解析之前保存每个选中会话的所有图片条目。被撤回轮次的图片、导入丢弃的分支的图片，以及转换或 `Session.create` 种子校验后来失败的会话的图片，都会成为没有任何事件引用的附件。`SessionPersistence` 与附件存储都不提供删除接口，因此这些字节会保留。
- **已存储但未附加**——把写入的会话加入工作区失败时，`SessionPersistence` 不提供删除，该会话留在存储中、不属于该工作区；结果在 `skipped` 中列出它及其 id。
- **单独的标题上限**——session-title 服务不公开它的 `maxTitleBytes`，修改该值的组合需要把本包的 `maxTitleBytes` 设为相同的值。
- **未导入的内容**——其他分支、被内容过滤的轮次、`CONTENT_RISK` 免责声明、`TIP`、`TOOL_FIND` 和 `PARTIAL_FILE_READ` 记录、`READ_LINK` 的加密正文（只显示导出的 url 与 title）、搜索结果的 `snippet` 与 `site_name`、`pinned` 标记、逐 token 时间和 `accumulated_token_usage`。
- **英文诊断**——被排除回答和失败搜索的说明是写入日志与工具结果的固定英文文本；Host 报告的 `too-large` 失败在对话框中显示其英文说明。
- **推断的工具记录**——导入的 `web_search` / `web_fetch` 调用没有对应的请求头工具记录，抓取卡片的 `statusCode: 200` 由“打开成功”推断。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

`tests/conversation.host.spec.ts` 覆盖映射规则，`tests/archive.host.spec.ts` 覆盖压缩包视图，`tests/upload.host.spec.ts` 覆盖路由，`tests/importer.host.spec.ts` 用合成 ZIP 覆盖编排，`tests/resume.host.spec.ts` 覆盖经生产 agent loop 继续对话，`tests/composition.host.spec.ts` 覆盖 Loader 组合，`tests/*.client.spec.*` 覆盖按钮、对话框、上传与挂载。keyless Web 快照 `snapshots/web/deepseek-chat-import/`（驱动为 `apps/web/tests/deepseek-chat-import.e2e.ts`）经路由导入一个合成导出，并以一轮录制的模型回复继续其中一个导入的会话。修改 fragment 映射时，在同一变更中更新 Agent Note 中的映射表。

</details>
