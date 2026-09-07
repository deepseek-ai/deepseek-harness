# spill 存储

[English](spill.md) | 中文

spill 存储[能力 seam](../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.zh.md)持久保存调用方提供的文本，并返回面向模型的定位符与检索指引。其 Service Definition 是 [dsh-spill](../../packages/spill/spill)（`ctx.spillStore`），本地 Service Provider 是 [dsh-spill-local](../../packages/spill/spill-local)。消费方包括[工具结果策略](../../packages/spill/spill-policy)与[会话引用](../../packages/context/session-reference/README.zh.md)。spill 是可选能力，不属于[智能体循环主干](core.zh.md)；预览与 spill 决策由消费方负责，存储则原样保存所提供的文本。

源码：[`packages/spill/spill/src/types.ts`](../../packages/spill/spill/src/types.ts)

## 保存请求

`saveText` 是唯一的服务操作：原样持久保存 `content`，并返回不透明的定位符、后端提供的检索提示和精确字节数。请求携带保存时的存储命名空间（`owner`）、描述性的生产者来源信息（`source`，绝非访问控制）以及后端可用作命名提示而非路径的 `suggestedName`。工具来源标识实际工具调用；会话引用来源标识被捕获的源会话，而其归属是接收上下文的目标会话。

```ts type-equiv
/** One request to persist text to a spill artifact. */
interface SaveTextSpill {
  owner: SpillOwner
  source: SpillSource
  /**
   * A caller-suggested base name (e.g. `web_fetch.txt`). The backend sanitizes
   * it to a single safe path segment before use — it is a hint, never a path.
   */
  suggestedName: string
  /** The full text to persist (UTF-8). */
  content: string
}
```

```ts type-equiv
/**
 * Save-time storage namespace for a spilled artifact. The session id lets a
 * backend group storage under the producing session, but the returned
 * {@link SpillLocator} is the model-facing handle. Forked sessions inherit
 * locators already present in the seeded log; those artifacts are not copied or
 * re-owned, and spills produced after the fork use the child session id.
 */
interface SpillOwner {
  sessionId: SessionId
}
```

保留期清理可以连同其他旧会话产物一起使旧定位符失效；spill seam 不定义逐会话的清理策略。

```ts type-equiv
/**
 * Producer of a spilled artifact. Tool results carry their model-issued call id;
 * session references identify the captured source session instead. Descriptive
 * provenance only, never access control.
 */
type SpillSource = {
  kind: 'tool'
  /** The tool whose result was spilled (e.g. `web_fetch`). */
  toolName: string
  /** The model-issued call id the result belongs to. */
  callId: ToolCallId
  /** A short human label for the artifact (e.g. `result`). */
  label: string
} | {
  kind: 'session-reference'
  /** Session whose projected conversation was captured. */
  sessionId: SessionId
  /** Host-provided label for the referenced session. */
  label: string
}
```

## 结果

```ts type-equiv
/** A saved spill artifact: its locator, byte length, and backend-specific retrieval guidance. */
interface SpillRef {
  locator: SpillLocator
  bytes: number
  retrievalHint: string
}
```

`SpillLocator` 是后端返回的[品牌化](core.zh.md#branded-ids)面向模型句柄。本地后端将它渲染为文件系统路径；远程或数据库后端可以渲染 URI、键或命令 token。消费方将它视为不透明值，并使用 `retrievalHint` 渲染，而不是假定 `read` 始终是正确的检索机制。

```ts type-equiv
/**
 * Opaque model-facing handle for one spilled artifact. A local backend may use a
 * filesystem path; a remote or database backend may use a URI or key. Consumers
 * render it with {@link SpillRef.retrievalHint}, but do not parse it.
 */
type SpillLocator = Branded<'SpillLocator'>
```

## 服务

`SpillStore`（`ctx.spillStore`，定义于 [`packages/spill/spill/src/index.ts`](../../packages/spill/spill/src/index.ts)）是只有一个方法的抽象服务：`saveText(input) → Promise<SpillRef>`。它持久保存完整的 `content`，并在实际存储失败（权限、ENOSPC、后端不可用）时拒绝。该 seam 只负责存储：不负责保留策略、工具结果替换或检索／搜索 API。

本地后端（[dsh-spill-local](../../packages/spill/spill-local)）写入 `<root>/session-<hash>/<random>-<safeName>`：根目录是已配置或延迟创建的私有（0700）目录，会话子目录采用 `sha256(sessionId)`，并通过排他且仅所有者可访问的写入（`open(path, 'wx', 0o600)`）防止预先植入的符号链接重定向写入。其 `locator` 是本地路径，`retrievalHint` 则告知模型在该路径上使用 `read` 或 `grep`。策略消费方（[dsh-spill-policy](../../packages/spill/spill-policy)）会把超过 `maxInlineBytes` 的纯文本最终结果替换为保留库生成的首尾预览和 spill 引用；该过程尽力而为：保存失败时保留原始内联结果，而不会把成功的调用变成 `isError`。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxspillstore--spillstore-abstract-seam"></a>

### `ctx.spillStore` — `SpillStore` (abstract seam)

Abstract spill storage service. Subclass, implement saveText, and load the subclass as a plugin — it registers as `ctx.spillStore` (one implementation per context; loading a second throws, cordis' standard duplicate-service behavior).

Semantics every implementation must honor:

- saveText persists the FULL `content` verbatim and returns an opaque locator, exact byte length, and model-facing retrieval guidance.
- Storage is scoped by the request's SaveTextSpill.owner session; the backend chooses a private (not world-readable) location and a collision-free name derived from — never equal to — the caller's `suggestedName`.
- `saveText` REJECTS on a real storage failure (permissions, ENOSPC, backend unavailable); the caller decides how to degrade (the spill policy treats a rejection as best-effort and keeps the inline result).

```ts cordis-catalog
/**
 * Persist `input.content` to a session-scoped spill artifact.
 * @param input - the owner, caller-supplied source fields, suggested name, and full text to save.
 * @returns the saved artifact's {@link SpillRef}; rejects on a storage failure.
 */
abstract saveText(input: SaveTextSpill): Promise<SpillRef>
```

Source: [`packages/spill/spill/src/index.ts`](../../packages/spill/spill/src/index.ts)
<!-- END GENERATED cordis-surface -->
