# 运行时不变式

[English](invariants.md) | 中文

[dsh-invariants](../../packages/runtime-diagnostics/invariants) 是面向包自有运行时不变式检查的可配置注册表服务（`ctx.invariants`）。它是一个 support 组的包，不是三包能力 seam，也不属于 agent loop（智能体循环）主干：注册表拥有选择逻辑、名称保留、子 fiber 生命周期和归因到包的失败，而每个工作区包发布一个 `./invariant` 配套插件，以自己确切的 npm 包名注册检查。检查可以断言什么（权威事件流或可变数据，绝不是服务或方法是否存在）是 [AGENTS.md](../../AGENTS.md#conventions) 中的运行时不变式约定。

源码：[`packages/runtime-diagnostics/invariants/src/index.ts`](../../packages/runtime-diagnostics/invariants/src/index.ts)

## 选择

```ts type-equiv
/** Runtime invariant selection configured on the service plugin. */
interface Config {
  /** Global switch; defaults to `true`. */
  readonly enabled?: boolean
  /** Case-sensitive JavaScript regex sources that admit package names; empty admits all. */
  readonly package_allowlist?: string[]
  /** Case-sensitive JavaScript regex sources that exclude package names after allowlist matching. */
  readonly package_blocklist?: string[]
}
```

一个包被选中的条件是：服务已启用，允许列表为空或至少一个模式匹配其完整 npm 名称，且没有任何阻止列表模式匹配；阻止列表匹配优先于允许列表匹配。条目用 `new RegExp(source)` 编译：除非模式自带 `^` 和 `$`，匹配不锚定；`/pattern/flags` 语法不被解析。校验在服务启动时明确报错：空白、首尾带空白、重复或无效的条目会抛出异常，而不是被跳过。有效模式可以不匹配任何当前已加载的包，因此后续加载与 HMR（热模块替换）保持确定性；过滤器在服务生命周期内固定不变（[README](../../packages/runtime-diagnostics/invariants/README.zh.md)）。

## 安装器

```ts type-equiv
/**
 * Throw a package-attributed invariant failure.
 * @param message - violated package contract without the standard prefix.
 * @returns never because reporting a violation throws.
 */
type InvariantFailure = (message: string) => never
```

```ts type-equiv
/** Install one package's checks into the registration's child context. */
interface InvariantInstaller {
  /**
   * Install the package contribution.
   * @param ctx - child context owned by this invariant registration.
   * @param fail - reporter bound to the registering package name.
   * @returns nothing, or a promise settling after asynchronous checks finish.
   */
  (ctx: Context, fail: InvariantFailure): void | Promise<void>
  /** Services the child installer fiber may access. */
  readonly inject?: Inject
}
```

被启用的安装器在专属的子 Cordis fiber 中运行；`installer.inject` 声明该 fiber 可以访问的服务，注册成功之前会先等待安装器同步或异步地执行完毕。`fail(message)` 抛出 `InvariantError`（`extends Error`，带稳定的 `code: 'INVARIANT'`、所属 `packageName`，以及前缀为 `invariant violated by "<package>": …` 的消息），因此违规可归因，而注册表无需导入任何产品包。

## 服务

`ctx.invariants.register(packageName, installer)` 为完整 npm 包名保留唯一一个活跃注册，并返回其绑定到 effect 的 disposer。即使过滤器使安装器保持不活跃，保留依然成立，因此两个插件绝不可能静默地认领同一个包名；重复、空白或含空白字符的名称会抛出异常。安装器失败会原子地 dispose（资源释放）子 fiber 并释放保留。服务拥有每个注册 fiber，而返回的 disposer 同时属于配套插件的 fiber：卸载任一侧都会移除监听器、trace 状态和保留项，因此配套插件可以重载并再次注册同一名称，不留残余状态。

## 配套插件约定

每个工作区包都拥有一个 `./invariant` 配套插件（[包约定](../../packages/AGENTS.md)）；发布与注册是穷尽式的，但刻意不合成断言。只有当包拥有某个可观察事件或某种可变数据关系时，配套插件才安装检查；否则它导出一个空安装器，其起始注释以 `No runtime invariant:` 开头，针对该包具体解释为什么没有可检查项。`pnpm run verify-package-invariants` 机械地拒绝「生成文件」标记、无解释的空安装器、遗漏或忽略报告器的非空安装器、错误的注册名称，以及不完整的导出、发布、依赖或打包接线（[机械规则 Agent Note](../../.agents/notes/implemented/architecture/2026-07-19-package-invariant-runtime-contracts.zh.md)）。可执行配套插件的目录与标准组合方式见[包 README](../../packages/runtime-diagnostics/invariants/README.zh.md)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxinvariants--invariantregistry"></a>

### `ctx.invariants` — `InvariantRegistry`

Package-owned invariant registry with global and regex-based selection.

```ts cordis-catalog
/**
 * Register one package's invariant installer. The package name is reserved
 * even when filtering disables its checks. Enabled installers run in a child
 * fiber; failure disposes that fiber and releases the reservation.
 * @param packageName - full npm package name that owns the contribution.
 * @param installer - listener or startup-check installer for the child context.
 * @returns an effect-scoped disposer for the registration.
 */
register(packageName: string, installer: InvariantInstaller): () => void
```

Source: [`packages/runtime-diagnostics/invariants/src/index.ts`](../../packages/runtime-diagnostics/invariants/src/index.ts)
<!-- END GENERATED cordis-surface -->
