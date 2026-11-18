# Agent Note: 前端插件配置同步

Status: implemented

[English](2026-11-15-client-config-sync.md) | 中文

## Problem

Host 上的插件配置可以实时更新：Loader 在只有 volatile 字段变化时原地提交引用并发出 `loader/volatile-update`，不重新挂载插件。浏览器侧没有对应链路：

| 现象 | 原因 |
|---|---|
| 前端插件的 `apply(ctx, config)` 总是拿到空配置 | 页面 Loader 创建条目时只传 `name`（[entries.ts](../../../../packages/client/modules/src/client/entries.ts)），cordis.yml 中该行的 `config` 不会到达浏览器 |
| 需要 Host 配置的包各自绕路 | 有的经 `webserver/index-inject` 写页面全局变量，只在页面加载时生效；有的借 `configForms` 设置镜像读取运行时值 |
| 插件图推送通道不合规 | `/plugins/events` 是 `auth: 'anonymous'` 路由；浏览器有 `EventSource` 和 `__DSH_TRANSPORT__.fetch` 两套读取实现，后者断开后不重连；帧序列没有「每代一份完整快照」约束 |

## Decision

### 设计原则

| 原则 | 内容 |
|---|---|
| 一套 Config | 插件只有一份配置类型，放在包的 `src/types.ts` 并由 Host 与 Client 两面共用；schema 只在 Host 面。浏览器不导出 `Config`，也不做配置校验 |
| 只同步 volatile | 浏览器只接收 Host schema 中声明为 volatile 的字段 |
| 剔除密钥 | volatile 字段内的 `role('secret')` 字段（包括 volatile 对象、数组、字典内部）在 Host 上剔除，不下发。该逻辑在 `client/modules` Host 面独立实现，不依赖 `@deepseek-ai/dsh-settings` |
| 插件自身支持热更新 | 同步配置的变化永远不重新挂载前端插件；插件在操作时读取引用，或把引用作为可订阅数据源交给组件 |
| 相等即无事 | 每层都按 deep equal 比较，值相等时不推送、不写入、不通知；重连收到的完整快照与当前值相等时不产生任何刷新 |
| 不同步的内容 | Host 专用普通字段、密钥、按浏览器区分的偏好不进入此链路；主题等在页面 HTML 预注入以避免首屏闪烁的值保持原状 |

### 插件写法

```ts ignore-check
// src/types.ts — shared by both faces; types only
import type { Volatile } from '@deepseek-ai/cordis'

/** Plugin configuration shared by the Host and Client faces. */
export interface Config {
  /** Host-only ordinary field; never synced. */
  cacheDir: string
  /** Synced to the browser. */
  interactiveByDefault: Volatile<boolean>
  /** Synced as one value. */
  office: Volatile<{ maxBytes: number }>
  /** Volatile but `role('secret')`: stripped on the Host; reads as undefined in the browser. */
  apiKey?: Volatile<string>
}
```

```ts ignore-check
// src/index.ts — Host face; the only schema
export const Config: z<Config> = z.object({
  cacheDir: z.string().default('.cache'),
  interactiveByDefault: z.boolean().default(false).volatile(),
  office: z.object({ maxBytes: z.natural().default(8 << 20) }).volatile(),
  apiKey: z.string().role('secret').volatile(),
})
```

```ts ignore-check
// src/client/index.ts — Client face; no Config export
import type { SyncedConfig } from '@deepseek-ai/dsh-client-config/types'
import type { Config } from '../types.ts'

export function apply(ctx: Context, config: SyncedConfig<Config>): void {
  // Every synced field may read undefined; the plugin decides what an absent value means.
  const tooLarge = (bytes: number) => bytes > (config.office.get()?.maxBytes ?? Number.POSITIVE_INFINITY)
  ctx.slots.register({
    name: 'demo.body',
    inject: (): DemoBodyInjected => ({ hooks: { interactiveByDefault: config.interactiveByDefault }, tooLarge }),
  }, DemoBody)
}
```

```tsx ignore-check
// src/client/DemoBody.tsx — the renderer binds the injected source as useInteractiveByDefault
export function DemoBody({ useInteractiveByDefault, tooLarge }: InjectFace<DemoBodyInjected>) {
  const interactive = useInteractiveByDefault(value => value)
  // ...
}
```

只放类型的包 `@deepseek-ai/dsh-client-config/types` 导出的类型；插件依赖它而不依赖启动最早的 Client Modules 包，由 Client Modules 实现：

```ts ignore-check
/** One synced field: Host-aligned `get()`, and directly an observable source for an injected hook. */
export interface SyncedConfigRef<T> extends Volatile<T>, ObservableSnapshot<VolatileSnapshot<T>> {}

/** The Volatile fields of the shared Config type. */
export type SyncedConfig<C> = {
  readonly [K in keyof C as NonNullable<C[K]> extends Volatile<unknown> ? K : never]-?:
    NonNullable<C[K]> extends Volatile<infer V> ? SyncedConfigRef<V | undefined> : never
}
```

`get` 与 `getSnapshot` 返回同一个冻结快照：`get` 与 Host 的 volatile 引用写法一致，`getSnapshot` 与 `subscribe` 满足 `ObservableSnapshot`，引用本身即可放进 `hooks`，renderer 不需要额外适配。接口没有写操作；实现类只在 Client Modules 内部。

组件取值遵循 [client 规则](../../../../packages/client/AGENTS.md)：插件在 slot inject 的 `hooks` 中手动注入 key 级数据源，组件只通过 renderer 绑定的 `use<Name>` 读取，不接触数据源本身。

### 归属

运行时归属仍在 `client/modules`；唯一新增的包是只放类型的 `@deepseek-ai/dsh-client-config`（两个面的 `apply` 都为空）。`client/modules` 本来就跟踪 Loader 条目、组合插件图并在浏览器创建条目，同步配置是条目的输入，由它一并负责：

| 面 | 职责 |
|---|---|
| Host（`clientModules` 服务内部） | 在每个图行插件自身的 `ctx` 上监听 `loader/volatile-update`；插件 fiber 进入 ACTIVE（`internal/status`）或条目对账后重算；从 `fiber.effectiveConfig` 读取 schema 顶层 volatile 字段的值，按 schema 剔除 `role('secret')` 位置，得到该行同步值；与上次值 deep equal 比较，不等才写入图行 `config` 并重新发布图。只变化同步值时不重建 combo 产物 |
| Client（条目控制器内部） | 为图中出现过的每个包保存最新同步值；插件每次激活都得到一个新的配置对象（行暂时没有值时是空对象），与 Host fiber 每次激活重新解析出新引用一致；收到图时按字段 JSON 比较，把变化写入当前激活的对象 |
| Client（`ctx.config` 服务） | 只读：`resolveConfigByPackage<C>(packageName)` 返回某个包当前激活收到的对象，供读取其他插件的配置；插件被替换后对象随之改变，没有运行中的激活时返回 `undefined` |

Client 面的约束：

| 约束 | 内容 |
|---|---|
| 懒生成 | 字段引用在首次访问时创建并缓存 |
| 实例身份 | 每次激活一个对象，与该激活同寿命；代码替换与行重新加入都产生新对象，持有最新值 |
| 不调用 `entry.update` | 同步配置不经过 Loader 的更新路径，不会触发重挂载，浏览器不发 `loader/volatile-update`；变化只经字段引用的 `subscribe` 通知 |
| 原子发布 | 一次图更新先设置所有变化字段，再通知它们的订阅者，与 Host 先提交全部引用再发事件一致 |
| 不校验值 | 值已由 Host 权威 schema 校验；浏览器只在图解析时校验行 `config` 是对象 |
| 交付方式 | 条目控制器在页面 Loader 上以 prepend 方式注册 `internal/config` 监听，为不导出 schema 的托管条目返回同步对象，Loader 插值在其内层运行，不会复制该对象。导出自身 `Config` schema 的前端面保持 Cordis 原有配置解析；这类前端面的行若同时带同步值，激活失败 |

### 时序

Host 的一致性来自两点：schema 与代码同属一个模块，激活时用该 schema 解析原始配置；代码重载与配置重载由 Host 热重载串行执行，只有 ACTIVE 的实例原地接收 volatile 变化。Client 对齐后一点：

| 情形 | Host | Client |
|---|---|---|
| 实例运行中，配置变化 | 原地提交全部引用后通知 | 原地写入当前激活的对象，全部写完后通知 |
| 替换已排队、拆除尚未开始时配置变化 | 实例仍 ACTIVE，原地更新 | 同左 |
| 拆除开始后配置变化 | 非 ACTIVE 实例不再原地更新，新实例解析最新配置 | 拆除开始时释放旧激活，旧对象不再写入；新激活以最新值开始 |
| 行被移除 | 实例被销毁，不再收到配置 | 移除时释放激活；行不在图中期间不写入 |
| Host 侧插件实例非 ACTIVE | 不适用 | 同步值与 Host 插件自身的 effective Config 一样跟随 Host 配置，激活失败时也是如此；尚未激活的实例发布其 schema 从原始配置解析出的值 |

尚未激活的插件实例（新安装、升级、代码热重载）发布用它自己的 schema 从原始配置解析出的值，因此宣布新前端代码的那一帧已带着对应 Host schema 的值。只有开发时不兼容地修改 schema（改名、删字段），才可能在重建的 bundle 到达前，让旧前端代码短暂收到它不认识的值。

### 推送顺序

Host 插件更新配置后再向浏览器推送其他数据时，浏览器应先收到配置。这一顺序只在机制上通过以下几处保证，实际上不保证：各流的源从 Host 事件到把数据项放入 gateway 写出队列所经过的异步步骤数各不相同，即使插件没有自行插入等待，步骤更少的流也可能先被写出。插件不得依赖这一顺序：

| 环节 | 做法 |
|---|---|
| Host 入队 | `clientModules` 在插件 ctx 上以 prepend 注册 `loader/volatile-update` 监听，在插件自己的监听之前同步把新图放入各 follower 队列 |
| pluginEvents 流 | `follow` 在自身生成器内产出增量，不经过额外委托的生成器多走一步 |
| gateway 写出 | 每条连接一个写出队列，各流的项在源产出时立即入队并按入队顺序写出，不再逐项等待上一次写入完成；排队字节超过 `streamOutboxBytes` 时整条连接暂停读取所有源 |
| 浏览器处理 | 每条 WebSocket 消息按到达顺序处理，配置写入在图帧处理时同步完成 |

### 下发

首屏值随 `__DSH_BOOT__` 的图行下发；之后随插件事件流的 `baseline` 与 `graph` 帧下发，不另设配置帧。插件图的线类型由 `@deepseek-ai/dsh-client-modules/types` 导出。只有 owner 收到实际配置的值；其他所有 Peer（例如 LiveShare 查看端）在启动图和每个插件事件帧中收到各插件 schema 对空 Config 解析出的值，因此 Host schema 仍是默认值的唯一来源，owner 实际配置的值留在 Host；schema 拒绝空 Config 的行在这类页面上不带值。Remote access 策略只决定 Peer 能否跟随插件图。

### 推送通道

`/plugins/events` 改为常规鉴权的 Typert Remote 流 `pluginEvents/follow`，浏览器用 `RemoteSnapshotStream` 消费：

| 帧 | 内容 | 浏览器处理 |
|---|---|---|
| `baseline` | 完整插件图（含各行同步配置） | 条目对账 |
| `graph` | 结构或同步配置变化后的完整插件图 | 条目对账 |
| `rebuilt` | `{ id, rev }`，单包代码重建 | 条目代码替换 |

| 项 | 内容 |
|---|---|
| 鉴权 | 走 Remote 网关的常规认证与授权，删除匿名 `/plugins/events` 路由；浏览器面在 Remote access 允许 `pluginEvents/follow` 时开流 |
| 传输 | 删除 `EventSource` 与 `__DSH_TRANSPORT__.fetch` 两套实现；liveshare、webworker 等外壳经 connection 已提供的 Remote 载体接入 |
| 重连 | 由 `RemoteStream` 负责；每代先收 `baseline`，断线期间的遗漏由新快照补齐 |
| 桌面端 | 与 Web 共用同一 Remote 流 |
| 归属 | Remote 服务 `pluginEvents` 由 `client/hmr` Host 面持有，与 bundle stat 轮询同包，不声明 `ctx` 类型合并；`client/modules` 是零依赖的 bootstrap 包，不引入 typert 与 gateway 依赖 |
| 浏览器依赖 | 浏览器面自行 `$mount` 本包生成的 `pluginEvents` 命名空间，不经 `api-remotes` 组装，因此 `api-remotes` 可以独立热替换；必需依赖为 `modules`、`remote`（gateway Client 面，其下为 connection）与 `remoteAccess` |

### 能力边界：可收编的现有用法

本 Note 不迁移现有用法；[迁移 Note](../../proposed/architecture/2026-11-15-client-config-sync-migration.zh.md) 负责盘点与顺序。本机制具备收编以下用法的能力：经 `webserver/index-inject` 下发 Host 配置的页面全局变量、以 `configForms` 读取运行时值的插件、只在前端声明而无法配置的 `Config`。

## Verification

以下行为成立并由测试覆盖：

- 前端插件 `apply` 的 `config` 参数首屏即为 Host 当前 volatile 值；修改 `cordis.patch.yml` 的 volatile 字段后，浏览器中引用值更新、订阅组件重新渲染，前端与 Host 插件 fiber 都不重挂载。
- 投影剔除的 `role('secret')` 位置（与 settings 的剔除范围相同）不出现在首屏注入和任一推送帧中；非 owner 的 Peer 只收到 schema 默认值，收不到实际配置的值。
- Host 专用普通字段不出现在浏览器。
- 值不变的配置重载、Host 重启后的重连 baseline 都不产生 `loader/volatile-update`，也不通知订阅者。
- `/plugins/events` 匿名路由不存在；未认证请求无法获取插件图或配置；断线重连后浏览器状态与 Host 一致。
- 代码热重载后新激活拿到持有当前值的新 `SyncedConfig` 对象，旧激活在拆除开始后不再收到新值。
- Host 上，新图帧在插件自己的 `loader/volatile-update` 监听执行之前进入 pluginEvents 各 follower 队列；不要求线上的先后顺序。
- 测试：`client/modules` 两面单元测试（剔除、比较、懒生成、引用稳定、监听注册与卸载）；真实组合测试经 Loader 启动 profile、修改 patch 并断言浏览器可见值；`client-plugin-live` 与 `client-config-sync` 两个 Web 端到端测试，包括传输重启后的重连。

## Alternatives considered

| Rejected | 理由 |
|---|---|
| 另立一份前端 `ClientConfig` schema | 两份 schema 会漂移；volatile 声明与校验已由 Host schema 承担 |
| 整份配置去掉密钥后下发 | 会把 Host 路径、URL 等普通字段泄漏到浏览器 |
| 前端条目经 `entry.update({ config })` 应用变化 | 前端无 schema，Loader 无法判断 volatile，只会重挂载 |
| 修改 vendored Loader 增加全局 volatile 事件 | 需登记 vendor 本地修改；在条目自身 `ctx` 上监听即可满足 |
| 通道放进 `client/modules` | bootstrap 包会因此依赖 typert 与 gateway |
| 经 `api-remotes` 挂载 `pluginEvents` | `api-remotes` 的替换失败会切断插件更新通道 |
| 为 connection 与 gateway 增加「替换需刷新页面」声明 | 新增 manifest 字段与界面分支；接受替换失败时刷新页面 |
| renderer 提供统一的 `useConfig` 框架 hook | 新增框架级 hook；手动注入 `hooks` 已满足组件取值 |
| 复用 `@deepseek-ai/dsh-settings` 的投影与剔除函数 | settings 架构尚待在本机制之后统一调整，先不建立依赖 |
| 引用只保留 `ObservableSnapshot` | 与 Host volatile 引用的 `get()` 写法不一致 |
| 每个包一个页面级配置对象 | 替换期间正在退出的旧实例仍会收到新配置，与 Host 不一致 |
| 修改 vendored Loader 发出提交事件以保证 Host 入队顺序 | prepend 监听已能满足，不需要 vendor 改动 |
| 另开一条配置专用推送通道 | 与插件图通道重复鉴权、重连与快照语义 |
| 独立 `client/config` 运行时包提供公开写入的配置服务 | 任何插件都能改写别的插件的配置；条目还需按包名等待该服务 |
| 插件从 `@deepseek-ai/dsh-client-modules/types` 导入类型 | 让每个使用配置的插件都依赖启动最早的模块系统包，并暴露实现类 |
| 浏览器也发 `loader/volatile-update` | 字段引用的 `subscribe` 已足够，事件需要深入 Cordis 的过滤机制 |

## Consequences

| 风险 | 说明 |
|---|---|
| 通道依赖 connection | 插件图同步依赖 connection 与 gateway Client 面。热替换它们会连带重启本插件并重开流，由新一代 baseline 对账；若其新代码导入或激活失败，页面在刷新前收不到插件更新（已接受） |
| 在他人 `ctx` 上注册监听 | Host 面在被跟踪条目的 `ctx` 上注册，`clientModules` 卸载时必须撤销全部监听 |
| 自建引用 | Client 面引用是自建的 `Volatile` 结构实现，不使用 cosmokit 内部写入协议，`isVolatile` 不识别它们 |
| 空配置对象 | 没有同步字段的前端插件也收到一个空的只读对象作为 `config` |
| 推送顺序不保证 | 配置先到只在各流从 Host 事件到 gateway 写出队列经过相同异步步骤时成立；其他写法的流，无论是否自行等待，都可能先被写出 |
| 每个字段都可能缺值 | `SyncedConfig` 的每个字段读到 `V \| undefined`：密钥、无法投影的值、尚未与浏览器代码对应的 Host 值都会缺失，插件需在每次读取时处理缺值 |
