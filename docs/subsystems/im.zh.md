# IM 自动化

[English](im.md) | 中文

IM 保存每条被接纳规则接受的消息，并通过 `im/message` 事件链派发给已挂载的插件。已挂载的插件可以先处理消息：[`session-commands`](../../packages/experimental/im-session-commands/README.zh.md) 在其他监听器之前响应斜杠命令。没有任何插件接手且提及了机器人的消息，在配置了 `defaultDispatch` 时会交给宿主内置、所有聊天共享的默认分派会话处理，未配置时则忽略。宿主负责管理会话记录、消息存储、带持久化回执的消息发送，以及供输出渲染器使用的轮次活动状态。宿主配置见[服务 README](../../packages/experimental/im/README.zh.md)，部署方式见 [profile README](../../packages/experimental/im-bundle/README.zh.md)。

## 引用与结果

公开[接口定义](../../packages/experimental/im/src/api.ts)在消息接收、历史读取、会话投递和消息发送之间保持统一的平台身份标识，并定义托管 agent 可执行的操​​作。[会话宿主](../../packages/experimental/im/src/sessions.ts)管理托管会话与持久化投递记录；[消息存储](../../packages/experimental/im/src/store.ts)为每个聊天分配递增序号以支持按序号读取历史；[发送器](../../packages/experimental/im/src/send.ts)负责写权限校验与发送回执记录。

| 类型 | 含义 |
|---|---|
| `ImSourceId` | 运维配置的接纳规则 id，保存在聊天和消息的 `source` 字段中 |
| `ImChatKey` | 全局聊天标识，格式为 `${bot}\|${chat.id}` |
| `ImMessageKey` | 全局消息标识，格式为 `${bot}\|${message.id}` |
| `ImChat` | 已接纳的聊天：全局键、所属机器人 id、适配器的 `ChatRef` 以及接纳它的规则 id |
| `ImMessage` | 已存储的消息：全局键、入库时分配的聊天内递增 `seq`、聊天信息、话题线程、带 `self` 标记的发送者、消息元素树、纯文本、引用信息、提及信息、`addressed` 标记、可选的解析后 `command`、时间戳、来源途径 `via`（`platform` 或 `self`）、可选备用消息 id `aliases`（供按别名查找引用/读取）以及适配器上下文 `referrer` |
| `ImCommand` | 去除开头的机器人自身提及后解析出的斜杠命令：命令名与原始参数文本 |
| `ImOutcome` | 事件链的处理结果：由某个具名插件 `handled`（可附带目标会话 id 列表），或 `ignored`（可附带原因） |
| `ImMessageEvent` | 事件链参数：已存消息、匹配的来源配置、机器人实例，以及绑定到该聊天的 `reply`、`send` 和幂等 `deliver` 方法 |
| `ImButtonEvent` | 已接纳聊天中的按钮点击事件：按钮 id、附加数据、聊天、触发用户、机器人、按钮所属的已存消息、发布该消息的会话以及原始交互对象 |
| `ImReactionEvent` | 已接纳聊天中对已存消息添加或移除的表情回应：动作、平台表情标识、聊天、触发用户、机器人、被回应的已存消息、已知时发布该消息的会话、时间戳以及可选的平台事件 id |
| `ImComposition` | 托管会话的 agent 配置：agent 预设、工作目录、provider、model 以及可选的工具限制 |
| `ImBinding` | 单个聊天的访问授权：是否允许发送消息、是否为默认（`home`）聊天，以及可选的话题线程限制 |
| `ImSessionSpec` | 插件创建或更新会话的声明：稳定键、归属插件名、agent 配置、聊天绑定列表、输出渲染器、可选父会话、临时会话标记 `ephemeral` 以及插件自定义元数据 |
| `ImSessionRecord` | 已存储的会话记录：包含 `ImSessionSpec`、派生的 `sessionId`、重置时递增的 `generation` 以及时间戳 |
| `ImDelivery` | 持久化投递记录：幂等 id、投递模式、模型消息内容或待格式化的已存消息列表、触发消息、是否下载媒体以及可选头部文本 |
| `ImDeliveryMode` | 投递模式：`steer` 加入正在运行的轮次或启动新轮次，`followup` 排队等待下一轮，`inject` 仅注入上下文而不唤醒空闲 agent |
| `ImSessions` | 托管会话管理接口：`ensure`、`get`、`list`、`forChat`、`deliver`、`deliveredTo`、`reset`、`bind`、`agent`、`of`、`stop` 与 `trigger` |
| `ImResetOptions` | 会话重置选项：持久化回执幂等键 `operationId` 与乐观并发代次校验 `expectedGeneration` |
| `ImSendOptions` | 消息发送选项：回执幂等键 `operationId`、目标聊天已存的被引用消息键（否则抛出 `ImError('access')`）、目标话题线程，以及用于权限校验和归属记录的 `session` |
| `ImSendResult` | 发送结果（`confirmed`、`failed`、`uncertain` 或 `partial`），附带平台消息句柄、渲染报告、已存自身消息与错误信息 |
| `ImOutgoing` | `im/before-send` 瀑布流传递的可变草稿：目标聊天、调用方选项、调用方原始内容、将要发布的内容以及可选的 `drop` 原因 |
| `ImHistory` | 按聊天内 `seq` 读取历史的接口：`after`、`before`、`get` 与 `latest` |
| `ImFormatOptions` | 消息格式化选项：`xml` 或 `line` 格式、是否附带媒体图片块、可选头部文本与取消信号 |
| `ImApi` | `ctx.im` 服务接口：`sessions`、`history`、`outputs`、`send`、`stream`、`readMessage`、`format`、`bot`、`chat` 与 `status` |
| `ImStatus` | 诊断状态快照：已挂载机器人、已配置来源规则、托管会话、待完成投递数、待派发消息数以及最近的处理结果 |
| `ImSegment` | 单轮活动中的一个片段：累积的助手文本、累积的思考内容，或带有限长度参数与结果预览及状态的工具调用 |
| `ImActivity` | 托管会话单轮活动的快照：会话记录、轮次号、运行状态、当前所有片段、触发消息、错误信息与时间戳 |
| `ImActivityChange` | 活动更新类型：`start`、`delta`、`tool` 或 `end` |
| `ImOutputRenderer` | 输出渲染器插件接口：包含唯一 `id` 以及在轮次开始时调用的 `begin(activity, io)` |
| `ImOutputIO` | 传给渲染器的单轮发布接口：目标聊天，以及归属到该会话的 `stream` 与 `send` 方法 |
| `ImTurnOutput` | 渲染器返回的单轮控制句柄：运行期间调用 `update`，轮次结束时调用一次 `end` |

`confirmed` 表示平台已确认发布并写入持久化回执。`failed` 表示平台明确返回错误且未发布任何内容。`partial` 表示多段消息中仅有部分分段发布成功。请求发出后发生网络错误、超时或取消，或者已记录发送但无结果回执的操作，均返回 `uncertain`；此时必须先检查目标聊天，再决定是否重新发送。使用相同 `operationId` 重放会直接返回已记录的结果而不会重复发送；相同 `operationId` 传入不同内容会抛出 `conflict` 错误。服务不会自动重发状态为 `uncertain` 的操作。

## 发布所用的资源

发布内容用 URL 指明其中的媒体，prepare 阶段把每个源都交给 `ctx.http` 解析：`data:`/`base64:` 在本地解码，`satori:` 走核心自己的内部路由，`file:` 或 `http(s)` 则变成本机的一次读取或一次请求。该服务既没有 scheme 策略也没有地址策略，因此发布内容可以引用本进程能触达的任何东西。`im_send_file` 以绝对 `file:` URL 发布会话给出的路径——`cwd` 只用于锚定相对路径，`~` 会展开——只有工作目录位于另一执行世界（SSH 工作区）时才读取字节并内联，且受 `send.maxMediaBytes` 约束。

收到的媒体按更窄的规则处理：消息由聊天成员写就、会话只负责读，因此 `ImMediaStore` 在任何 I/O 之前就拒绝 `media.source` 不接受的源。`file:` 元素，以及主机为（或解析到）回环、私有、链路本地或组播地址的 `http(s)` 元素，都以「跳过」项而不是下载进入模型输入；内联的 `data:`/`base64:` 源始终放行；`satori:` 资源只在接收该消息的 bot 自己的路由下放行，因为适配器用该应用的凭据下载它。随后的抓取要求传输层不跟随重定向（3xx 记为跳过），在 `media.timeoutMs` 内解析不出的主机名直接拒绝，整次下载（含响应体）也在这个截止时间结束。地址规则只判定一次解析返回的结果，并不把连接固定到该地址：抓取会再解析一次主机名，两次之间答案改变的名字（DNS 重绑定）不在这条规则的覆盖范围内。

读的能力由部署决定，而不是由 IM 决定：文件系统沙箱只围住五个写操作，任何模式下读都放行，shell 的沙箱配置也把整个文件系统以只读方式挂载。因此托管会话自身的工具能读到同样的文件；发布这条路径没有给 agent 增加它原本不具备的能力——增加的是把这些字节送进聊天的通道。

## 会话来源与持久化状态

`MessageSourceMap.im` 包含 `kind: 'im'` 与 `form: 'relay'`，使读取方能够区分外部聊天输入与所有者输入（`kind: 'user'`）。它不授予任何权限。每次托管投递都有稳定的投递 id，会话宿主据此派生写入的消息 id。

IM 各包在 Session 日志之外使用四个独立的存储域保存持久化状态：
- `im_messages`（[`state.ts`](../../packages/experimental/im/src/state.ts)）：平台事件去重摘要、已存消息及其派发状态与结果，以及各聊天的身份信息与当前递增序号。
- `im_sessions`（[`sessions.ts`](../../packages/experimental/im/src/sessions.ts)）：托管会话记录（归属插件、agent 配置、聊天绑定、输出渲染器、代次）、待写入收件箱的投递记录以及幂等重置回执。
- `im_receipts`（[`send.ts`](../../packages/experimental/im/src/send.ts)）：按 `operationId` 索引的发送回执。
- `im_session_commands`（[`commands.ts`](../../packages/experimental/im-session-commands/src/commands.ts)）：按消息键索引的已处理斜杠命令回复与目标会话回执。

会话宿主在将投递标记为完成后，会先在目标会话的持久化日志中检查是否已存在对应消息 id 的收件箱插入记录，从而避免重启恢复时重复写入。事件去重记录、重置回执与命令回执在超过各自配置的 `retentionMs` 后过期清理。

## Cordis API

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxim--imservice"></a>

### `ctx.im` — `ImService`

Single-process IM host; module wiring only — behaviour lives in the per-concern modules.

```ts cordis-catalog
/**
 * Configured admission rule by id.
 * @param id - the operator id of the source.
 * @returns the source, or undefined when no source carries that id.
 */
source(id: string): ImSourceConfig | undefined

/**
 * Publish content into one admitted chat, recording a durable receipt when `operationId` is provided.
 * @param chat - the target chat key.
 * @param content - the message content, normalized by the adapter's mode.
 * @param options - quote, thread, operation id and delivery overrides.
 * @returns the published handle and the render report of every part.
 */
send(chat: ImChatKey, content: Fragment, options?: ImSendOptions): Promise<ImSendResult>

/**
 * Open a streaming publication into one admitted chat.
 * @param chat - the target chat key.
 * @param options - quote, thread and the stream strategy options.
 * @returns the message stream the caller drives with updates.
 */
stream(chat: ImChatKey, options?: ImSendOptions & StreamOptions): Promise<MessageStream>

/**
 * Format stored messages as model-facing user-message content.
 * @param messages - the messages to format, in chat order.
 * @param options - style, media admission and header options.
 * @returns the text (and admitted images) the model receives.
 */
format(messages: readonly ImMessage[], options?: ImFormatOptions): Promise<UserMessage['content']>

/**
 * The mounted bot that serves one chat.
 * @param chat - the chat key, whose bot segment names the bot.
 * @returns the bot serving that chat.
 */
bot(chat: ImChatKey): Bot

/**
 * The retained record of one admitted chat.
 * @param key - the chat key.
 * @returns the chat record, or undefined when the chat was never admitted.
 */
chat(key: ImChatKey): ImChat | undefined

/**
 * One message of one chat: the stored message when this deployment received it, and a platform read otherwise, so a
 * reference to a message that never reached this deployment still resolves. A platform read is admitted and stored
 * like any other message, which gives it a sequence number and keeps later reads of it local.
 * @param chat - chat to read in; its bot serves the platform request.
 * @param id - platform message id.
 * @param signal - optional cancellation signal from the caller.
 * @returns the message as the store holds it, with a merged forward's entries filled in when the platform has them.
 */
async readMessage(chat: ImChatKey, id: string, signal?: AbortSignal): Promise<ImMessage>

/**
 * One page of the people a chat lists as its members: the id a mention addresses and the name to show.
 * @param chat - chat whose members are listed; its bot answers the platform request.
 * @param cursor - `page_token` of the previous page.
 * @param limit - page-size hint; the platform bounds it.
 * @param signal - optional cancellation signal from the caller.
 * @returns the page the adapter read.
 */
async members(chat: ImChatKey, cursor?: string, limit?: number, signal?: AbortSignal): Promise<MembersPage>

/**
 * A snapshot of the deployment: bots, sources, sessions, pending work and recent messages.
 * @returns the current status.
 */
status(): ImStatus
```

Types: [UserMessage](session.zh.md)

Source: [`packages/experimental/im/src/index.ts`](../../packages/experimental/im/src/index.ts)

<a id="im-events"></a>

### `im/*` events

<a id="imactivity--emit"></a>

#### `im/activity` — emit

A hosted session's turn activity changed; output renderers subscribe to redraw their message.

```ts cordis-catalog
/**
 * A hosted session's turn activity changed; output renderers subscribe to redraw their message.
 * @param activity - the whole activity of the turn, with every segment so far.
 * @param change - which part changed: start, a segment delta, a tool update, or the end.
 * @mode emit
 */
'im/activity'(activity: ImActivity, change: ImActivityChange): void
```

Source: [`packages/experimental/im/src/api.ts`](../../packages/experimental/im/src/api.ts)

<a id="imbefore-send--waterfall"></a>

#### `im/before-send` — waterfall

One `ctx.im.send` publication is about to be dispatched (grants already checked): listeners may replace `outgoing.content` or set `outgoing.drop`, then call `next()`. Not run for streams or for replayed operations.

```ts cordis-catalog
/**
 * One `ctx.im.send` publication is about to be dispatched (grants already checked): listeners may replace
 * `outgoing.content` or set `outgoing.drop`, then call `next()`. Not run for streams or for replayed operations.
 * @param outgoing - the mutable draft: chat, caller options, the caller's original content and the current content.
 * @param next - the rest of the waterfall.
 * @mode waterfall
 */
'im/before-send'(outgoing: ImOutgoing, next: () => Promise<void>): Promise<void>
```

Source: [`packages/experimental/im/src/api.ts`](../../packages/experimental/im/src/api.ts)

<a id="imbutton--emit"></a>

#### `im/button` — emit

A button of a published message was clicked, with the chat, sender and producing session.

```ts cordis-catalog
/**
 * A button of a published message was clicked, with the chat, sender and producing session.
 * @param event - the click, its message and the raw platform interaction.
 * @mode emit
 */
'im/button'(event: ImButtonEvent): void
```

Source: [`packages/experimental/im/src/api.ts`](../../packages/experimental/im/src/api.ts)

<a id="imcheck--emit"></a>

#### `im/check` — emit

A checkbox of a published message was toggled, with the chat, sender, new state and producing session.

```ts cordis-catalog
/**
 * A checkbox of a published message was toggled, with the chat, sender, new state and producing session.
 * @param event - the toggle, its message and the raw platform interaction.
 * @mode emit
 */
'im/check'(event: ImCheckEvent): void
```

Source: [`packages/experimental/im/src/api.ts`](../../packages/experimental/im/src/api.ts)

<a id="immessage--waterfall"></a>

#### `im/message` — waterfall

An admitted inbound message; listeners call `next()` to pass it on and the default outcome ignores it.

```ts cordis-catalog
/**
 * An admitted inbound message; listeners call `next()` to pass it on and the default outcome ignores it.
 * @param event - the admitted message with its chat, source and renderer state.
 * @param next - the rest of the waterfall; call it to let the next listener decide the outcome.
 * @mode waterfall
 */
'im/message'(event: ImMessageEvent, next: () => Promise<ImOutcome>): Promise<ImOutcome>
```

Source: [`packages/experimental/im/src/api.ts`](../../packages/experimental/im/src/api.ts)

<a id="imreaction--emit"></a>

#### `im/reaction` — emit

A reaction was added to or removed from a stored message in an admitted chat.

```ts cordis-catalog
/**
 * A reaction was added to or removed from a stored message in an admitted chat.
 * @param event - the reaction, its target message, actor, and producing session when known.
 * @mode emit
 */
'im/reaction'(event: ImReactionEvent): void
```

Source: [`packages/experimental/im/src/api.ts`](../../packages/experimental/im/src/api.ts)

<a id="imselect--emit"></a>

#### `im/select` — emit

A `<select>` of a published message was used, with the chat, sender, picked values and producing session.

```ts cordis-catalog
/**
 * A `<select>` of a published message was used, with the chat, sender, picked values and producing session.
 * @param event - the pick, its message and the raw platform interaction.
 * @mode emit
 */
'im/select'(event: ImSelectEvent): void
```

Source: [`packages/experimental/im/src/api.ts`](../../packages/experimental/im/src/api.ts)

<a id="imsessioncreated--emit"></a>

#### `im/session/created` — emit

A hosted session record was created, including the new record a reset creates.

```ts cordis-catalog
/**
 * A hosted session record was created, including the new record a reset creates.
 * @param record - the created record with its session id and generation.
 * @mode emit
 */
'im/session/created'(record: ImSessionRecord): void
```

Source: [`packages/experimental/im/src/api.ts`](../../packages/experimental/im/src/api.ts)

<a id="imsessionreset--emit"></a>

#### `im/session/reset` — emit

A hosted session was reset: its generation advanced and a fresh session id was issued.

```ts cordis-catalog
/**
 * A hosted session was reset: its generation advanced and a fresh session id was issued.
 * @param record - the record that was just replaced; the new record arrives through `im/session/created`.
 * @param reason - why the reset happened, as the caller reported it.
 * @mode emit
 */
'im/session/reset'(record: ImSessionRecord, reason: string): void
```

Source: [`packages/experimental/im/src/api.ts`](../../packages/experimental/im/src/api.ts)

<a id="imstored--emit"></a>

#### `im/stored` — emit

A message was stored: an admitted inbound message or an own outbound publication.

```ts cordis-catalog
/**
 * A message was stored: an admitted inbound message or an own outbound publication.
 * @param message - the stored record with its per-chat sequence number.
 * @mode emit
 */
'im/stored'(message: ImMessage): void
```

Source: [`packages/experimental/im/src/api.ts`](../../packages/experimental/im/src/api.ts)
<!-- END GENERATED cordis-surface -->
