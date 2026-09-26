/** Runtime plugin trees shared by Agents selecting one preset revision. */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { EntryTree, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { prepareProfileEntries } from '@deepseek-ai/dsh-app-boot'
import type { PresetDefinition } from './definition.ts'
import { scopeOf, scopeParentOf, type ScopeKey } from '@deepseek-ai/dsh-scope'

/** In-memory Loader tree; only the profile configuration editor persists definitions. */
class PresetTree extends EntryTree {
  constructor(ctx: Context) {
    const owner = ctx.fiber.entry
    const subtree = owner?.subtree
    const subgroup = owner?.subgroup
    super(ctx)
    if (owner !== undefined) {
      if (subtree === undefined) delete owner.subtree
      else owner.subtree = subtree
      if (subgroup === undefined) delete owner.subgroup
      else owner.subgroup = subgroup
    }
  }

  override write(): void {}
}

/** One live revision shared by Agents and scoped readers. */
export interface PresetMount {
  /** The preset the subtree was composed from. */
  readonly presetId: string
  /** The mounted subtree's fiber. */
  readonly fiber: Fiber
  /** Loader entry tree whose active rows form this standing composition. */
  readonly tree: EntryTree
  /** The standing scope key agents are parented to (undefined only in torn-down records). */
  readonly key: ScopeKey | undefined
}

const mounts = new Set<PresetMount>()

/**
 * Every preset composition retained by the registry.
 *
 * The record set is module state and therefore spans every Cordis runtime in
 * the process; a reader that serves one runtime passes that runtime's root
 * fiber so another runtime mounting the same preset id (a second embedded
 * app, a test's second harness) never answers for it.
 * @param within - when present, only mounts inside this fiber's subtree.
 * @returns the live mounts.
 */
export function livePresetMounts(within?: Fiber): PresetMount[] {
  const all = [...mounts]
  return within === undefined ? all : all.filter(mount => withinFiber(mount.fiber, within))
}

/**
 * Whether `fiber` is `root` itself or is mounted anywhere inside its subtree.
 *
 * Membership is object identity. `uid` looks like a cheaper key but is a
 * per-registry counter, so fibers in two different roots collide on it and a
 * subtree in one runtime would be blamed for a service published in another.
 * @param fiber - the fiber to locate.
 * @param root - the subtree root to test membership against.
 * @returns true when `fiber` belongs to `root`'s subtree.
 */
function withinFiber(fiber: Fiber, root: Fiber): boolean {
  let current = fiber
  while (true) {
    if (current === root) return true
    const parent = current.parent.fiber
    if (parent === current) return false
    current = parent
  }
}

/**
 * Service names the mounted subtree published into the root realm.
 *
 * A provider without an `isolate` realm stores its implementation under the
 * root's symbol for that name, which is exactly the comparison below; a
 * provider inside an `isolate` realm stores under a realm-private symbol and
 * is correctly absent here.
 * @param ctx - any context of the runtime whose service store is inspected.
 * @param mount - the mounted subtree's fiber.
 * @returns the leaked service names in lexical order.
 */
export function leakedServices(ctx: Context, mount: Fiber): string[] {
  const store = ctx.reflect.store
  const rootIsolate = ctx.root[Context.isolate]
  const leaked: string[] = []
  for (const key of Object.getOwnPropertySymbols(store)) {
    const impl = store[key]
    /* v8 ignore next -- cordis deletes a store slot on disposal rather than
       clearing it, so an own symbol always resolves; the guard exists only
       because the store's index signature is optional. */
    if (impl === undefined) continue
    if (!withinFiber(impl.fiber, mount)) continue
    if (rootIsolate[impl.name] === key) leaked.push(impl.name)
  }
  return leaked.sort((left, right) => left.localeCompare(right))
}

/** A live standing mount located through one agent already joined to it. */
export type JoinedPresetMount = PresetMount & {
  /** The standing key, definite because it is what the lookup matched on. */
  readonly key: ScopeKey
}

/**
 * The standing composition one agent is joined to.
 *
 * The agent's own key is parented to its preset's standing key, so the mount
 * is found by matching that parent rather than by walking up from the agent —
 * the mount is not under the agent's fiber. An agent that joined no preset —
 * a deployment composing no roster, or a child agent before its join — has no
 * parent link and resolves to undefined.
 * @param agentCtx - the agent's scope context.
 * @returns the mount the agent joined, or undefined when it joined none.
 */
export function standingMountFor(agentCtx: Context): JoinedPresetMount | undefined {
  const agentKey = scopeOf(agentCtx)
  if (agentKey === undefined) return undefined
  const standingKey = scopeParentOf(agentKey)
  if (standingKey === undefined) return undefined
  return livePresetMounts().find(
    (candidate): candidate is JoinedPresetMount => candidate.key === standingKey,
  )
}

/**
 * One agent's instance of a service its preset mounted.
 *
 * Preset revisions publish services behind an `isolate` realm. Browser RPCs
 * hold the Agent but resolve outside that realm, so they locate its revision
 * through the Agent's scope parent.
 *
 * Ownership is the same relation {@link leakedServices} reads, inverted: there
 * it names implementations a subtree published into the ROOT realm, here it
 * names the one this subtree published anywhere. Fiber membership is object
 * identity for the reason stated on {@link withinFiber}.
 *
 * This is read addressing for a caller that already holds the agent. It is not
 * a general host handle on a session's internals: a host row that `inject`s a
 * service cannot use it, because injection resolves before any session exists
 * and has no agent to key by — such a service belongs on the host plane.
 * @param ctx - any context of the runtime whose service store is inspected.
 * @param agent - the agent whose mounted composition to look inside.
 * @param name - the service name as the preset's rows resolve it.
 * @returns the agent's instance, or undefined when its preset mounts none.
 */
export function serviceForAgent<K extends string & keyof Context>(
  ctx: Context,
  agent: { ctx: Context },
  name: K,
): Context[K] | undefined {
  const mount = standingMountFor(agent.ctx)
  if (mount === undefined) return undefined
  const store = ctx.reflect.store
  for (const key of Object.getOwnPropertySymbols(store)) {
    const impl = store[key]
    /* v8 ignore next -- cordis deletes a store slot on disposal rather than clearing it */
    if (impl === undefined) continue
    if (impl.name !== name) continue
    if (withinFiber(impl.fiber, mount.fiber)) return impl.value as Context[K]
  }
  return undefined
}

/** Rows that did not reach a usable state, each rendered as one diagnostic line. */
export interface RowAudit {
  /** Rows that never started or whose import or activation rejected. */
  readonly failed: string[]
  /**
   * Rows waiting for a service the composition does not supply. A Host
   * provider still activating completes such a row later; only a settled Host
   * tree tells that case from a genuinely missing service.
   */
  readonly pending: string[]
}

/**
 * Audit the rows of a mounted subtree.
 *
 * Wait for the subtree, then report import failures, activation failures, and
 * rows waiting for services the composition does not supply.
 * @param tree - the mounted subtree.
 * @returns failed and pending rows, both empty when every enabled row is usable.
 */
export async function auditRows(tree: EntryTree): Promise<RowAudit> {
  await tree.await()
  const failed: string[] = []
  const pending: string[] = []
  for (const entry of tree.entries()) {
    if (entry.disabled) continue
    const fiber = entry.fiber
    if (fiber === undefined) {
      failed.push(`${entry.options.id} (${entry.options.name}): never started`)
      continue
    }
    try {
      await fiber.await()
    } catch (error) {
      const detail = mountDetail(error)
      failed.push(`${entry.options.id} (${entry.options.name}): ${detail}`)
      continue
    }
    const missing = Object.keys(fiber.inject).filter(name => fiber.ctx.get(name) === undefined)
    if (missing.length > 0) {
      pending.push(`${entry.options.id} (${entry.options.name}): waiting for ${missing.join(', ')}`)
    }
  }
  return { failed, pending }
}

/**
 * The causes of `error` whose detail its own message does not already carry.
 *
 * Aggregate errors carry separate member messages. A wrapper can preserve the
 * aggregate as its cause without including those messages in its own text.
 * @param error - the failure to read branches from.
 * @returns the branches to render beneath `error.message`, possibly empty.
 */
function detailBranches(error: Error): readonly unknown[] {
  if (error instanceof AggregateError) return error.errors
  return error.cause instanceof AggregateError ? error.cause.errors : []
}

/**
 * The reportable text of a mount failure.
 *
 * A plugin may reject with an aggregate or wrap one as its cause. Include its
 * member messages beneath the row diagnostic so each failure is visible.
 * @param error - the value the mount rejected with.
 * @returns a single-line-per-cause description.
 */
function mountDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const branches = detailBranches(error)
  if (branches.length === 0) return error.message
  return [
    error.message,
    ...branches.map(branch => `- ${mountDetail(branch).replaceAll('\n', '\n  ')}`),
  ].join('\n')
}

/** Load and audit one revision under its registry-owned scope.
 *
 * Failed rows and root-realm service leaks reject the mount. Rows waiting for
 * a Host service stay mounted: they activate by themselves once the provider
 * finishes, and the registry re-audits them after the Host tree settles.
 * Inside a profile, compatibility policy decides admission first: a row whose
 * plugin the profile denies mounts disabled, so the audit reads it as
 * intentionally inactive instead of reporting a failed import.
 * @param ctx Scope context inheriting the declaring Loader's resolution base.
 * @param id Preset identity.
 * @param plugins Declared Cordis entry list.
 * @returns The live tree; scope disposal owns its teardown.
 */
export async function mountPreset(ctx: Context, id: string, plugins: PresetDefinition['plugins']): Promise<PresetMount> {
  if (scopeOf(ctx) === undefined) throw new Error('agent-preset: mounting requires a scope')
  await ctx.fiber.await()
  const tree = new PresetTree(ctx)
  ctx.effect(() => () =>{  tree.root.stop() }, 'agent-preset.tree')
  await tree.root.update(prepareProfileEntries(ctx, plugins as EntryOptions[], ctx.baseUrl))
  const audit = await auditRows(tree)
  const leaked = leakedServices(ctx, ctx.fiber)
  if (audit.failed.length > 0) throw new Error(audit.failed.join('\n'))
  if (leaked.length > 0) throw new Error(`Preset services require isolate realms: ${leaked.join(', ')}`)
  const mount = { presetId: id, fiber: ctx.fiber, tree, key: scopeOf(ctx) }
  mounts.add(mount)
  ctx.effect(() => () => { mounts.delete(mount) }, 'agent-preset.mount')
  return mount
}
