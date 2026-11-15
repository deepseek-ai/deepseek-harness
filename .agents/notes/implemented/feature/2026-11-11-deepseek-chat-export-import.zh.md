# Agent Note: 导入 DeepSeek 官网会话导出

Status: implemented

[English](2026-11-11-deepseek-chat-export-import.md) | 中文

## Problem

DeepSeek 官网（chat.deepseek.com）的“导出全部会话”产物是一个 `deepseek_data-*.zip`。用户希望把这些历史会话带进 DSH 继续使用：在 Web GUI 里浏览原有的提问、思考与回答，并在任意一条会话上接着对话，模型能看到原有的上下文。没有导入功能时，DSH 只能从空白会话开始。

导出格式（`export_format_version: 3`）与 DSH Session 有四点结构差异，导入必须逐一处理：

- 每个官网会话的 `messages` 是一棵靠 `parent_id` 连接的消息树（重新生成、编辑提问都会产生分叉）；DSH Session 是线性的追加日志。
- 消息 `id` 只在会话内自增，跨会话不可比较；`inserted_at` 在同一会话内也不单调（assistant 常比配对的 user 早几毫秒）。
- 一条 assistant 消息的 `fragments` 交错记录思考、联网搜索、打开网页、正文等块；DSH 用 step 内的 `assistant/message` 加 `tool/call` / `tool/result` 表达同样的过程。
- 产物还包含模板回答、失败状态、加密的链接正文、提示条等**不能**进入模型上下文的内容。

一个导出可能包含上千个会话和数百兆字节的图片；用户只需要最近的会话，并放进自己选择的工作区，而且 Host 在导入期间必须保持响应。

## Decision

实验性包 [`@deepseek-ai/dsh-deepseek-chat-import`](../../../../packages/experimental/deepseek-chat-import/README.zh.md) 同时提供 Host 与 Client 两个编译面：

- Host 面：一个 `TypertRemoteService`，在 `ctx.connection.fetch` 上注册精确上传路由 `POST /api/deepseek-chat-import/archive?workspaceId=…`，并提供 `@Remote limits()` 方法。路由把上传的 ZIP 缓存在内存中，把最近的会话逐个写成所选工作区中的持久化 DSH Session，并以流式方式报告进度。
- Client 面：在侧栏“新建会话”右侧放一个导入按钮。点击后弹出对话框，包含导出文件字段（浏览器原生文件输入，`accept=.zip`）和工作区字段（渲染 ui-workspace 的 `workspace.picker` Factory）；浏览器上传文件，显示上传与导入进度以及结果。

按钮位置通过 ui-sidebar 的 HOC slot `sidebar.session.action` 提供：插件在那里包裹新建会话行的内容，原样返回后追加自己的按钮，因此装饰该行不新增包裹元素。不在 ui-sidebar 里写死按钮，因为那样侧栏外壳要直接调用导入插件的 Remote 命名空间，把业务逻辑放进了外壳。工作区字段复用新建会话的工作区菜单，即 `workspace.picker` Factory：列出已有工作区，并提供“添加工作区…”，通过 `workspace.picker.directoryFlow` 洞运行已组合的目录选择器。

该能力作为 Official 实验性可选 bundle 发布：包本身声明 `dsh.bundle.patch` 并插入自己的 `deepseek-chat-import` 行，列入 `OPTIONAL_BUNDLES`，在用户于插件页启用之前保持关闭。默认 Web 组合不挂载它。

### 用户流程

1. 用户在插件页启用“DeepSeek 会话导入”，然后点击“新建会话”右侧的导入按钮（窄栏模式下是一个图标按钮，位于“新建会话”图标下方）。只有 owner 看得到这个按钮。
2. 对话框需要 DeepSeek 官网导出的 ZIP 文件（`deepseek_data-*.zip`）以及接收会话的工作区。工作区字段预选当前会话所在的工作区；“添加工作区…”通过目录选择器添加新目录。
3. 导入时，浏览器先调用 `limits()`；大于 `maxUploadBytes` 的文件在上传前就被拒绝。服务页面随后显示上传百分比、Host 读取压缩包时的不确定进度，以及写入会话时的“正在导入 n/K”。Host 跑在页面之外执行上下文中的页面经 `__DSH_TRANSPORT__.fetch` 携带压缩包，该载体不报告字节进度，因此对话框从读取阶段开始。关闭对话框会中止请求。
4. 成功后对话框以单数或复数形式显示导入了多少个会话、导入到哪个工作区、多少个会话超出上限、多少个会话无法导入。
5. 失败时对话框显示该失败原因的本地化说明，或意外错误的信息。
6. 无论导入以何种方式结束，浏览器都会刷新会话列表，使失败或取消之前已写入的会话出现在列表中。

用户随后打开任一导入的会话，看到原始的提问、思考、搜索卡片和回答；发送新消息时，Agent 以默认模型和导入的历史为上下文继续。

### 包结构

| 文件 | 职责 |
|---|---|
| `src/types.ts` | 只放浏览器安全的线上类型：结果、失败原因、上限、NDJSON 应答行，以及 `deepseekChatImport/owner-only` Remote 错误码 |
| `src/protocol.ts` | `UPLOAD_PATH` 及其相对文档的形式 `UPLOAD_ROUTE` |
| `src/format.ts` | 用 zod 校验 `manifest.json`、`chat_sessions/{id}.json` 和本包映射的 fragment 类型；未知 fragment 类型原样保留给转换器忽略 |
| `src/archive.ts` | `openExportArchive(bytes, maxEntryBytes, signal)`：ZIP 中央目录、只解压调用方所需条目的流式扫描，以及按名读取单个条目 |
| `src/conversation.ts` | 纯函数 `selectBranch(file)` 与 `convertConversation(file, options)`：消息树到种子事件 |
| `src/importer.ts` | `importDeepseekChatExport(deps, request, signal)`：索引选择、图片扫描、会话扫描、写入与附加工作区 |
| `src/upload.ts` | `createUploadRoute(handler)`：请求校验、有界缓存、流式应答与取消 |
| `src/index.ts` | `DeepseekChatImportService`、`Config`、单一导入槽位与 `@Remote limits()` |
| `src/client/*` | 按钮、对话框、经页面载体或 XHR 的浏览器上传、locale 字典、slot 注册 |
| `cordis.patch.yml` | 可选 bundle 的 `deepseek-chat-import` 行 |

`src/conversation.ts` 不读文件、不访问服务、不取当前时间，所有 id 由调用方注入，可以确定性地单测。`src/importer.ts` 通过一个显式的依赖对象使用持久化、投影缓存、附件服务与工作区注册表，单测可以接真实的 JSONL 持久化。

### Host 路由与 Remote

```ts
/** Deployment limits of the importer. */
interface Config {
  /** Most Sessions one import writes, choosing the conversations the export index lists as most recently updated; default 1000. */
  maxSessions: number
  /** Largest export archive, in bytes, one upload may carry; default 512 MiB. */
  maxUploadBytes: number
  /** Largest declared uncompressed size, in bytes, of one archive entry; default 256 MiB. */
  maxEntryBytes: number
  /** Largest UTF-8 size, in bytes, of an imported title; default 80. */
  maxTitleBytes: number
}
```

`POST /api/deepseek-chat-import/archive?workspaceId=…` 是共享 API 通道上的精确路由，只有 owner Peer 能访问。`limits()` 以 `deepseekChatImport/owner-only` 拒绝所有非 owner 调用方，因此共享会话的访客等非 owner principal 永远不能导入。路由要求 `content-type: application/octet-stream`（否则 415）和非空的 `workspaceId`（否则 400）；其他方法在路由运行前就由共享处理器应答。

服务拥有一个导入槽位。请求先占用槽位，否则应答 `busy`；随后解析工作区（`workspace-not-found`），把流式请求体读入一个按有效 `content-length` 分配的缓冲区，只有请求体比声明的更长时才扩容，直到读完或超过 `maxUploadBytes`（`too-large`）。上传内容从不写入磁盘。每个请求拥有一个 AbortController，与请求信号以及应答体的取消合并。卸载插件会中止正在运行的导入（包括仍在上传的请求体），并且只有在导入停止写入后才完成卸载。

应答为 `application/x-ndjson`，带 `cache-control: no-store, no-transform`：先是进度行 `{ type: 'progress', done, total }`，然后恰好一行 `{ type: 'outcome', outcome }`，其中 `outcome` 为 `{ ok: true, value: DeepseekChatImportResult }` 或 `{ ok: false, error: { reason, message } }`。Web server 逐块写出应答体，浏览器在完整的行到达时读取，代理一次性交付整个应答体时同样可用。浏览器校验每一条解码后的行：必须是已知 `type` 的对象，并携带该类型对应的字段，因此 `null`、缺少 `done` 的行，或 `ok` 不是布尔值的 outcome 都会让应答以无效失败，而不是在 `onload`/`onprogress` 回调里抛错。`reason` 取 `too-large | unreadable-archive | missing-manifest | missing-index | unsupported-version | no-conversations | workspace-not-found | busy` 之一。意外失败会记入 Host 日志，并在没有 outcome 行的情况下结束应答体，浏览器将其报告为上传失败。

`attachments` 与 `sessionProjectionCache` 是通过 `ctx.get()` 读取的可选服务：缺少附件服务时图片变成伪造的文件卡片；缺少投影缓存时，冷会话的列表行在会话首次打开前不显示原标题与活动时间。

### 读取导出产物

- `openExportArchive` 用 fflate 的异步 `unzip` 和一个不接受任何条目的 filter 读取中央目录，打开阶段不解压任何条目。不是可读 ZIP 的字节报 `unreadable-archive`。条目名必须唯一：按名读取按名字选择，重名会让所有同名条目一起解压，绕过逐条上限；重名同样报 `unreadable-archive`。重复检测只覆盖中央目录：第二个本地文件头改成已有条目名时不会被发现，因此扫描可以交付比索引列出的更多的会话，写入数量也没有额外限制。
- `manifest.json` 与 `chat_session_index.json` 在扫描前按名读取。`manifest.json` 缺失或损坏分别报 `missing-manifest` 或 `unreadable-archive`；索引缺失、损坏或无法解析报 `missing-index`；条目超过 `maxEntryBytes` 报 `too-large`；`export_format_version` 不是 3 报 `unsupported-version`。
- 随后一次流式扫描按压缩包顺序只解压被选中的会话条目，并在每 64 KiB 压缩包字节之间让出事件循环。解压是同步的（`UnzipInflate`），因此一个分块的输出在扫描让出之前就已产生；声明很小、实际解压超过 `maxEntryBytes` 的条目会一直解压到条目结束，上限此时只阻止字节被保留，而不阻止这部分工作。中央目录在解压前给出每个条目声明的大小：超过 `maxEntryBytes` 的条目不会被解压；未压缩（stored）条目声明的大小与实际字节不一致时按损坏拒绝。接受的条目整块累积后交付；产出超过条目声明大小或 `maxEntryBytes` 时拒绝。
- 每个选中会话的图片由单独一次流式扫描在任何会话被解析之前保存。该扫描只解压 `chat_sessions/{id}_files/…` 中 id 属于索引所选会话的条目，一次一个，并记录每条目的已保存引用或失败原因。由于它先运行，压缩包条目顺序不影响结果，会话扫描也不再按名读取任何图片。
- 按名读取用于 manifest、索引与补位会话。每次调用都会重新解析整个中央目录，因此一个补位会话会为其会话文件多出一次目录扫描；它的图片由再一次图片扫描收集，而不是每张图片读取一次。它最多返回条目声明的大小，解压结果更大时截断；扫描把同一情况报告为大小失败。
- 会话来源是 `chat_sessions/` 下直接的 `*.json` 条目（不进入 `*_files/` 子目录）。索引未选中的条目不会被解压。选中的会话在到达时解析并转换；超过上限、已损坏、不是 JSON，或未通过 zod 校验与转换的会话记入 `skipped`。

### 选择会话

1. `chat_session_index.json` 为导出携带的会话排序：`updated_at` 降序，其次 `inserted_at` 降序，最后 id 升序。导入写入其中最新的 `total = min(maxSessions, 索引行数)` 个，按压缩包顺序。
2. Session 持久化与工作区成员关系按会话时间而非写入顺序排序，因此扫描按压缩包顺序写入不会改变会话列表。
3. 压缩包中没有的会话，或转换、存储失败的会话记入 `skipped`；由索引中下一个更旧的会话按名补位。`omittedByLimit` 统计索引列出但任何尝试都未触及的会话。
4. `sessionIds` 按索引顺序从新到旧列出已导入的会话，与写入顺序无关。

### 分叉树线性化（`selectBranch`）

- 选中的消息是 `current_message_id` 指定的那条。从它沿 `parent_id` 回溯到 `parent_id === null` 的根，再反转，得到一条链。其他分支丢弃，每个会话只生成一个 Session。
- `current_message_id` 缺失、为 `null` 或指向不存在的消息时，改选 `id` 最大的消息。消息 id 在会话内自增，子消息的 id 总大于父消息，所以这个兜底一定是叶子。
- `messages` 为空、消息 id 重复、`parent_id` 指向不存在的消息或回溯出现环时，该会话无效并记入 `skipped`。

### 消息链到 Session 事件（`convertConversation`）

链上的消息按“每个 USER 消息开一个 turn”分组：USER 消息与紧随其后的 ASSISTANT 消息组成一个 turn。没有前置 USER 的 ASSISTANT 消息（只可能来自异常数据）被丢弃。回答状态为 `CONTENT_FILTER` 的 USER 消息与该回答一起丢弃：两个节点都不产生事件，界面上什么都不显示，后续 turn 的编号不留空缺。链以 USER 结尾时最后一个 turn 只有提问。不要求 user / assistant 严格交替：被排除的回答不会产生 `assistant/message`，下一个提问直接跟在上一个提问之后，这与 DSH 中一个 turn 收到多条 steer 消息的历史形态一致。没有剩余 turn 的会话转换失败并记入 `skipped`。

一个 turn 的事件序列：

| 顺序 | 事件 | 说明 |
|---|---|---|
| 1 | `turn/start {turn: n}` | 时间为 USER 消息时间 |
| 2 | `step/start {turn: n, step: 1}` | 第一个 turn 中其后紧跟一个空的 `system/message`（`surfaceOp: 'append'`），作为 surface 节点 0 |
| 3 | `user/message`（`surfaceOp: 'append'`） | `source: { kind: 'user' }`，内容见下 |
| 4 | 每个 step 一组：`assistant/message`（`stream: []`）、每个工具调用一对 `tool/call` / `tool/result`、`step/end`；下一 step 以 `step/start` 开始 | 只用于正常完成的回答 |
| 5 | `step/end`（最后一个 step） | |
| 6 | `turn/end` | 正常回答为 `{ kind: 'completed' }`；被排除或缺失的回答为 `{ kind: 'error', error: { code, message } }` |

空的 system 头不产生模型消息，也不渲染提示卡片。存储格式只接受作为 surface 节点 0 或位于这样的头之后的 `system/message`，每次读取存储的日志都会检查这一点；有了这个头，恢复的 Agent 会用真实的系统提示替换它，而不是在导入的历史之后追加一条系统消息。

文本为空或只有空白、且没有附件的用户消息写入一个内容为空字符串的文本块：Turn 与它的行都存在，而 DeepSeek 请求序列化会跳过这条空用户消息，因此该轮提问不在模型上下文里；首轮没有文本时，请求会直接从它的 assistant 消息开始。

第 1 个 turn 结束后，会话标题追加 `session/title { title, messageSeqs: [], source: { kind: 'user' } }`。标题经 session-title 的 `normalizeSessionTitle` 规范化：空白折叠为单个空格，文本截断到 `maxTitleBytes` 个 UTF-8 字节。没有标题，或标题规范化后为空时，不写标题事件。`user` 来源会固定标题，导入后不会再触发标题生成。

Assistant 消息的 `source` 为 `{ kind: 'model', provider: 'deepseek-chat-export', model: 'deepseek-chat-export' }`，没有 `replayState`。DeepSeek adapter 把这类外来历史的 reasoning 按无签名 thinking 发送，这是已有的跨模型历史路径。不写 `usage`、`request/header`、`request/context`、`model/selection`：恢复后的首个请求记 `initial` header，使用部署的默认模型，不出现“模型已切换”提示。

`stream` 写空数组。导出不包含逐 token 的流记录，伪造的流无法满足“流精确重建内容”的校验；空数组能通过现有校验，Web 的 assistant 行从 `message.content` 渲染。

**事件时间。** 每个事件的 `time` 取对应导出消息的 `inserted_at` 毫秒值，并按出现顺序钳制为单调不减（吸收 assistant 比提问早几毫秒的情况）。在一个回答内部，每遇到一个带 `elapsed_secs` 的 THINK，时间游标前进对应的毫秒数，后续 step 使用前进后的时间，使 step 时间间隔反映原始思考耗时。Session header 的 `createdAt` 取第一个事件的时间。

### Fragment 映射

| Fragment | 所在消息 | 映射 | 进入模型上下文 |
|---|---|---|---|
| `REQUEST` | USER | `user/message` 的文本 | 是 |
| `FILE`（图片） | USER | `export_path` 指向的条目存在且附件服务已保存时写 `{ type: 'image', attachment }`；否则写伪造的文件卡片 `{ type: 'file', attachment }`，引用不指向任何已保存对象 | 图片能力路由上是已保存图片；否则是文件句柄文本，其中给出的路径没有任何字节 |
| `FILE`（非图片） | USER | 伪造的文件卡片：`{ type: 'file', attachment }`，引用为 `attachmentId = sha256('deepseek-chat-export:' + file.id)`、`name = file_name`、`bytes = file_size`（缺失时 0）；本体不在导出里，因此不存在对应对象，句柄里的路径读不到内容 | 是，为文件句柄文本 |
| `THINK` | ASSISTANT | 当前 step 的 `{ type: 'reasoning', text }`；空文本忽略 | 是（按 adapter 规则） |
| `RESPONSE` | ASSISTANT | 当前 step 的 `{ type: 'text', text }`；空文本忽略 | 是 |
| `TOOL_SEARCH` | ASSISTANT | `web_search` 调用：参数 `{"queries": [...]}`；结果正文由 `dsh-tool-web` 的 `formatSearchOutput` 生成；`meta` 为 `{ sources: [{ url, title, snippet, publishedAt }], truncated: false }`，渲染为标准搜索卡片。`WIP` 视为未完成并略去；`FAILED` 生成 `isError: true` 的结果，文本固定为 `Error: the export records this search as failed.`；缺少 `status` 时按 `FINISHED` 处理。查询全为空或空白时忽略 | 是 |
| `TOOL_OPEN`（有 url） | ASSISTANT | `web_fetch` 调用：参数 `{"url": ...}`；结果正文为标题、URL 与“页面正文未包含在导出中”的说明；`status: FINISHED` 时 `meta` 为 `{ url, statusCode: 200, truncated: false }`，渲染为标准抓取卡片；`FAILED` 时结果为 `isError: true`；`WIP` 忽略 | 是 |
| `TOOL_OPEN`（url 为 null 或空串） | ASSISTANT | 不生成任何内容：导出端会在一个 stage 的真实打开记录旁写一条全 null、只带 `stage_id` 和 `group_id` 的记录，它不指向任何页面 | 否 |
| `TOOL_FIND` | ASSISTANT | 不生成任何内容：官网把它显示成单独一行，消息里没有对应的块 | 否 |
| `TOOL_IMAGE_SEARCH` | ASSISTANT | 不生成任何内容：官网不为图搜显示任何一行，回复的思考里已经写明模型从结果中得到了什么；被搜索的图片本身不在导出里 | 否 |
| `READ_LINK` | ASSISTANT | 每个结果一行 Markdown 链接：`[title](url)`；没有 title 时用 url 本身作文字，没有 url 时只写 title，两者都没有则跳过；正文仍是没有密钥无法解密的签名 | 是（文本） |
| `TIP` | ASSISTANT | 不生成任何内容：这是官网界面的提示横幅，不是模型输出 | 否 |
| `CONTENT_RISK` | ASSISTANT | 忽略：固定免责声明，没有信息量 | 否 |
| `PARTIAL_FILE_READ` | ASSISTANT | 不生成任何内容：官网把它显示成单独一行 | 否 |
| `TEMPLATE_RESPONSE` | ASSISTANT | 整个回答被排除，`turn/end` 以模板文本作为错误信息 | 否 |
| 未知类型 | 任意 | 忽略 | 否 |

**Step 切分。** 带 `stage_id` 的 fragment 在取值不变时同属当前 step；只有工具 fragment 会开启或改变 stage，因此 stage 变化总是开新 step，带 stage 的 step 一定含工具调用。不是最后一个的 step 如果没有工具调用，续聊历史里就会出现两条相邻的 assistant 消息，而实时 agent loop 从不产生这种结构，因此只含文本的 step 会与下一次调用合并。不带 `stage_id` 的 fragment 沿用旧规则：工具调用之后再出现 THINK 或 RESPONSE 时结束当前 step 并开下一个，本身不带 stage 的记录按文本处理。`WIP` 记录被略过，不切分 step。连续多个 `stage_id` 相同的工具 fragment 落在同一个 step，相当于一次并行调用。被忽略的 fragment 不切分 step，因此“THINK、三个 url 为 null 的 TOOL_OPEN、THINK”仍是一个 step，只包含两个 reasoning 块。

以官网的“边想边搜”为例，`THINK, TOOL_SEARCH（stage 1）, THINK, TOOL_OPEN×4（stage 2）, THINK, RESPONSE` 映射为三个 step：①思考 + `web_search`；②思考 + 4 个 `web_fetch`；③思考 + 正文。中间没有思考时，紧邻的 `TOOL_SEARCH（stage 1）` 与 `TOOL_OPEN（stage 2）` 会拆成两个 step，因为第一个 step 已经持有搜索调用。

**Step 内的块顺序。** 一个 step 的 `assistant/message` 先放该 step 的文本块（思考、正文、链接行），再放工具调用块，两组各自保持记录顺序。因此导出中排在同一 step 工具调用之后的文本会存到该调用之前，而 step 顺序与所有跨 step 顺序仍与导出一致。把文本交叠到工具调用之后的同一条 assistant 消息里，不符合实时 loop 产生的任何 step。

**ID。** 消息 id、工具调用 id 都由调用方注入的 `createId()` 生成（生产用 `randomUUID`），`tool-call` 块 id、`tool/call.callId`、`tool/result` 消息的 `source.callId` 与 `toolCallId` 相同。

### 回答状态映射

导出文档要求非 `FINISHED` 的消息和模板回答不能进入模型上下文。被内容过滤撤回的回答（`CONTENT_FILTER`，官网显示为已撤回）按上文与其提问一起丢弃。其他被排除的回答都不写 `assistant/message`，也不写 `assistant/attempt`（Web 不展示 attempt，而且“用户消息 + attempt + 可重试错误码”会让 GUI 提示继续生成）。用户看到的是 turn 末尾的错误行，显示原因和代码：

| 原回答 | `turn/end.reason.error.code` | `message`（英文，写入日志） |
|---|---|---|
| `FAILED` / `TIMEOUT` / `CONTEXT_LENGTH_EXCEEDED` / `INCOMPLETE` / `WIP` | `DEEPSEEK_EXPORT_FAILED` / `DEEPSEEK_EXPORT_TIMEOUT` / `DEEPSEEK_EXPORT_CONTEXT_LENGTH_EXCEEDED` / `DEEPSEEK_EXPORT_INCOMPLETE` / `DEEPSEEK_EXPORT_WIP` | The original reply ended with status "{STATUS}" and is excluded from the model context. |
| 其他任何状态 | `DEEPSEEK_EXPORT_UNFINISHED_REPLY` | 同样的说明，状态带引号 |
| 含 `TEMPLATE_RESPONSE` | `DEEPSEEK_EXPORT_TEMPLATE_RESPONSE` | 模板文本本身 |
| `FINISHED` 但没有任何可导入内容 | `DEEPSEEK_EXPORT_EMPTY_REPLY` | The original reply has no importable content. |
| 链以 USER 结尾（没有回答） | `DEEPSEEK_EXPORT_NO_REPLY` | The export contains no reply to this message. |

错误码是固定字符串；来自导出的文本只出现在说明里。这些代码不在 session-controller 的可继续生成代码集合内，不会出现“继续生成”。提问本身保留在上下文里。

### Session 写入

导入不创建 live Agent，直接写持久化层。在扫描之前检测到的失败（压缩包不可读、manifest 缺失、超限或版本不支持、没有可导入的会话、上传超限）不写入任何内容；压缩包结构在扫描中途损坏时，会以 `unreadable-archive` 失败，而在那之前交付的会话已经写入。每个会话在写入前都完成转换，并经 `Session.create` 校验种子；失败的会话被跳过，不影响其他会话。每个选中的会话在压缩包条目到达时转换并写入；失败后补位的会话则按名读取。对每个会话：

1. 检查目标工作区仍已登记且目录存在；否则以 `workspace-not-found` 停止，之前写入的会话保留。
2. 用图片扫描已保存的引用转换会话。转换或种子校验后来失败的会话，其图片已经保存，并且没有任何事件引用它们。
3. `Session.create(id, seed, header)` 做与 live append 相同的种子校验（JSON 可序列化、seq 连续、surface 转换合法、消息字段合法），校验用的分离实例随即丢弃。
4. `ctx.sessionPersistence.create(header)` → `handle.append(events)` → `handle.flush()` → `handle.close()`（失败时也关闭）。header 为 `{ version: SESSION_FORMAT_VERSION, id, createdAt, cwd, isSeeded: false }`，`cwd` 是工作区的规范路径。存储的事件不含 `session/end-seed`；首次打开时普通恢复路径追加该标记。
5. 若投影缓存可用，`coldSnapshot(header, SessionLogOffset(0), events)` 刷新侧栏读取的缓存行（标题、最后提问时间、非空白）。
6. `workspace.attachSession(id)`。失败时该会话以“stored as Session {id} but not added to the workspace”为原因记入 `skipped`；`SessionPersistence` 不提供删除，所以这个会话留在存储中、不属于该工作区。

转换得到的事件在处理下一个会话前释放；导入在会话之间让出事件循环，并在每一步检查取消。写入后的 Session 与其他冷 Session 一样出现在 `session/list` 中，打开时走普通的恢复路径。导入不新增 Session 事件类型，不改变 `SESSION_FORMAT_VERSION`，也不需要持久化类型确认。

### Client

- ui-sidebar 声明 HOC slot `sidebar.session.action`（`scope: 'root'`，owner `{ wide: boolean }`），包裹新建会话行的内容，占用方以 `children` 收到该内容，返回它（可再包裹）并附上自己的控件。导入按钮在“新建会话”按钮右侧渲染（宽栏同一行，“新建会话”按钮占剩余宽度；窄栏纵向排列在“新建会话”图标下方）。
- 插件的 client 面 `$mount` 自己的 `/remote` 贡献（与 `dsh-api-remote-access` 相同的自挂载方式，不进入 `dsh-api-remotes` 聚合），作为 `sidebar.session.action` 层注册 `ImportSessionsAction`。它先渲染行内容，再渲染触发按钮，最后渲染对话框；不能导入的 Peer 会原样得到行内容，因此新建会话按钮继续渲染。按钮仅在 `useRemoteAccess('deepseekChatImport/limits')` 为真时显示；对话框是该层的本地状态，通过 `Modal` portal 渲染。
- 服务页面上的上传使用 `XMLHttpRequest`，因为 Fetch 不提供上传进度。Host 跑在页面之外执行上下文中的页面（静态 Cloudflare Pages 预览）提供 `__DSH_TRANSPORT__.fetch`：压缩包经该载体传输，没有字节进度，直接进入读取与导入阶段。URL 是相对 `document.baseURI` 解析的 `UPLOAD_ROUTE`，因此加路径前缀的代理仍然可用。非 200 应答、没有 outcome 行的应答、不是合法协议值的行或连接失败归为 `upload-failed` 结果；抛出的错误以未知失败文案显示。
- 载体选择没有复用 `@deepseek-ai/dsh-client-file-upload`。该包的服务会缓冲整个应答，流式 NDJSON 进度会丢失，而且它的 `post` 方法不在公开接口上；把选择留在本包内同时保住了进度行与包依赖边界。
- 文案走 8 种语言的 locale 字典，英文用 sentence case；摘要行有 `.one` / `.other` 两种形式，按 `count === 1` 选择。

### Realization

`sidebar.session.action` 是 HOC 层而不是 list，因为占用方装饰的是行的内容，而不是渲染在旁边：它把该内容作为 `children` 接收、原样返回（可再包裹）并追加自己的控件，不新增包裹元素。list 条目会渲染为行内容的兄弟节点，而 rail-in 淡入作用于 slot outlet 的子节点，因为 `display: contents` 的 outlet 锚点本身无法承载动画。

这项义务只是契约。没有追加内容或无权操作的占用方必须原样返回 `children`，因为渲染器只兜住抛错的层。层也可以合法地不渲染 `children`，那会移除新建会话按钮，因此没有运行时检查能替代这项义务。

### 图片

- 图片扫描按压缩包顺序遍历选中会话的每个图片条目，不解析会话。它只解压 `chat_sessions/{id}_files/…` 中 id 属于索引所选会话的条目，以条目的扩展名与文件名调用 `ctx.attachments.saveImage({ data, mediaType, name })`，并按条目名记录引用或失败原因。扩展名不是 png / jpg / jpeg / webp / gif 时记为类型不支持，且不解压该条目。
- `convertConversation` 为 `export_path` 已被扫描保存的每个 `FILE` 条目写一个 `image` 块（在文本之前），否则写伪造的文件卡片。
- 单张图片缺失、类型不支持、超过上限、损坏或被拒绝时只把该图片写成伪造的文件卡片并记一条 Host 警告，会话照常导入。条目缺失报告 `not in the export`；大小、损坏、类型不支持或存储失败报告自身原因。附件存储按内容去重。
- 图片扫描在选中分支与转换之前保存选中会话的每个图片条目。被撤回轮次的图片、导入丢弃的分支的图片，以及转换或 `Session.create` 种子校验后来失败的会话的图片，因此都会存成没有任何事件引用的附件。`SessionPersistence` 与附件存储都不提供删除。

### 测试

| 层 | 文件 | 覆盖 |
|---|---|---|
| 纯转换 | `tests/conversation.host.spec.ts` | `current_message_id` 选择与 id 最大兜底；按 id 线性化；REQUEST / THINK / RESPONSE；`stage_id` 与搜索/打开网页的 step 切分；失败、未完成与缺少状态的搜索；图搜与无地址的打开网页丢弃；页内查找、部分读取、提示均丢弃；Markdown 链接行；被排除回答的 turn-error 与固定错误码；丢弃被内容过滤的轮次；首个与后续 turn 的空文本块；标题规范化；伪造文件卡片；无效树。输出经 `Session.create` 校验，并用 `deriveMessages` 断言模型历史 |
| 压缩包 | `tests/archive.host.spec.ts` | 列出条目、单条目读取按声明大小截断、流式扫描、用高压缩比条目验证声明大小上限、声明大小不实、重复条目名、stored 条目大小不一致、损坏条目、取消 |
| 编排 | `tests/importer.host.spec.ts` | 带进度地从旧到新导入最近 K 个；携带全部新字段的 2026-11-12 合成归档；超限、损坏与无效的会话文件；失败后补足上限；补位链在某候选无效后继续；附加失败；工作区被移除；压缩包级失败；取消；图片由图片扫描保存（与压缩包顺序无关）或写成伪造文件卡片，主路径不按名读取图片 |
| 路由 | `tests/upload.host.spec.ts` | 请求校验；`too-large`；按声明长度分配缓冲区；一次一个导入；NDJSON 行；由应答、请求与卸载触发的取消 |
| 恢复 | `tests/resume.host.spec.ts` | 生产 agent loop 继续导入的会话；模型请求包含导入的历史，不含被撤回的轮次 |
| 组合 | `tests/composition.host.spec.ts` | 经 Loader 启动 Host；`limits()` 只允许 owner；上传后会话存入工作区；导入暂停时卸载会取消导入，并且只有在导入停止后才完成，不写入任何内容 |
| Client | `tests/import-sessions.client.spec.tsx`、`tests/mount.client.spec.ts`、`tests/upload.client.spec.ts` | 按钮出现条件、工作区预选、进度条与文案、单复数摘要、失败与抛错文案、每次尝试后刷新、NDJSON 行读取与校验 |
| Bundle | `scripts/optional-bundles.spec.ts` | bundle 能叠加在 Web profile 上组合，并解析出标题、描述与图标 |
| 快照 | `apps/web/tests/deepseek-chat-import.e2e.ts`、`snapshots/web/deepseek-chat-import/` | 经路由上传一个 2026-11-12 结构的合成导出，其中包含分支、思考、一对搜索与抓取、一条读取链接记录、一个被内容过滤的轮次和一个未完成的回答；一个导入的会话以一轮录制的模型回复继续，持久化日志可 keyless 回放 |

## Alternatives considered

**输入导出文件的 host 路径。** 最初的设计从 host 绝对路径读取 ZIP 或解压目录，并在旁边新建 `<export>_workspace` 目录。用户不应输入 host 路径，浏览器也不知道这个路径，远程 Host 也访问不到用户本地下载的文件；浏览器上传对本地和远程 Host 的行为相同。

**在所选工作区中列出导出文件。** 用户先把 ZIP 放进某个工作区目录，再从 Host 端列表中选择。用户否决了这一方案，选择直接从浏览器上传文件。

**把上传暂存到磁盘。** 把上传写进临时文件可以去掉内存上限，但要增加清理逻辑、留下崩溃残留，并在 Host 上多出一份私有数据。压缩包只保存在内存中，受 `maxUploadBytes` 约束，服务一次只运行一个导入。

**在写入任何会话之前解压并校验全部会话。** 这能让“被拒绝的导出不写入任何内容”对转换失败也成立，但要同时在内存中保留所有会话文件和转换后的日志，并在整个导入期间阻塞事件循环。跟随 `chat_session_index.json` 的两次流式扫描：一次在不解析任何会话的情况下保存选中会话的图片，另一次在会话到达时逐个转换并写入。

**通过单独的流式 Remote 报告进度。** 路由应答本身已经经由 Web server 流式传输，同一请求上的 NDJSON 行不需要第二个通道，能保持进度与结果的顺序，并随请求结束。

**只导入最新的叶子。** 它一定是叶子，也不需要额外字段，但导出如果是在用户切回较旧分支之后生成的，就会静默导入另一条分支。`current_message_id` 是导出自己的线性化依据，id 最大的兜底则让没有该字段的归档仍可导入。

**按选中消息的 `inserted_at` 选择。** 它直接表示最后一条导入事件的时间，但需要每个会话的消息，选择阶段就得先解压整个压缩包。`chat_session_index.json` 携带官网自己的更新顺序，让选择阶段跳过未选中的会话；代价是顺序跟随改标题与置顶，而不是最后一条导入事件。

**通过 `ctx.agents.create({ seed })` 创建 live Agent。** 它是现有的受支持入口，但 `createdAt` 只能是当前时间，导入的会话会全部挤在侧栏顶部；导入上千个会话还会同时创建上千个 live Agent。直接写持久化层保留原始时间，也不占用运行时资源。

**每个分支一个 Session，或在 DSH 中表达分叉。** DSH Session 是线性日志；为分支各建 Session 会让一个官网会话变成多个难以区分的会话。需求明确只导入最新链。

**保留被内容过滤回答的提问并写错误行。** 官网把这类轮次显示为已撤回，用户决定两个节点都不导入；剩下的轮次与用户在官网看到的一致。

**把非 FINISHED 回答或模板回答写成 `assistant/attempt`，或写成 `interrupted` 的 `assistant/message`。** attempt 在 Web 中不可见，并会和可重试错误码一起触发“继续生成”；`interrupted` 的消息内容会进入模型上下文，违反导出文档的约束。

**在 ui-sidebar 中写死导入按钮。** 侧栏外壳需要依赖导入插件的 Remote 命名空间，把业务分支放进外壳；slot 的成本是一个声明和少量布局改动。

**新增 Session 事件类型来展示 TIP / CONTENT_RISK 或记录导入来源。** 需要扩展 `SessionEventMap`、持久化目录和 Web 渲染器，超出小规模导入的范围；这些提示不影响回答内容。

**在默认 Web 组合中挂载导入器。** 该能力是实验性的，而 release 包不能依赖实验性包。可选 bundle 让默认产品保持不变，并向启用它的用户提供导入功能。

## Consequences

导入把官网历史带进 DSH，保留原始标题、时间、思考与搜索卡片，导入的会话通过普通恢复路径继续对话。Host 内存受压缩包（`maxUploadBytes`）加一个条目（`maxEntryBytes`）、一个转换后的会话以及已保存图片的引用约束，事件循环在会话之间保持响应。代价是取消或导入中途失败时只有已写入的会话保留，而且补位的会话要按名读取，并再跑一次图片扫描。

- **冷写入是 agent loop 之外的生产写入方。** 导入使用全新的 Session id 且写完即关闭句柄，不与 live Session 竞争所有权；如果持久化层以后假设所有写入都经过 agent loop（例如在创建时注册额外的派生状态），导入路径需要同步更新。
- **已存储但未附加的会话会留在存储中。** `SessionPersistence` 不提供删除；导入在 `skipped` 中报告这样的会话及其 id。
- **历史工具调用没有工具记录。** 导入的 `web_search` / `web_fetch` 调用没有对应的 `request/header.tools` 记录。若部署未注册这两个工具，或某个提供方拒绝引用未声明工具的历史，恢复时的首个请求会失败；退路是只映射文本。
- **抓取卡片的状态码是推断值。** 导出只记录页面打开成功，没有 HTTP 状态码；`statusCode: 200` 让卡片按成功抓取显示。
- **外来 reasoning 会重新发给模型。** 导入的思考内容按无签名 thinking 发送，增加恢复后首个请求的输入 token；KV cache 从该请求开始建立。
- **重复导入产生重复会话。** 再次导入同一导出会写入新的会话；导入不记录哪些会话已经导入过。
- **用户正在查看的分支决定导入内容。** `current_message_id` 选中导入链，因此用户切回较旧分支后再导出时，导入的就是那条分支；只有字段缺失或指向不存在的消息时才回退到最新的叶子。
- **只针对一种导出结构。** 导入器面向 2026-11-12 结构。该结构新增的字段按可选读取，所以更旧的 v3 归档仍能导入，但其中的 `READ_LINK` 没有 url 与 title，链接行能写出的内容更少（更旧的 `TOOL_FIND` 查找词已不再读取）。
- **`maxTitleBytes` 是单独的设置。** session-title 服务不公开它的上限，因此修改 session-title 的 `maxTitleBytes` 的组合需要把导入器的这个字段设为相同的值。
- **放弃的内容。** 其他分支、被内容过滤的轮次、`CONTENT_RISK` 免责声明、`TIP`、`TOOL_FIND` 与 `PARTIAL_FILE_READ` 记录、`READ_LINK` 的加密正文、搜索结果的 `snippet` 与 `site_name`、`pinned` 标记、非图片文件本体、思考的逐 token 时间、`accumulated_token_usage` 都不导入；导入后的 token 计量使用估算值。被排除回答和失败搜索的说明是固定英文文本。
