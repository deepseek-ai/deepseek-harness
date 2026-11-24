# IM automation

English | [中文](im.zh.md)

IM stores every message accepted by an admission rule and dispatches it on the `im/message` waterfall. Mounted plugins may handle a message first: [`session-commands`](../../packages/experimental/im-session-commands/README.md) answers slash commands before any other listener. An addressed message that no plugin handles goes to the host's default dispatcher session, shared by every chat, when `defaultDispatch` is configured, and is ignored otherwise. The host manages session records, message storage, outbound publication with durable receipts, and per-turn activity for output renderers. See the [service README](../../packages/experimental/im/README.md) for host configuration and the [profile README](../../packages/experimental/im-bundle/README.md) for deployment.

## References and results

The public [contracts](../../packages/experimental/im/src/api.ts) define platform identities across intake, history reads, session deliveries, and outbound publications. The [session host](../../packages/experimental/im/src/sessions.ts) manages hosted sessions and durable delivery intents, the [message store](../../packages/experimental/im/src/store.ts) assigns per-chat sequence numbers for history lookups, and the [sender](../../packages/experimental/im/src/send.ts) verifies write grants and records publication receipts.

| Type | Meaning |
|---|---|
| `ImSourceId` | Operator-configured admission rule id; stored on the chat and message as `source` |
| `ImChatKey` | Global chat identity, `${bot}\|${chat.id}` |
| `ImMessageKey` | Global message identity, `${bot}\|${message.id}` |
| `ImChat` | An admitted chat: its key, the bot that serves it, the adapter's `ChatRef`, and the rule that admitted it |
| `ImMessage` | A stored message: key, per-chat `seq` assigned at store time, chat, thread, sender with `self` flag, content, plain text, quote, mentions, `addressed`, optional parsed `command`, timestamp, `via` (`platform` or `self`), optional `aliases` (platform-local alternate message ids for alias lookup), and adapter referrer |
| `ImCommand` | A slash command parsed from a message after stripping leading self-mentions: command name and raw input |
| `ImOutcome` | Waterfall result: `handled` by a named plugin (with optional target session ids), or `ignored` (with optional reason) |
| `ImMessageEvent` | Waterfall argument: the stored message, its source configuration, the bot, plus chat-bound `reply`, `send`, and idempotent `deliver` helpers |
| `ImButtonEvent` | A button click in an admitted chat: button id, data, chat, user, bot, the stored message carrying the button, the session that published it, and the raw interaction |
| `ImReactionEvent` | A reaction added to or removed from a stored message in an admitted chat: action, platform emoji identity, chat, user, bot, the stored message, the session that published it when known, timestamp, and optional platform event id |
| `ImComposition` | Agent configuration for a hosted session: agent preset, working directory, provider, model, and optional tool restriction |
| `ImBinding` | Access grant for one chat: whether the session may publish there, whether it is the default (`home`) chat, and an optional thread restriction |
| `ImSessionSpec` | Session request from an owner plugin: stable key, owner name, composition, bindings, output renderer, optional parent session, `ephemeral` flag, and owner metadata |
| `ImSessionRecord` | Stored session record: its spec plus the derived session id, generation counter, and timestamps |
| `ImDelivery` | Durable delivery intent: idempotency id, delivery mode, content or stored messages to format, trigger message, optional media download flag, and optional header |
| `ImDeliveryMode` | Delivery mode: `steer` joins a running turn or starts one, `followup` queues a turn, `inject` adds context without waking an idle agent |
| `ImSessions` | Hosted session manager: `ensure`, `get`, `list`, `forChat`, `deliver`, `deliveredTo`, `reset`, `bind`, `agent`, `of`, `stop`, and `trigger` |
| `ImResetOptions` | Session reset options: durable receipt `operationId` and optimistic `expectedGeneration` guard |
| `ImSendOptions` | Outbound publication options: receipt `operationId`, same-chat stored quoted message key (`ImError('access')` otherwise), target thread, and the session used for grant checks and attribution |
| `ImSendResult` | Publication outcome (`confirmed`, `failed`, `uncertain`, or `partial`), with the platform handle, render report, stored own message, and error message |
| `ImOutgoing` | Mutable draft that the `im/before-send` waterfall passes along: target chat, caller options, the caller's original content, the content to publish, and an optional `drop` reason |
| `ImHistory` | Per-chat history queries by `seq`: `after`, `before`, `get`, and `latest` |
| `ImFormatOptions` | Message formatting options: `xml` or `line` style, media attachment flag, optional header, and abort signal |
| `ImApi` | Service interface on `ctx.im`: `sessions`, `history`, `outputs`, `send`, `stream`, `readMessage`, `format`, `bot`, `chat`, and `status` |
| `ImStatus` | Diagnostic snapshot: mounted bots, configured sources, hosted sessions, pending deliveries, pending messages, and recent outcomes |
| `ImSegment` | One segment of a turn: accumulated assistant text, accumulated reasoning, or a tool call with bounded argument and result previews and status |
| `ImActivity` | Turn activity snapshot of a hosted session: session record, turn number, status, segments, trigger message, error message, and timestamps |
| `ImActivityChange` | Activity event kind: `start`, `delta`, `tool`, or `end` |
| `ImOutputRenderer` | Turn output renderer registered under an id, with `begin(activity, io)` called at turn start |
| `ImOutputIO` | Per-turn publication interface passed to a renderer: the target chat and session-attributed `stream` and `send` |
| `ImTurnOutput` | Per-turn renderer handle: `update` during the turn and `end` when the turn settles |

A `confirmed` result has a durable platform receipt. `failed` means the platform rejected the request before publishing anything. `partial` means only some parts of a multi-part message were published. A transport error, timeout, or cancellation after dispatch, or a stored operation with no recorded outcome, returns `uncertain`; callers must inspect the chat before sending the same content again. Replaying an `operationId` returns the recorded receipt without resending, while reusing an `operationId` with different content throws a `conflict` error. The service never resends an uncertain operation automatically.

## Publication resources

Published content names its media by URL, and prepare resolves every source through `ctx.http`: `data:`/`base64:` decode inline, `satori:` routes to the core's own internal handler, and `file:` or `http(s)` become a read of this host or a request from it. That service applies neither a scheme nor an address policy, so a publication may reference anything this process can reach. `im_send_file` publishes the file at the path the session names as an absolute `file:` URL — `cwd` only anchors a relative path and `~` expands — and inlines the bytes only when the working directory lives in another execution world (an SSH workspace), bounded by `send.maxMediaBytes`.

Received media follows a narrower rule, because the chat member writes the message and the session only reads it: `ImMediaStore` refuses a source before any I/O unless `media.source` accepts it. A `file:` element, and an `http(s)` element whose host is or resolves to a loopback, private, link-local or multicast address, reach the model as a skipped item instead of a download; inline `data:`/`base64:` sources always pass, and a `satori:` resource passes only under the route of the bot that received the message, because the adapter downloads it with that application's credentials. The fetch that follows asks the transport for no redirect (a 3xx is skipped, not followed), a host the resolver cannot answer for within `media.timeoutMs` is refused, and the whole download, body included, ends at that deadline. The address rule classifies what one lookup returns and does not pin the connection to it: the fetch resolves the name again, so a name whose answer changes in between (DNS rebinding) is outside what the rule covers.

Reads are governed by the deployment rather than by IM: the filesystem sandbox fences the five mutations and permits every read in every mode, and the shell profiles bind the whole filesystem read-only. A hosted session's own tools therefore reach the same files, so the publication path adds no authority the agent did not already have — what it adds is a way to put those bytes into a chat.

## Session attribution and durable state

`MessageSourceMap.im` records `kind: 'im'` and `form: 'relay'`, so readers can tell external chat input apart from owner input (`kind: 'user'`). It grants no authority. Each hosted delivery has a stable id from which the session host derives the inserted message id.

IM packages persist state in four storage domains alongside the Session logs:
- `im_messages` ([`state.ts`](../../packages/experimental/im/src/state.ts)): deduplicated platform event digests, stored messages with their dispatch state and outcome, and per-chat metadata and sequence counters.
- `im_sessions` ([`sessions.ts`](../../packages/experimental/im/src/sessions.ts)): hosted session records (owner, composition, bindings, output renderer, generation), pending delivery intents, and idempotent reset receipts.
- `im_receipts` ([`send.ts`](../../packages/experimental/im/src/send.ts)): outbound publication receipts keyed by `operationId`.
- `im_session_commands` ([`commands.ts`](../../packages/experimental/im-session-commands/src/commands.ts)): handled slash-command reply and target-session receipts keyed by message key.

Before marking a delivery intent admitted, the session host checks the target session's log for an existing inbox insertion with the derived message id, preventing duplicate insertions across restarts. Event deduplication records, reset receipts, and command receipts expire after their configured `retentionMs`.

## Cordis API

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [UserMessage](session.md)

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
