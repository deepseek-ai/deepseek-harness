/**
 * jsdom slot test runtime: a real small runtime — Cordis `Context`, the
 * renderer-owned `SlotRegistry`, the `ui-session` adapter, and the UI renderer — assembled around
 * test-owned session/workspace doubles and a fail-loud file-upload stub, so feature specs exercise
 * declaration, registration, scope, store, inject, rendering, updates, and
 * disposal without hand-building the machinery per suite.
 *
 * Not part of the product plugin graph (no `dsh.client`); feature packages
 * depend on it in devDependencies only. It copies no SlotCore/renderer/store
 * machinery — everything mounts the production implementations.
 * @module @deepseek-ai/dsh-client-test-runtime
 */
/* oxlint-disable typescript/no-redundant-type-constituents --
 * `keyof SlotMap & string` is the declare-merge key pattern (see ui-slots):
 * this compilation unit sees only the runtime's 'root' row, but consumer
 * programs merge their own keys in; the rule fires on the narrow-map view. */
import { Context, Inject } from '@deepseek-ai/cordis'
import type { Fiber, Plugin } from '@deepseek-ai/cordis'
import { createElement, Fragment, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { act, render, within } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import type { queries } from '@testing-library/dom'
import type { BoundFunctions } from '@testing-library/dom'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { bindSnapshotSelector as bindRendererSnapshotSelector } from '@deepseek-ai/dsh-client-ui-renderer/src/client/bind.ts'
import { createSlotRenderer as createRenderer } from '@deepseek-ai/dsh-client-ui-renderer/src/client/scoped-slots.tsx'
import {
  apply as applyUiSession, inject as uiSessionInject,
} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  ChildrenDecl, ComposedProps, HostObservable, OwnerOf, SlotComponent, SlotMap, SlotRenderer,
  SlotRendererHost, SnapshotSelectorHook, StoreInstanceLike,
} from '@deepseek-ai/dsh-client-ui-slots'
import { registerDomSnapshotSerializer } from './snapshot.ts'
import { TestSessions } from './sessions.ts'
import { TestWorkspaces } from './workspaces.ts'
import type { Stabilizer } from './fixtures.ts'

export type { UseSession } from '@deepseek-ai/dsh-client-ui-session/client'
export { domSnapshotSerializer, registerDomSnapshotSerializer } from './snapshot.ts'
export { FixtureSession, TestSessions } from './sessions.ts'
export { stubSettingsScope } from './settings-scope.ts'
export type { StubSettingsScope } from './settings-scope.ts'
export { scriptedSettingsRemote } from './settings-remote.ts'
export type { ScriptedNamespace, ScriptedSettingsRemote } from './settings-remote.ts'
export { TestWorkspaces } from './workspaces.ts'
export { RemoteError, TestRemote } from './remote.ts'
export {
  chatSnapshot, conversationSnapshot, sessionSnapshot, workspaceSnapshot,
} from './fixtures.ts'
export type {
  FixtureSnapshot, SessionBehaviorOverrides, SessionFixture, SessionFixtureSnapshot, Stabilizer,
} from './fixtures.ts'
export { makeTranslate } from './translate.ts'
export { usePinnedBrowserLanguages } from './locale-env.ts'

/**
 * Bind an observable source to the production renderer's selector hook.
 * @param source - Observable snapshot source.
 * @returns Typed React selector hook.
 */
export function bindSnapshotSelector<T>(source: HostObservable<T>): SnapshotSelectorHook<T> {
  return bindRendererSnapshotSelector(source)
}

/**
 * Create the production slot renderer used by client feature tests.
 * @returns Slot renderer instance.
 */
export function createSlotRenderer(): SlotRenderer {
  return createRenderer()
}

/** Erased register face for the internal root call (the public declaration contract holds the typing). */
type ErasedRegister = (options: object, component: unknown) => () => void

/**
 * One rendered slot's local view, from {@link SlotTestRuntime.renderSlot}:
 * the renderer's own `[data-slot]` outlet anchor is the snapshot root
 * (`expect(view.container).toMatchSnapshot()` captures exactly this slot's
 * output), Testing Library queries are bound inside it, and `update`
 * re-renders with new owner props.
 */
export interface SlotView<K extends keyof SlotMap & string> {
  /** The renderer's `<div data-slot="<key>">` anchor around the slot's rendered output. */
  readonly container: HTMLElement
  /** Testing Library queries scoped to {@link SlotView.container}. */
  readonly view: BoundFunctions<typeof queries>
  /**
   * Replace the owner props and flush the re-render (the render-site update:
   * in production the owner recomputes the share and React re-renders).
   * @param owner - the next owner props share.
   */
  update(owner: OwnerOf<K>): void
}

/**
 * Mounted feature plugin handle: the live fiber plus an act-wrapped,
 * idempotent dispose (unload cascade: entries, declared child slots, store
 * instances, and provided services all fall together).
 */
export interface FeatureHandle {
  /** The plugin's live Cordis fiber (state assertions, escape hatch). */
  readonly fiber: Fiber
  /**
   * Dispose the plugin fiber inside React act; repeated calls no-op.
   * @returns completion of the unload cascade.
   */
  dispose(): Promise<void>
}

/** Mutable fail-loud file-upload stub installed by {@link SlotTestRuntime}. */
export interface TestFileUpload {
  /** Availability reported to the feature under test. */
  available: boolean
  /** Test-supplied upload behavior; the default rejects every call. */
  upload: (sessionId: SessionId, ...args: unknown[]) => Promise<unknown>
}

/**
 * Owner-props cell behind the auto frame: one external store the frame
 * subscribes to, so {@link SlotTestRuntime.renderSlot} and
 * {@link SlotView.update} drive React through the standard uSES boundary.
 */
class OwnerPropsCell {
  private readonly owners = new Map<string, object>()
  private readonly listeners = new Set<() => void>()
  private version = 0

  /** Snapshot version for uSES pairing (bumped on every set). */
  readonly getVersion = (): number => this.version

  /**
   * Subscribe to owner-props changes.
   * @param fn - change callback.
   * @returns unsubscribe.
   */
  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  /**
   * Install or replace one key's owner props and notify (synchronous; the
   * caller wraps in act).
   * @param key - slot key.
   * @param owner - owner props share.
   */
  set(key: string, owner: object): void {
    this.owners.set(key, owner)
    this.version += 1
    for (const fn of [...this.listeners]) fn()
  }

  /** Keys with supplied owner props, in first-supply order. */
  entries(): readonly (readonly [string, object])[] {
    return [...this.owners.entries()]
  }
}

/**
 * The test-owned 'root' occupant: declares the child slots a suite needs
 * through the REAL `slots.register`, with a caller-supplied minimal frame —
 * the runtime never guesses a feature's page structure.
 */
export class TestRoot {
  private disposeEntry: (() => void) | undefined

  /**
   * @param slots - the runtime SlotRegistry.
   * @param stabilize - the owning runtime's act wrapper.
   */
  constructor(private readonly slots: SlotRegistry, private readonly stabilize: Stabilizer) {}

  /**
   * Register the root frame, declaring (and thereby claiming) the child
   * slots. One declaration per runtime — a second call fails loud in the
   * core ('root' is a single slot).
   * @param children - child-slot declaration table (declaration + render authorization + runtime spec).
   * @param frame - minimal frame component; its props derive from the declared keys (composed-props contract).
   * @returns completion of the act-wrapped registration.
   */
  async declare<const D extends ChildrenDecl>(
    children: D,
    frame: SlotComponent<ComposedProps<'root', never, keyof NoInfer<D> & keyof SlotMap & string, undefined, object>>,
  ): Promise<void> {
    await this.stabilize(() => {
      // Erased hop (same pattern as SlotRegistry's own implementation arm);
      // the declaration signature above is the typed contract.
      this.disposeEntry = (this.slots.register as unknown as ErasedRegister)({ name: 'root', children }, frame)
    })
  }

  /** Remove the root registration and collapse its declarations (runtime dispose path). */
  release(): void {
    this.disposeEntry?.()
    this.disposeEntry = undefined
  }
}

/**
 * The assembled test runtime. Obtain via {@link SlotTestRuntime.create};
 * dispose with {@link SlotTestRuntime.dispose} (afterEach). Public mutators
 * are act-wrapped throughout — tests never handle SlotCore microtask
 * batching or React act themselves.
 */
export class SlotTestRuntime {
  /** The runtime's Cordis root for owner APIs and explicit test-only services. */
  readonly ctx: Context
  /** The production SlotRegistry mounted on {@link SlotTestRuntime.ctx}. */
  readonly slots: SlotRegistry
  /** The test-owned 'root' occupant. */
  readonly root: TestRoot
  /** Sessions double (list/current observable, cells, scopes, behavior faces). */
  readonly sessions: TestSessions
  /** Workspaces double (list observable, recorded intent actions). */
  readonly workspaces: TestWorkspaces
  /** Mutable file-upload stub; replace `upload` in suites that exercise the capability. */
  readonly fileUpload: TestFileUpload

  private readonly stabilizer: Stabilizer = async (fn) => {
    await act(async () => { await fn() })
  }

  private host: SlotRendererHost | undefined
  private readonly views: RenderResult[] = []
  private readonly handles: FeatureHandle[] = []
  private disposed = false
  /** Auto-frame state ({@link SlotTestRuntime.declare} / {@link SlotTestRuntime.renderSlot}). */
  private readonly ownerCell = new OwnerPropsCell()
  private readonly autoDeclared = new Set<string>()
  private autoRootView: RenderResult | undefined
  private readonly disposeWorkspaceSource: () => void

  private constructor(ctx: Context, slots: SlotRegistry) {
    this.ctx = ctx
    this.slots = slots
    this.root = new TestRoot(slots, this.stabilizer)
    this.sessions = new TestSessions(this.stabilizer, ctx)
    this.workspaces = new TestWorkspaces(this.stabilizer)
    this.fileUpload = {
      available: false,
      upload: () => Promise.reject(new Error('client test runtime: file upload is not stubbed')),
    }
    ctx.provide('sessions', this.sessions)
    ctx.provide('workspaces', this.workspaces)
    ctx.provide('fileUpload', this.fileUpload as never)
    this.disposeWorkspaceSource = slots.provideRoot({ hooks: { workspaces: this.workspaces.list } })
    // Capturing install: the production renderer does the rendering; the
    // wrapper only takes the host face for storeOf (no machinery copied).
    const renderer = createSlotRenderer()
    slots.install({
      renderRoot: (host, ownerProps) => {
        this.host = host
        return renderer.renderRoot(host, ownerProps)
      },
    })
  }

  /**
   * Assemble a runtime: real Context, mounted SlotRegistry, installed
   * renderer, and the session/workspace doubles provided as services.
   * @returns the ready runtime.
   */
  static async create(): Promise<SlotTestRuntime> {
    registerDomSnapshotSerializer()
    const ctx = new Context()
    const fiber = ctx.plugin(SlotRegistry)
    await fiber.await()
    const runtime = new SlotTestRuntime(ctx, ctx.get('slots') as SlotRegistry)
    await ctx.plugin({ inject: [...uiSessionInject], apply: applyUiSession }).await()
    return runtime
  }

  /**
   * Mount a feature plugin on a real fiber. Required services are prechecked
   * so a missing provider fails loud instead of suspending the fiber forever
   * (deliberate load-order suspension tests use `ctx.plugin` directly).
   * @param plugin - plugin value (function, class, or `{ inject, apply }` object).
   * @returns handle owning the fiber's explicit disposal.
   */
  async mount(plugin: Plugin): Promise<FeatureHandle> {
    const required = Object.keys(Inject.resolve((plugin as { inject?: Inject }).inject))
    const missing = required.filter(name => this.ctx.get(name) === undefined)
    if (missing.length > 0) {
      throw new Error(`mount would suspend: missing service(s) ${missing.join(', ')} — provide() them first`)
    }
    const fiber = this.ctx.plugin(plugin)
    await this.stabilizer(async () => {
      await fiber.await()
    })
    let disposed = false
    const handle: FeatureHandle = {
      fiber,
      dispose: async () => {
        if (disposed) return
        disposed = true
        await this.stabilizer(() => fiber.dispose())
      },
    }
    this.handles.push(handle)
    return handle
  }

  /** Release the default Workspace hook before mounting its production owner. */
  releaseWorkspaceSource(): void {
    this.disposeWorkspaceSource()
  }

  /**
   * Render the root slot tree through the ctx-level entry (the shell's own
   * entry point): `ctx.slots.renderSlot('root', {})` under Testing Library.
   * @returns the Testing Library view.
   */
  renderRoot(): RenderResult {
    const view = render(createElement(Fragment, null, this.slots.renderSlot('root', {})))
    this.views.push(view)
    return view
  }

  /**
   * Declare child slots under an auto-generated root frame — the single-slot
   * mounting path for local DOM snapshots. Each key later supplied through
   * {@link SlotTestRuntime.renderSlot} renders inside the renderer's own
   * `<div data-slot="<key>">` outlet anchor (the snapshot root — the frame
   * adds no wrapper of its own). Mutually exclusive with
   * {@link TestRoot.declare} ('root' is a single slot); one call per runtime.
   * @param children - child-slot declaration table (same contract as TestRoot.declare).
   * @returns completion of the act-wrapped registration.
   */
  async declare(children: ChildrenDecl): Promise<void> {
    for (const key of Object.keys(children)) this.autoDeclared.add(key)
    const cell = this.ownerCell
    const AutoFrame = (props: { renderSlot: (key: string, owner: object) => ReactNode }) => {
      useSyncExternalStore(cell.subscribe, cell.getVersion)
      // Keyed Fragments only: the renderer's outlet anchor is the one
      // `[data-slot]` element — the frame adding its own would nest
      // duplicate anchors under the same key.
      return createElement(Fragment, null, cell.entries().map(([key, owner]) =>
        createElement(Fragment, { key }, props.renderSlot(key, owner))))
    }
    await this.root.declare(children as never, AutoFrame as never)
  }

  /**
   * Render one declared slot with its owner props and return the local view.
   * The whole root tree mounts through the production assembly path
   * (renderer, scope providers, store axis); only this key's output lands in
   * the returned container. Call again with another key to view a sibling
   * slot of the same tree.
   * @param key - a key declared through {@link SlotTestRuntime.declare}.
   * @param owner - owner props share for the render site.
   * @returns the slot-local view (snapshot container, scoped queries, owner updates).
   */
  renderSlot<K extends keyof SlotMap & string>(key: K, owner: OwnerOf<K>): SlotView<K> {
    if (!this.autoDeclared.has(key)) {
      throw new Error(`renderSlot('${key}') without declare() — declare the key first (or use root.declare for a custom frame)`)
    }
    const install = (next: object): void => {
      // Synchronous cell write inside act: the frame re-renders through uSES.
      act(() => {
        this.ownerCell.set(key, next)
      })
    }
    install(owner)
    this.autoRootView ??= this.renderRoot()
    const container = this.autoRootView.container.querySelector(`[data-slot="${key}"]`)
    if (!(container instanceof HTMLElement)) {
      throw new Error(`renderSlot('${key}'): the auto frame rendered no wrapper — was the runtime already disposed?`)
    }
    return { container, view: within(container), update: install }
  }

  /**
   * Resolve the store instance the renderer would hand a slot's component
   * (identity assertions, action-driven writes). Requires a prior
   * {@link SlotTestRuntime.renderRoot} — the host face exists only inside the
   * installed renderer, exactly as in production.
   * @param key - slot key whose first entry declares the store.
   * @param scopeKey - session id for session-scope slots; omit for root scope.
   * @returns the live store instance.
   */
  storeOf(key: keyof SlotMap & string, scopeKey?: string): StoreInstanceLike {
    if (this.host === undefined) {
      throw new Error('storeOf before renderRoot() — the host face exists only inside the installed renderer')
    }
    const entry = this.host.entriesOf(key)[0]
    if (entry === undefined) throw new Error(`storeOf('${key}'): no registration on the ledger`)
    const scopeBinding = scopeKey === undefined
      ? undefined
      : this.host.scope('session')?.resolve(scopeKey)
    if (scopeKey !== undefined && scopeBinding === undefined) {
      throw new Error(`storeOf('${key}'): no live Session binding for '${scopeKey}'`)
    }
    const instance = this.host.storeOf(entry, scopeBinding)
    if (instance === undefined) throw new Error(`storeOf('${key}'): the entry declares no store`)
    return instance
  }

  /**
   * Flush pending ledger/store notifications inside act — for mutations made
   * outside the runtime's own methods (e.g. a direct `slots.register`).
   * @returns completion of the act pass.
   */
  async flush(): Promise<void> {
    await this.stabilizer(() => {})
  }

  /**
   * Tear down: unmount React trees first, then dispose feature fibers, the
   * root registration, minted session scopes, and persisted test state.
   * Idempotent.
   * @returns completion of the teardown.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.autoRootView = undefined
    for (const view of this.views.splice(0)) view.unmount()
    for (const handle of this.handles.splice(0)) await handle.dispose()
    this.root.release()
    await this.sessions.disposeScopes()
    localStorage.clear()
  }
}
