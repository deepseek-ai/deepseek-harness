# MCP

[English](mcp.md) | 中文

## 摘要

模型上下文协议（Model Context Protocol，MCP）让模型使用外部服务器提供的工具。每个已配置服务器都会提供普通 Harness 工具，支持取消、权限检查、结果记录和受支持的图像输出。调用方作用域中配置了服务器时，共享工具负责发现和读取资源，服务器指令则加入已记录的系统提示词。官方 SDK 协商现代或受支持的旧版协议。本参考页介绍 MCP 包组的职责、作用域和组合选择；服务器配置由[客户端 README](../../packages/mcp/mcp-client/README.zh.md) 维护。

## 目录

- [配置](#configuration)
- [职责与作用域](#responsibilities-and-scope)
- [协议与结果](#protocol-and-results)
- [资源与指令](#resources-and-instructions)
- [资源提供方类型](#resource-provider-types)
- [限制](#limits)
- [延伸阅读](#further-reading)

-----

<a id="configuration"></a>
## 配置

MCP 服务器需要主动配置。在目标 Cordis 作用域中，为每台服务器配置一个 `@deepseek-ai/dsh-mcp-client` 条目。每个随附 profile 都提供[工具注册表](tools.zh.md)，并统一挂载共享资源服务一次；用户只需配置客户端条目。调用方没有可见的已配置服务器时，在 native 或 PTC 模式下都不会获得 MCP 提示词文本或工具。

Web 与 Desktop profile 还统一挂载一次 [MCP 服务器管理器](../../packages/mcp/mcp-manager/README.zh.md)。它运行通过 Settings 配置的服务器、组合中以 `@deepseek-ai/dsh-mcp-manager/server` 独立成行声明的服务器，以及已安装插件在自身生命周期内注册的服务器，并向 Remote 客户端提供它们的状态、重启与探测操作。注册 OAuth 服务器的插件通过 [`dsh-mcp-account`](../../packages/mcp/mcp-account/README.zh.md) 的 `ctx.mcpAccounts` 注册账号，使其显示在**插件**页面上。

| 选择 | 配置维护位置 |
|---|---|
| 服务器身份、本地进程或 HTTP 端点、凭据和进程环境 | [客户端配置](../../packages/mcp/mcp-client/README.zh.md#use-this-package) |
| 工具与资源请求超时、启动失败策略和重连 | [客户端配置](../../packages/mcp/mcp-client/README.zh.md#use-this-package) |
| 资源发现与读取 | 随附 profile 已包含 [MCP 资源服务](../../packages/mcp/mcp-resources/README.zh.md#use-this-package)；该服务没有配置字段 |
| 服务器指令大小限制 | 客户端 `maxInstructionBytes`；组合提供[系统提示词装配](system-prompt.zh.md) |
| 权限决策和受支持的图像输出 | [工具执行](tools.zh.md)和[附件](attachment.zh.md) |

协议协商遵循 SDK 支持的修订版；产品没有强制指定协议修订版的设置。[配置目录](../config-catalog.zh.md#deepseek-aidsh-mcp-client) 列出客户端接受的字段和默认值。

-----

<a id="responsibilities-and-scope"></a>
## 职责与作用域

客户端是每服务器一个的连接插件，也是 Harness 工具注册表的消费者。它不发布共享的 `ctx.mcp` 服务；管理器为其挂载的宿主全局服务器发布 `ctx.mcpManager`。外部服务器实现 MCP 操作；SDK 拥有协议交换；客户端将发现的工具适配到 Harness 执行过程。

`mcp-resources` 拥有共享资源工具，并在调用方作用域中选择提供方。每个 MCP 客户端通过自己的连接提供资源操作。作用域中的首个提供方启用本地共享工具，移除最后一个提供方时移除这些工具；继承的提供方仍然可见。服务独立于任何单一客户端拥有这些工具注册。只要可见的客户端条目保持激活，连接失败就不会移除共享资源工具。

配置的 `serverName` 在注册作用域内标识服务器。同一作用域中的两个条目不能占用相同名称；不同 Agent 作用域可以复用该名称。公开工具名包含配置的服务器名称，因此不同服务器的同名工具仍可区分。注册副作用拥有名称和已发现工具；插件释放时关闭连接并移除其贡献。

[原生 Cua Driver 提供方](../../packages/experimental/computer-use-cua-driver-native/README.zh.md) 复用客户端导出的结果适配器，无需打开 MCP 连接。桌面提供方选择属于[计算机使用子系统](computer-use.zh.md)。

-----

<a id="protocol-and-results"></a>
## 协议与结果

stdio 和 Streamable HTTP 都使用官方 SDK 的协商、发现、协议校验和取消机制。工具列表变化通过旧版通知或现代订阅触发发现。刷新失败时保留上一代工具；连接恢复遵循[客户端生命周期](../../packages/mcp/mcp-client/README.zh.md#use-this-package)。

结果适配器为程序化调用方保留规范 MCP JSON，并准备普通工具内容。受支持的图像使用附件系统；不受支持的富内容产生明确的文本诊断。服务器 `isError` 结果与请求失败抛出 `McpToolError`，其 code 告诉调用方请求结果是否已知，例如 `MCP_TOOL_ERROR`、`MCP_CONNECTION_CLOSED` 或 `MCP_TIMEOUT`；客户端 README 列出全部 code。工具注册表仍决定策略失败和结果替换。[工具契约](tools.zh.md) 维护记录和最终呈现规则；[客户端结果参考](../../packages/mcp/mcp-client/README.zh.md#use-this-package) 维护 MCP 特有的投影细节。

-----

<a id="resources-and-instructions"></a>
## 资源与指令

资源调用必须显式指定配置的服务器名称。系统提示词组装服务可用时，资源服务从派发所用的同一注册表列出调用方可见的名称，包括没有工具或指令的服务器。共享注册表在分发前，于调用 Agent 的作用域中解析该名称；不可用的服务器会在发出网络请求前失败。发现和读取均按需执行，也支持只提供资源而不提供工具的服务器。[资源包](../../packages/mcp/mcp-resources/README.zh.md) 维护分页和内容渲染规则；其生成的工具 schema 位于[工具目录](../tool-catalog.zh.md#deepseek-aidsh-mcp-resources)。

资源提供方仍由连接拥有。作用域释放时移除注册；MCP 客户端控制取消和恢复。规范结果为程序化调用方保留完整 JSON，文本投影则以描述替换二进制 blob。返回的文本进入普通工具历史；服务器连接本身不会触发内容读取。

组合包含系统提示词装配时，客户端将非空白的服务器指令发布为带服务器归属的作用域章节。指令保持字面文本，并在发布前通过配置的大小限制。替换连接仅在发现成功后发布指令；缺少指令时不添加章节。[系统提示词子系统](system-prompt.zh.md) 维护装配与记录规则。

-----

<a id="resource-provider-types"></a>
## 资源提供方类型

连接提供方接收一个操作与原始工具执行对象，其中包含调用方和取消信号。

```ts type-equiv
/** One supported resource operation, with server-owned cursors and URIs. */
type McpResourceRequest =
  | { method: 'resources/list' | 'resources/templates/list'; cursor?: string }
  | { method: 'resources/read'; uri: string }
```

```ts type-equiv
/** One configured server's resource access, owned by its MCP connection plugin. */
interface McpResourceProvider {
  /**
   * Run an operation against one live connection generation. The resource tools
   * dispatch in parallel, so one provider may receive several concurrent requests;
   * each must settle independently.
   * @param request - MCP resource method and parameters.
   * @param exec - caller identity and cancellation for this invocation.
   * @returns the protocol result as lossless JSON.
   */
  request(request: McpResourceRequest, exec: ToolExecution): Promise<JsonValue>
}
```

-----

<a id="limits"></a>
## 限制

不支持 MCP 提示词模板、人工输入征询、基于任务的执行和资源订阅。资源工具需要调用方可见的已配置服务器；二进制资源保留为程序化数据，模型接收其文本描述。没有工具能力的服务器以空工具集连接。连接和发现超时遵循 SDK；客户端没有对应的独立设置。

-----

<a id="further-reading"></a>
## 延伸阅读

- [MCP 包组](../../packages/mcp/README.zh.md) — 包入口。
- [MCP 资源](../../packages/mcp/mcp-resources/README.zh.md) — 共享工具与资源提供方语义。
- [MCP 管理器](../../packages/mcp/mcp-manager/README.zh.md) — 通过 Settings 配置的服务器、服务器行与插件注册的服务器；状态及 Remote 操作。
- [资源可见性参考](../../packages/mcp/mcp-resources/README.zh.md) — profile 统一挂载及由已配置服务器决定的可见性。
- [第三方记忆服务器](../user/guide/mcp-memory.zh.md) — 产品配置指南。
- [协议协商参考](../../packages/mcp/mcp-client/README.zh.md) — SDK 职责与兼容性决策。
- [Computer Use MCP 服务器](../../packages/experimental/cua-mcp/README.zh.md) — DSH 作为 MCP stdio 服务器向其他 harness 提供 Computer Use 程序。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmcpaccounts--mcpaccounts"></a>

### `ctx.mcpAccounts` — `McpAccounts`

Shows each connector's MCP server account in the connector account registry.

```ts cordis-catalog
/**
 * Show one connector's server account on its bundle page for as long as the returned disposer has not run. The
 * account's key is `mcp:<server>`.
 * @param registration - the server name, the bundle package, and the connector's text.
 * @returns the registry's idempotent disposer, which withdraws the account.
 * @throws when another account already uses the server or the package.
 */
register(registration: McpAccountRegistration): () => void
```

Source: [`packages/mcp/mcp-account/src/index.ts`](../../packages/mcp/mcp-account/src/index.ts)

<a id="ctxmcpclienthost--mcpclienthost"></a>

### `ctx.mcpClientHost` — `McpClientHost`

Validates, mounts, probes, and authorizes MCP servers for the plugin that manages them.

```ts cordis-catalog
/**
 * Resolve a server configuration and refuse what an instance would refuse when it starts.
 * @param input - server configuration before defaults.
 * @param path - configuration path naming the server; every failure message starts with it.
 * @returns the resolved configuration.
 * @throws when the server name, a field, a template token, the reconnect policy, or OAuth beside an Authorization
 *   header is invalid.
 */
validate(input: ConfigInput, path: readonly string[]): Config

/**
 * Mount one server instance below the host. The instance registers its tools and holds its `serverName` until disposed.
 * @param config - resolved server configuration, usually from {@link McpClientHost.validate}.
 * @returns the instance's activation and disposal.
 */
mount(config: Config): McpServerInstance

/**
 * Probe a server without mounting it: resolve its templates, connect, list its tools, and close.
 * @param config - resolved server configuration; its startup budget does not bound the probe.
 * @param options - whole-probe budget, listing caps, and cancellation signal.
 * @returns the connect and list outcome with the cleanup result.
 * @throws for invalid options, malformed templates, or a missing required credentials provider.
 */
probe(config: Config, options?: McpProbeOptions): Promise<McpProbeResult>

/**
 * Create the explicit OAuth authorization owner of one server.
 * @param config - resolved Streamable HTTP configuration with OAuth.
 * @param changed - called after each change of the owner's attempt view.
 * @returns the owner; its caller retires and disposes it.
 */
authorization(config: StreamableHttpConfig & { oauth: McpOAuthConfig }, changed: () => void): McpOAuthAuthorization
```

Source: [`packages/mcp/mcp-client/src/host.ts`](../../packages/mcp/mcp-client/src/host.ts)

<a id="ctxmcpmanager--mcpservermanager"></a>

### `ctx.mcpManager` — `McpServerManager`

The manager service. Reconciliation and `restart` serialize instance replacement. Probes run independently and are cancelled before replacement or disposal waits for their cleanup.

```ts cordis-catalog
/**
 * Read configured and registered servers and retained runtime records without mounting or probing.
 * @returns configured entries in document order, then registered entries, then retained records for removed entries.
 */
list(): McpManagedServerView[]

/**
 * Contribute one server for the calling plugin's lifetime. A registered
 * entry is enabled while registered; its removal awaits the instance's
 * unmount, so plugin disposal withdraws the server's tools before settling.
 * @param name - server key and tool namespace, unique across configured and registered servers.
 * @param entry - transport, endpoint, and budgets, validated like a configured entry.
 * @returns an idempotent disposer that removes the registration.
 * @throws when the name is taken, the entry is invalid, or the manager is disposed.
 */
register(name: string, entry: McpServerRegistration): () => void

/**
 * Stream server views for a management surface: the current list on
 * subscription, then the complete list again after each status or entry change.
 * @param signal - subscription lifetime; aborting ends only this stream.
 * @returns coalesced server lists until the subscriber or the manager stops.
 */
@Remote({ mode: 'stream' }) async* watch(signal: AbortSignal): AsyncIterable<McpManagedServerView[]>

/**
 * Wait until no listed server is in the first attempt of a connection: `list()` reports none as `connecting` with
 * `attempt: 0`. Every later state counts, including failures, reconnect attempts, and waiting for credentials or
 * authorization. Servers that join while the wait runs are included. Host callers only; this is not a Remote method.
 * @param signal - ends the wait before every server leaves its first attempt.
 * @returns the names still in their first attempt when the signal or manager disposal ended the wait; empty once settled.
 */
async whenSettled(signal: AbortSignal): Promise<string[]>

/**
 * Rebuild one server from its current entry: dispose the live instance (if
 * any) and mount a fresh one with a fresh reconnect budget. Incomplete
 * cleanup blocks replacement until the Host restarts.
 * @param name - the configured or registered server key.
 * @throws when the manager is disposed, no such entry exists, or cleanup is incomplete.
 */
@Remote async restart(name: string): Promise<void>

/**
 * Probe one server for a management surface; see {@link McpServerManager.probe}.
 * @param name - the configured or registered server key.
 * @param signal - caller cancellation.
 * @returns the stage-classified probe outcome and independent cleanup result.
 */
@Remote('probe') probeFromClient(name: string, signal: AbortSignal): Promise<McpProbeResult>

/**
 * Probe one configured server without touching its live instance: resolve
 * the entry's templates, connect, list tools, close. A disabled entry can be
 * probed — that is how a management surface tests it before enabling.
 * Configuration changes and manager disposal cancel the probe.
 * @param name - the configured or registered server key.
 * @param options - probe budget, listing caps, and abort signal.
 * @returns the stage-classified probe outcome and independent cleanup result.
 * @throws when the manager is disposed, the entry is absent or changing, cleanup is
 * incomplete, options are invalid, or a required credentials provider is missing.
 */
async probe(name: string, options?: McpProbeOptions): Promise<McpProbeResult>

/**
 * Start explicit OAuth authorization, retaining the active grant until a successful commit.
 * @param name - configured or registered OAuth entry, including disabled entries.
 * @returns current attempt progress; absent services, changing entries, or failed cleanup reject.
 */
async startAuthorization(name: string): Promise<McpOAuthAttemptView>

/**
 * Cancel the selected attempt and drain its work; an admitted credential commit completes.
 * @param name - managed entry.
 * @param id - selected attempt; stale or absent attempts are ignored.
 */
async cancelAuthorization(name: string, id: McpOAuthAttemptId): Promise<void>

/**
 * Drain authorization, probes, and connections before deleting the local grant; retain client registration.
 * A configuration change before deletion preserves the grant and rejects.
 * @param name - configured or registered OAuth entry; cleanup failure preserves the grant and blocks replacement.
 */
async signOut(name: string): Promise<void>
```

Source: [`packages/mcp/mcp-manager/src/index.ts`](../../packages/mcp/mcp-manager/src/index.ts)

<a id="ctxmcpresources--mcpresourceruntime"></a>

### `ctx.mcpResources` — `McpResourceRuntime`

Scoped resource access plus three tools shared by configured MCP servers.

```ts cordis-catalog
/**
 * Register one server and expose resource tools while that scope has providers.
 * @param server - configured server name, unique in this scope.
 * @param provider - connection-owned resource operations.
 * @returns the effect disposer for this exact registration.
 */
register(server: string, provider: McpResourceProvider): () => void
```

Source: [`packages/mcp/mcp-resources/src/index.ts`](../../packages/mcp/mcp-resources/src/index.ts)

<a id="mcp-manager-events"></a>

### `mcp-manager/*` events

<a id="mcp-managerstatus--parallel"></a>

#### `mcp-manager/status` — parallel

A managed server's connection status or authorization view changed; read `list()` for the current authorization view. Emitted while the manager is live and either the entry is configured or registered, or a runtime record remains. Removed entries may emit cleanup failures; `watch` and `list()` report removals. Lifecycle operations do not wait for listeners. Synchronous throws and returned promise rejections are logged without skipping other listeners.

```ts cordis-catalog
/**
 * A managed server's connection status or authorization view changed;
 * read `list()` for the current authorization view. Emitted while the
 * manager is live and either the entry is configured or registered, or a
 * runtime record remains. Removed entries may emit cleanup
 * failures; `watch` and `list()` report removals.
 * Lifecycle operations do not wait for listeners. Synchronous throws and
 * returned promise rejections are logged without skipping other listeners.
 * @param name - the configured `servers` key or registered name.
 * @param status - the status now current for that server.
 * @mode parallel
 */
'mcp-manager/status'(name: string, status: McpManagedServerStatus): void | Promise<void>
```

Source: [`packages/mcp/mcp-manager/src/types.ts`](../../packages/mcp/mcp-manager/src/types.ts)
<!-- END GENERATED cordis-surface -->
