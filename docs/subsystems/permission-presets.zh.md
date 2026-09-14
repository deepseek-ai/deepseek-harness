# 权限预设

[English](permission-presets.md) | 中文

[dsh-permission-presets](../../packages/interaction/permission-presets) 的权限预设层（`ctx.permissionPresets`，`PermissionPresetService`）把两个相互独立的强制执行 knob，即[沙箱模式](sandbox.zh.md)（`sandbox/mode`）与[审批策略](approval.zh.md)（`approval/policy`），捆绑成具名预设，供客户端作为单个 Permissions 选择器提供。配置表拥有未来会话默认值，而固定的 `registerAuto(admit)` 钩子让 [Auto review](../../packages/experimental/auto-review/README.zh.md) integration 在一个 effect 生命周期内发布仅限当前会话的选项。该层是可选能力，且不拥有执行策略：提示词叙述与回放仍读取各自 knob 的折叠结果，额外强制执行由 Auto review 拥有。[包 README](../../packages/interaction/permission-presets/README.zh.md)负责组合状态与限制；[沙箱切换设计](../../.agents/notes/implemented/feature/2026-07-06-sandbox.zh.md)负责原始旋钮依据。

源码：[`packages/interaction/permission-presets/src/index.ts`](../../packages/interaction/permission-presets/src/index.ts)

## 预设表

预设把一个稳定 key 映射到一组沙箱／审批组合，外加可选的客户端展示信息。默认配置表自带 `workspace-write`（`workspace-write` + `ask`）和 `danger-full-access`（`danger-full-access` + `never`）；`custom` 与 `auto` 是保留名称，不能配置。

```ts type-equiv
/** One preset's sandbox/approval bundle and optional client presentation. */
interface PresetSpec {
  /** The `sandbox/mode` value the preset writes through. */
  sandbox: SandboxMode
  /** The `approval/policy` value the preset writes through. */
  approval: ApprovalPolicy
  /** The display label a client shows for this preset; the raw table key when omitted. */
  name?: string
  /** One user-facing sentence on what the preset means; omitted when not configured. */
  description?: string
}
```

```ts type-equiv
/** The {@link PermissionPresetService} config: preset table and composition default. */
interface Config {
  /**
   * The preset table: name → knob bundle. Defaults to `workspace-write`
   * (workspace-write + ask) and `danger-full-access` (danger-full-access +
   * never). The names `custom` and `auto` are reserved for derived state and
   * the Auto review integration respectively.
   */
  presets?: Record<string, PresetSpec>
  /**
   * Default for new sessions. When omitted, the preset matching the composed
   * sandbox and approval defaults is used.
   */
  defaultPreset?: string
}
```

该服务要求一个施加隔离的 `ctx.shell` 执行器和 `ctx.approval`，配置错误在插件加载时即失败：名为 `custom` 或 `auto` 的配置条目会抛出异常；在不施加隔离的 bash 执行器（没有 `sandboxMode` 能力事实）之上组合同样抛出异常，因为预设捆绑了一个沙箱模式。

## 固定的当前会话 Auto 注册

Auto integration 会在自身 effect 生命周期内调用 `registerAuto(admit)`。本服务固定 `auto` 身份以及 `danger-full-access` 加 `never` 的组合；shipped 客户端的 locale 字典拥有 Auto 的 label 与 description，而配置预设的展示信息仍归 Host 所有。调用方不能通过通用 contribution API 发布其他预设。Auto 排列在配置预设之后，绝不会进入 `permission.defaultPreset` 设置 schema，并在 effect dispose 时消失。同步 `admit` 回调会在 Auto 选择修改 Session 前，以及存储的 Auto Session 发布前运行，因此 integration 缺失或正在关闭时不会改写持久身份。

注册或移除 Auto 会发出无 payload 的 `permission-presets/catalog-changed` 通知。进程级消费方先订阅，再调用 `catalog()`；每次收到通知后重新读取完整的可选目录。`permissions` Session 投影只包含 `currentValue`，因此目录变化不会追加 Session 事件、发布 Session 投影帧或改变 Session 序列。

## 当前预设与派生的 `custom`

`current(session)` 从必需的 `permissions` 投影派生实际生效的预设。该单元折叠会话的沙箱模式、审批策略和已记录选择；状态内部的缺失值回退到执行器配置的模式与审批服务配置，最后回退到 `ask`。投影 key 缺失时会显式失败。服务优先取仍然匹配的选择，其次取第一个匹配的配置条目，否则返回 `CUSTOM_PRESET`（`'custom'`）。`custom` 只是派生值：客户端可以把它显示为当前值，但它绝不是切换目标，也绝不出现在事件 payload 中。

`names` 先按声明顺序列出配置预设，再在 Auto integration 存活时列出 Auto。`catalog()` 把这些可选条目作为一份进程级快照返回。`optionOf(name)` 为可用条目（label 回退为该 key）或派生的 `custom` 展示构建选项，传入其他任何名称都会抛出异常。客户端把目录与 Session 投影合并；`custom` 可以标记当前值，但绝不会成为目录条目。

```ts type-equiv
/** Presentation for an available preset or the derived `custom` current value. */
interface PresetOption {
  /** Stable option value: a configured preset key, live `auto`, or derived `custom`. */
  value: string
  /** The display label. */
  name: string
  /** One user-facing sentence on what the value means; omitted when not configured. */
  description?: string
}
```

## 切换与 `permission/preset` 事件

`set(session, name)` 解析预设（未知名称抛出异常），在适用时运行 Auto 准入，在 `name` 尚不是生效预设时追加一条仅记日志的 `permission/preset` 事件，然后通过各旋钮自己的 setter（[dsh-sandbox-policy](../../packages/sandbox/sandbox-policy) 的 `setSandboxMode` 与 [dsh-user-approval](../../packages/interaction/user-approval) 的 `setApprovalPolicy`）写入，且仅当该 knob 的生效值发生变化时才写。同一轮次内，选择事件先于旋钮事件出现；重新选择当前生效的预设则什么都不追加。

`permission/preset` 是持久、仅记日志的用户意图：它不进入模型 transcript（文本记录），模型可见的后果由 knob 事件经各自消费方承担；它存在是为了在两个预设共享同一个旋钮组合时，让 `current()` 仍能保住用户选择的究竟是哪一个预设。`permissions` 投影把该选择与两个 knob 事件一同折叠，并保留用于区分空恢复 seed 与新会话的 `session/end-seed` 边界；回放不需要任何追赶状态或原始日志重扫。恢复的 `auto` 选择在 agent 发布前必须存在 live Auto 注册。完整事件声明见[持久化日志事件目录](../persistence-catalog.zh.md)；方法签名见生成的[服务目录](#ctxpermissionpresets--permissionpresetservice)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxpermissionpresets--permissionpresetservice"></a>

### `ctx.permissionPresets` — `PermissionPresetService`

Owns the deployment's configured permission presets, the fixed Auto integration hook, and their write path. Requires a confining `ctx.shell` executor and `ctx.approval`; unmatched knob values are reported as CUSTOM_PRESET, not an error.

```ts cordis-catalog
/**
 * Read the complete process-level catalog exposed to current-session UI.
 * @returns every currently selectable preset in contribution order.
 */
@Remote('catalog') catalog(): PermissionCatalog

/**
 * Publish the fixed current-session Auto preset for the calling
 * integration's effect lifetime.
 * @param admit - synchronous gate run before live Auto selection or restore.
 * @returns the async effect disposer that removes Auto.
 */
registerAuto(admit: () => void): () => Promise<void>

/**
 * Resolve the preset matching the effective knob values. A still-matching
 * last selection wins shared-bundle ties; otherwise the first configured
 * match wins. Returns
 * {@link CUSTOM_PRESET} when no available preset matches.
 * @param session - the session whose knob state is read.
 * @returns the effective preset name, or `custom` when nothing matches.
 */
current(session: Session): string

/**
 * Resolve an available preset's knob bundle.
 * @param name - the preset name to resolve.
 * @returns the configured bundle.
 * @throws when `name` is neither configured nor the currently live Auto preset.
 */
resolve(name: string): PresetSpec

/**
 * Build the client option for an available preset or {@link CUSTOM_PRESET}.
 * A missing label falls back to the preset key.
 * @param name - a configured preset key, live `auto`, or `custom`.
 * @returns the option a client renders.
 * @throws when `name` is neither a configured preset, live `auto`, nor `custom`.
 */
optionOf(name: string): PresetOption

/**
 * Record a changed preset, then update each changed knob through its own
 * setter. Selecting the effective preset again appends nothing.
 * @param session - the session the switch belongs to.
 * @param name - the preset to switch to; unknown names throw.
 */
set(session: Session, name: string): void
```

Types: [Session](session.zh.md)

Source: [`packages/interaction/permission-presets/src/index.ts`](../../packages/interaction/permission-presets/src/index.ts)

<a id="permission-presets-events"></a>

### `permission-presets/*` events

<a id="permission-presetscatalog-changed--emit"></a>

#### `permission-presets/catalog-changed` — emit

The selectable process catalog changed. Payload-free by design: consumers subscribe first, then re-read the complete catalog.

```ts cordis-catalog
/**
 * The selectable process catalog changed. Payload-free by design:
 * consumers subscribe first, then re-read the complete catalog.
 * @mode emit
 */
'permission-presets/catalog-changed'(): void
```

Source: [`packages/interaction/permission-presets/src/types.ts`](../../packages/interaction/permission-presets/src/types.ts)
<!-- END GENERATED cordis-surface -->
