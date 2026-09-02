# 用户命令

[English](commands.md) | 中文

[`dsh-commands`](../../packages/interaction/commands) 提供的用户命令注册表服务。交互式适配器用它发现插件拥有的命令，并针对确切的 agent（智能体）直接执行这些命令，而不创建模型消息。[命令 Agent Note](../../.agents/notes/implemented/feature/2026-07-19-plugin-command-registration.zh.md) 负责分发与生命周期的决策依据；[包 README](../../packages/interaction/commands/README.zh.md) 负责组合方式与限制。

来源：[`packages/interaction/commands/src/index.ts`](../../packages/interaction/commands/src/index.ts)

## 输入元数据

该服务公开一个可选的非结构化输入描述符：提示文本加图片接受标志。命令的可用性由插件组合决定：每个消费注册表的适配器都会看到全部生效定义。

```ts type-equiv
/** Immutable metadata for a command's optional unstructured input. */
interface CommandInputDescriptor {
  /** Placeholder shown before the user supplies free-form input. */
  readonly hint: string
  /**
   * Whether composer image attachments may accompany an invocation. Absent or
   * false = the executor rejects an invocation carrying images and capable
   * composers refuse the submission before dispatch. A declaring command's
   * handler receives the admitted durable blocks and owns every further
   * grammar decision, including rejecting sub-commands that cannot use them.
   */
  readonly images?: boolean
}
```

## 定义

`CommandDefinition` 是由插件编写的注册定义。注册表会验证并冻结一份与原始注册对象脱离的生效定义。

```ts type-equiv
/** Plugin-owned command registration. */
interface CommandDefinition {
  /** Lowercase command name without the leading slash. */
  readonly name: string
  /** Human-readable summary used in discovery UI. */
  readonly description: string
  /** Optional free-form input hint advertised to capable clients. */
  readonly input?: CommandInputDescriptor
  /**
   * Whether `command/run` records `rawInput`. Defaults to true. A command
   * whose domain event owns the payload sets this false to avoid duplicating
   * that payload in the session log.
   */
  readonly recordInput?: boolean
  /** Execute against the receiving agent without sending the command to the model. */
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}
```

## 调用与结果

取消由适配器负责，适配器会传入确切的目标 agent。`rawInput` 紧接在解析后的名称之后，并保留适配器传入的分隔符与后缀。结果会直接呈现给 UI，而不是工具结果或会话事件。

```ts type-equiv
/** Invocation passed to one registered command handler. */
interface CommandInvocation {
  /** Pairing id already written to this invocation's `command/run` event. */
  readonly commandId: CommandId
  /** Exact agent whose UI received the command. */
  readonly agent: Agent
  /** Exact text following the registered command name, including separator whitespace. */
  readonly rawInput: string
  /**
   * Durably admitted image blocks accompanying this invocation, in submission
   * order; empty unless the definition declares `input.images`. The handler
   * owns their model-visible use — the registry never schedules them itself —
   * and a handler whose grammar cannot use them in this invocation returns an
   * error so the dispatching composer retains the originals.
   */
  readonly attachments: readonly ImageBlock[]
  /** Cancellation signal owned by the dispatching UI request. */
  readonly signal: AbortSignal
}
```

```ts type-equiv
/** Expected command outcome rendered directly by the dispatching UI. */
type CommandResult =
  | {
    readonly kind: 'success'
    readonly text?: string
    /** Earlier authoritative domain event that owns a richer presentation. */
    readonly sourceEventSeq?: SessionSeq
  }
  | { readonly kind: 'error'; readonly text: string }
```

`sourceEventSeq` 是可选字段，且只用于成功结果。存在时，它指向接收会话日志中更早的一条非命令事件；`command/done` 会持久化同一引用，让客户端能够将命令生命周期与该领域投影合并，而无须解析 `text` 或依赖相邻行。

## 发现与解析视图

作用域解析后，适配器会获得不含处理器的不可变描述符。`parseCommand()` 在注册表解析前返回 `ParsedCommand`；语法有效的输入仍可能指向不可用的命令。

```ts type-equiv
/** Handler-free immutable command view returned to UI adapters. */
interface CommandDescriptor {
  /** Lowercase command name without the leading slash. */
  readonly name: string
  /** Human-readable summary used in discovery UI. */
  readonly description: string
  /** Optional free-form input hint advertised to capable clients. */
  readonly input?: CommandInputDescriptor
}
```

```ts type-equiv
/** Syntactically valid slash command before registry resolution. */
interface ParsedCommand {
  /** Lowercase command name without the leading slash. */
  readonly name: string
  /** Exact text following the command name. */
  readonly rawInput: string
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcommands--commandruntime"></a>

### `ctx.commands` — `CommandRuntime`

Human-command registry. Plain-context definitions are global; definitions registered through a command-injected child of an agent context shadow globals for that agent.

```ts cordis-catalog
/**
 * Register a global or calling-agent-scoped command.
 * @param definition - discovery metadata and direct UI handler.
 * @returns the exact effect disposer that unregisters this definition.
 */
register(definition: CommandDefinition): () => void

/**
 * List the effective immutable command descriptors for one agent.
 * @param agent - exact receiving agent and scoped-layer key.
 * @returns name-sorted descriptors after scoped shadowing.
 */
@Remote list(agent: Agent): readonly CommandDescriptor[]

/**
 * Resolve one effective command definition.
 * @param agent - exact receiving agent and scoped-layer key.
 * @param name - command name without a slash.
 * @returns the scoped shadow or global definition.
 */
find(agent: Agent, name: string): CommandDefinition | undefined

/**
 * Parse and execute a known command without sending it to the model.
 *
 * A resolved command's lifecycle is logged: `command/run` is appended
 * before the handler is invoked and `command/done` after settlement (a
 * thrown or aborted handler settles as `kind: 'error'`). Both are direct
 * log-only appends — no turn wraps them, and persistence drains them at
 * ordinary checkpoints. Admission misses (syntax or unknown name) log
 * nothing — they never entered a handler. A `command/run` append failure
 * fails the execution loud; a `command/done` append failure on the
 * handler-failure path is contained so the handler's own error stays the
 * reported failure.
 *
 * Image admission is enforced here, not in the composer: images sent to a
 * command that does not declare `input.images`, an absent attachment store,
 * and an exceeded attachment limit each settle as an error result before
 * the handler runs, and a rejected batch publishes no durable object.
 *
 * @param agent - exact receiving agent.
 * @param line - complete slash-command line.
 * @param images - base64-encoded composer images accompanying the line, in
 *   submission order; empty for a plain invocation.
 * @param signal - cancellation signal owned by the UI request.
 * @returns the settled execution (result + lifecycle pairing id), or
 *   `undefined` when syntax or name does not resolve.
 */
@Remote async execute( agent: Agent, line: string, images: readonly EncodedImageAttachment[], signal: AbortSignal, ): Promise<CommandExecution | undefined>
```

Types: [Agent](core.zh.md) · [EncodedImageAttachment](attachment.zh.md)

Source: [`packages/interaction/commands/src/index.ts`](../../packages/interaction/commands/src/index.ts)

<a id="commands-events"></a>

### `commands/*` events

<a id="commandschange--emit"></a>

#### `commands/change` — emit

A command was registered or unregistered. This is an unfiltered registry notification because a global or scoped change may affect any UI view. Observer failures are contained and cannot veto the registry mutation.

```ts cordis-catalog
/**
 * A command was registered or unregistered. This is an unfiltered registry
 * notification because a global or scoped change may affect any UI view.
 * Observer failures are contained and cannot veto the registry mutation.
 * @mode emit
 */
'commands/change'(): void
```

Source: [`packages/interaction/commands/src/types.ts`](../../packages/interaction/commands/src/types.ts)
<!-- END GENERATED cordis-surface -->
