# LiveShare

[English](liveshare.md) | 中文

可选的 LiveShare bundle（`@deepseek-ai/dsh-experimental-liveshare`）让一位所有者通过独立的 Liveshare 服务端 把一个会话分享给外部 viewer。viewer 永远拿不到所有者的工具：所有者宿主机自己读取 viewer 的每个请求，以该 viewer 自己的 Peer 分派它，Gateway 依据本包注册的 [remote access](../../packages/api/remote-access/README.zh.md) 策略判定该 Peer 的 `share-viewer` principal，并把共享会话代表 viewer 运行的一切限制在分享所授予的工作区内。[包 README](../../packages/experimental/liveshare/README.zh.md)负责配置、客户端界面与限制；[Owner 说明](../../.agents/notes/implemented/feature/2026-09-13-liveshare-protocol-and-owner-surfaces.zh.md)负责其背后的安全姿态。

源码：[`packages/experimental/liveshare/src/host/fork-enforcement.ts`](../../packages/experimental/liveshare/src/host/fork-enforcement.ts)

<a id="enabling-and-visibility"></a>

## 启用与可见性

本包随 dsh 一同交付，但在 profile 启用它之前不会出现在插件管理器的任何列表中。profile 可以把自己的 `cordis.patch.yml` 插入组合包声明的两条行，这样组合包本身保持未选中而插件照常运行；也可以改在 `dsh.profile.bundles` 中选中该组合包。[包 README](../../packages/experimental/liveshare/README.zh.md#default-visibility-and-enabling)负责具体条目和部署需要替换的占位符。

插件管理器只有在组合包声明的行至少有一条在运行时才把卡片列在**实验性插件**下；删除这些行、把它们置为 disabled，或取消选中组合包，卡片会再次从该列表和**更多**页消失。两条路线都在 profile 下一次重新组合时生效，而不是在当前任务中途：启用 HMR 时会重新读取 profile，未启用时则等下一次启动。

## 分享模式

`ViewerSessionMode` 只有两档，两档都对应一个沙箱：`view` 读取共享会话，并在授予工作区的只读沙箱里驱动它的 loop，绝不写文件；它可以使用读取与检索面（`read`、`read_image`、`glob`、`grep`、`present`）和无本地文件副作用的工具（`todo_write`、`skill`、`web_search`、`web_fetch`），每个声明路径都按授予范围检查。`write` 在受宿主写入上限约束的可写沙箱里运行，通过有界 `edit` 与 `write` 修改该工作区内的文件。fork 不是一档：分享自带独立的 `allowsFork` 开关，与档位无关。附件上传也不是一档：分享向读者提供的每条会话都接受文件，与档位和分叉开关无关。已退场的 `fork-readonly` 名称不会读回为 `view`：持久化的 owner 记录若写有该值，owner 状态加载时会直接拒绝。任何环节都不会推断出 `write`，而宿主机无法确定模式的分享仍可读取，但绝不会被驱动。

## fork 与其上限

fork 创建查看者拥有的新会话，源会话保持不变。Fork 授权检查分享、其 fork 开关、有效期、查看者准入、源身份与请求的边界。`READ_ONLY_FORK_CEILING` 允许读取与检索面——`read`、`read_image`、`glob`、`grep`、`present`、`todo_write`、`skill`、`web_search`、`web_fetch`——，`WRITE_FORK_CEILING` 增加 Host 的有界 `edit` 与 `write`。每个带路径的工具都有受限替代定义：解析它声明的所有路径并按授予根目录检查，再以规范路径委托；`bash`、`pwsh`、`cua`、`plugin_manager`、`schedule_*` 及工具面未列出的名字一律拒绝。

每个分叉会话都会记录授权它的分享、Liveshare 服务端断言的可信 viewer，以及它起始的边界，因此 viewer 的列表只显示它自己的分叉会话，被移除的分享会终止它们。只有在分叉会话自身作用域上安装好上限之后它才会被驱动：`ForkRegistry` 会拒绝每个上限未安装的分叉会话的 prompt（`fork-ceiling-uninstalled`），且安装是按分叉会话逐个验证，而非按宿主机验证。若分叉会话作用域拒绝注册受限替换或上限，就拒绝该分叉会话，而不是让它带着部署自身的工具发布。

冷态源会话与分叉会话通过 Host 常规 Agent lookup 激活，而非 Remote `session/prepare` 端点。串行 `agent/created` 监听器在排队工作放行前安装作用域执行限制；已经在线的 Agent 仍需检查自身安装。`forkLineage` 是 LiveShare 自有的按查看者 UI 投影，不是会话摘要字段、持久日志事件或权限授予。

## 重试、恢复与撤销

同一个逻辑 fork 请求可能被发送多次。其身份绑定可信 viewer、分享、源会话与调用方的操作 id；边界是与该身份比较而非折入其中，因此重试会重复它已经产生的分叉会话，同一身份指向另一个边界会冲突而不是悄悄拿到更早的分叉会话，且预留在任何分叉会话存在之前就已持久化。宿主机记录 owner 的 fork 应答返回的分叉会话，重试已记录的操作会重放该应答。owner 的 `SessionForkRequest` 自己生成分叉会话 id，因此在创建分叉会话与记录它之间崩溃的宿主机重试时无法指名该分叉会话，会再创建一个；要关闭这一窗口，需要 Session Controller 的请求接受调用方提供的分叉会话身份。

分叉会话工具守卫重新检查分享当前模式、有效期、查看者准入与撤销记录。撤回查看者会取消受影响的分叉会话工作与未决调用。`write` 降级为 `view` 后，写入守卫拒绝后续写入，不授予任何新工具，也不承诺立即取消正在运行的轮次。移除分享撤销已记录分叉会话并停止该会话正在运行的轮次；源执行层在该会话不再有任何分享时释放，并随 Agent 释放。已撤销分叉会话保留日志，源会话所有者可见历史绝不改写。

## 约束共享会话

每个分享都让它的 viewer 通过正常 prompt 路径驱动*源*会话，任一档位的分享在活跃期间都会安装有界沙箱。`installSourceSessionAccess` 在该会话自身作用域中为部署提供的每个读取与检索面工具注册受限替代，并在任一同会话分享允许写入时再注册有界 `edit` 与 `write` 替代。执行层挂在会话上，但只约束分享查看者发起的轮次：`agent/pre-step` 在 Host 内存中记录一个轮次的已准入输入是否带有 share-viewer principal，守卫与替代定义对该轮次的每次执行读取这一结论。查看者发起的轮次只能运行这些替代定义；所有者自己发起的轮次保留会话原生工具，包括 `bash` 与不受限的文件工具。该结论在轮次准入时确定，不写入会话日志；重启后从下一个准入步骤重新计算。所有者在查看者轮次中追加的输入仍留在该受限轮次内。该会话的所有分享停止后执行层被释放，会话恢复自己的工具；最后一个可写分享降为 `view` 时重装只读层。

安装结果报告源会话是否真正受到限制。没有 `read` 工具的部署或拒绝该替代注册的作用域会保留守卫并报告失败；某个工具自己的替代注册失败时，该工具保持拒绝，其余工具面照常运行。读取处理器以 `source-write-unavailable` 拒绝消息：限制未安装时，共享会话中查看者发起的轮次不会用所有者工具驱动。

每次操作都会重新读取维持该会话可驱动的分享的 Relay 授权，且读取与其授权的工具调用在同一同步步骤内完成，因此排队超过其准入授权的输入无法凭过期准入行动。执行层按会话安装：同一会话的多个分享共用一个安装；分享收窄或结束时改变该层允许的操作——没有任何活跃分享可写时拒绝有界写入，会话不再有分享时释放执行层。Host 不把正在运行的轮次归属给准入它的查看者，因此结束某个分享的授权会停止该会话正在运行的轮次，而不是只挑出该查看者的工作；内存中的查看者轮次标记只决定该轮次运行哪套工具面。

受限文件工具解析其自身参数声明的每个路径，检查获授根目录包含每个目标，再以目标的规范路径委托。无路径的 `glob` 或 `grep` 搜索会话的工作目录，由替代定义补齐并按命名路径一样检查；`present` 调用检查它列出的每个文件；无本地文件副作用的工具原样委托。有界编辑执行同样的包含检查，使用 `fs/edit-intent`，并发布 `editText` 返回的版本；有界写入使用 `fs/write-intent`，并发布 `writeText` 返回的版本。异步意图等待后，Host 解析当前会话沙箱策略并重新检查分享授权。该策略作为 `editText` 或 `writeText` 的第五个参数，位于 `signal` 之后，由沙箱后端据此限制变更。包含关系按路径检查，若本地进程在检查与打开之间把获授范围内的目录换成符号链接，操作可能被改指别处；基于目录句柄锚定操作留待单独变更引入。

查看者对源会话的提示词与停止都按标准 Gateway 分派走 `share-viewer` 策略的源会话写入角色：分享档位已确立且其会话受沙箱限制时策略放行，随后由所有者自己的会话控制器停止该会话当前运行的轮次。取消不按查看者比对，因此读者对共享会话的停止也会结束所有者发起的轮次。[Session Controller](../../packages/api/session-controller/README.zh.md) 在 `prompt` 投递前、以及与 `cancel` 同一同步步骤内再次读取 `remoteAccess.allows()`，因此 Gateway 放行调用之后访问权才结束的查看者不会投递或取消任何内容。排队的外部源输入在 `agent/pre-step` 刷新 Liveshare 服务端授权；缺少授权时在模型请求之前拒绝步骤。

<a id="viewer-states"></a>

## viewer 状态

一次以拒绝结束的 viewer 读取会指明它自己的状态，而不是让所有原因共用一种失败：链接不存在、owner 已停止分享、分享已过期、owner 的机器没有路由、登录已过期、读者尚未申请、申请仍在等待、申请被 owner 拒绝、owner 从未收到通知，每种都有各自的 HTTP 状态与错误码；页面联系不上 Liveshare 服务端时由页面自己陈述。`@deepseek-ai/dsh-experimental-liveshare-protocol` 中的 `VIEWER_STATE_ANSWERS` 就是这份词汇表，每种状态对应的答案由 [共享协议](../../packages/experimental/liveshare-protocol/README.zh.md) 维护。没有任何一种答案会扩大 viewer 能读到的内容：owner 离线、分享已停止、申请被拒，三者都是拒绝。

viewer 页面渲染所用的工作区流与会话列表经同一策略过滤：只要工作区还持有共享会话或该 viewer 自己创建的分支就会下发，其成员与手工顺序只保留这些。失去它们的工作区要到该工作区或工作区顺序下次变化时才离开工作区流，届时流替换读者的基线；仅访问变化不会发送帧。因此读者看到的是围绕它被授予的那一个会话的 owner 工作区名称与分组，而不是 owner 其余的工作区。

查看流在轮询、替换与取消时均绑定打开它的主体。会话通知、控制基线与工作区成员只暴露源会话及该主体的分叉会话：Gateway 只向读者转发策略在这些会话上允许的 `api-session/*` 通知，Session 与 Workspace 控制器也经同一策略过滤其列表和流；交互审批与提问保留在 Host。被拒绝的读取不创建上游订阅。过期与撤权取消受影响的未决调用和流；120 秒未轮询的流被回收。Worker IPC 响应与取消必须匹配请求 token、分享 ID、Liveshare 服务端 ID 及原始 socket 或 worker generation；迟到响应不能结算替换请求。

Liveshare 服务端可选的 `share-access-state` 能力在连接和已提交变更时发布完整、带版本的授权快照，包括其他 Liveshare 服务端实例提交的变更。鉴权 `GET /__liveshare/requests` 返回同一组字段。Host 在连接丢失时清空缓存授权，在同一 generation 内拒绝过期修订，并对异步刷新检查 generation。缺少完整授权时拒绝准入；这不构成立即的分布式停止语义保证。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxliveshareshares--liveshareshares"></a>

### `ctx.liveshareShares` — `LiveshareShares`

Owner-only Remote surface over the share-management operations.

The Gateway decides each call through remote access, so a `share-viewer` Peer is refused before a method runs; the owner Peer reaches the one implementation that owns each share-management side effect. `create` takes its Session as the `sessionId` of its single request object, so the Session resource kind's default resolver names that Session for the call without a reader declared here.

```ts cordis-catalog
/**
 * Publish one Session and store the share.
 * @param request - Session, title, access, lifetime, and both switches the owner chose.
 * @returns The created share's link and stored values.
 */
@Remote('create') create(request: CreateShareRequest): Promise<CreatedShare>

/**
 * Refresh titles and Liveshare server authority, then list this host's shares.
 * @returns Every share this host publishes.
 */
@Remote('list') list(): Promise<OwnerShareList>

/**
 * Stop one share locally, revoke its forks, and delete its row on the Liveshare server when reachable.
 * @param request - Share to stop.
 * @returns Whether the row on the Liveshare server still needs a retry.
 */
@Remote('stop') stop(request: StopShareRequest): Promise<StopShareResult>

/**
 * Change one share's tier, fork switch, or both.
 * @param request - Share and the switches to change.
 * @returns The permissions the share now carries.
 */
@Remote('updatePermissions') updatePermissions(request: UpdateSharePermissionsRequest): Promise<SharePermissions>

/**
 * Replace one share's exposed plugin endpoints.
 * @param request - Share and the selection to store.
 * @returns The capability selection the share now carries.
 */
@Remote('setCapabilities') setCapabilities(request: SetShareCapabilitiesRequest): Promise<ShareCapabilities>

/**
 * Read the endpoints plugins currently offer.
 * @returns The live offer list.
 */
@Remote('capabilities') capabilities(): ShareCapabilityOffers

/**
 * Read the Liveshare server address the owner saved.
 * @returns The current Liveshare server state, with both address fields absent while none is saved.
 */
@Remote('relay') relay(): OwnerRelayState

/**
 * Choose the Liveshare server address later shares publish to.
 * @param request - Normalized address or null to clear the saved one.
 * @returns The Liveshare server state after the change.
 */
@Remote('setRelay') setRelay(request: SetRelayRequest): Promise<OwnerRelayState>

/**
 * Report this host's owner identity for one Liveshare server address.
 * @param request - Address to report, or the effective one when absent.
 * @returns The owner identity status, without the credential.
 */
@Remote('identity') identity(request: OwnerIdentityRequest): Promise<OwnerIdentityStatus>

/**
 * Read the Liveshare server's durable audit trail for one share.
 * @param request - Share whose audit is read.
 * @returns The audit events, or a structured failure when the Liveshare server cannot answer.
 */
@Remote('audit') audit(request: ShareAuditRequest): Promise<ShareAudit>

/**
 * Check that the effective Liveshare server answers at all.
 * @returns The anonymous connectivity result.
 */
@Remote('testRelay') testRelay(): Promise<RelayConnectivityView>

/**
 * Register one throwaway share to check whether this host may publish.
 * @param request - Session the throwaway registration names.
 * @returns The Liveshare server's decision about this host's credential.
 */
@Remote('testPublish') testPublish(request: TestPublishRequest): Promise<RelayPublishView>
```

Source: [`packages/experimental/liveshare/src/host/share-remote.ts`](../../packages/experimental/liveshare/src/host/share-remote.ts)
<!-- END GENERATED cordis-surface -->
