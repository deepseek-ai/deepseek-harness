/** Shared entry values and ordered writes over the Host configuration mirror. */

import { DeveloperToolsPreference } from './developer-tools.ts'
import { DEVELOPER_TOOLS_NAMESPACE } from '../developer-tools-settings.ts'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type {
  SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
// Type-only, and deliberately NOT `@deepseek-ai/dsh-api-remotes/client`: this
// package is reachable from the Host build graph through its feature-package
// callers, and api-remotes' Client face imports a Host-tsdown-generated
// `/remote` artifact, which would deadlock the Host tsc phase. The gateway's
// Client half declares `ctx.remote` with no generated import, and the
// allowlist's `types` subpath is a pure-type source file, so the pair supplies
// `$on` and its key face without dragging a build artifact in. The runtime
// `remote` injection belongs to the providing plugin's apply, which registers
// the mirror's invalidation subscriptions.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remotes/types'
// The forwarded event's own declaration: `$on`'s key face is
// `Extract<keyof Events, keyof Selection>`, so the allowlist alone resolves to
// never — the owning package's client-safe, type-only subpath supplies the
// cordis `Events` entry (and with it the branded `SettingsNamespace`).
import type {} from '@deepseek-ai/dsh-settings/types'
import type { SettingsSchemaService } from './schema.ts'
import type { ConfigForm, ConfigFormSnapshot } from './config-form-types.ts'
import { SettingsDescribeMirror, type SettingsDescribeFace } from './settings-mirror.ts'

/** Domain-owned description of one settings namespace consumed by a browser plugin. */
interface ConfigFormSpec<T> {
  /** Settings namespace registered by the owning Host plugin. */
  namespace: string
  /**
   * Narrow one wire section; undefined keeps the last accepted value. The
   * default validates the section against the namespace's own serialized wire
   * schema, so domains add a decoder only to narrow beyond that schema.
   */
  decode?: (section: unknown) => T | undefined
}

/**
 * One namespace's derived view over the shared describe mirror, plus that
 * namespace's serialized Host writes. Writes carry the latest known namespace
 * revision, fold their answers back into the mirror, and teardown waits for
 * the operation already crossing the wire.
 */
export class ConfigFormController<T> implements ConfigForm<T> {
  private readonly store: SnapshotStore<ConfigFormSnapshot<T>>
  private tail: Promise<void> = Promise.resolve()
  private writeGeneration = 0
  private disposed = false
  private readonly unsubscribe: (() => void) | undefined
  /**
   * Revision answered by a superseded write still ahead of the mirror: the
   * mirror only folds the LATEST settlement in, so a queued successor takes
   * its fence from here first.
   */
  private pendingRevision: number | undefined

  /**
   * @param ctx - the providing plugin's context, whose `remote.settings`
   * namespace carries this form's writes (reads ride the mirror).
   * @param spec - namespace identity and optional narrowing decoder.
   * @param mirror - the shared describe mirror this form derives from.
   * @param persistence - client-selected Host persistence; non-loopback pages may remain process-local.
   * @param schema - settings-owned schema operations.
   */
  constructor(
    private readonly ctx: Context,
    private readonly spec: ConfigFormSpec<T>,
    private readonly mirror: SettingsDescribeMirror,
    private readonly persistence: 'host' | 'memory',
    private readonly schema: SettingsSchemaService,
  ) {
    this.store = createSnapshotStore<ConfigFormSnapshot<T>>({
      status: persistence === 'host' ? 'loading' : 'unavailable',
      value: undefined,
      base: undefined,
      user: undefined,
      revision: undefined,
      writable: false,
      mode: persistence,
    })
    if (persistence === 'host') {
      this.unsubscribe = mirror.subscribe(() => { this.derive() })
      this.derive()
    }
  }

  /** @returns the current sync snapshot (stable reference until the next change). */
  getSnapshot(): ConfigFormSnapshot<T> {
    return this.store.getSnapshot()
  }

  /**
   * Observe snapshot replacements.
   * @param listener - invoked after each snapshot change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener)
  }

  /**
   * Queue one field write; see {@link ConfigForm.set} for the ordering,
   * revision, and recovery contract.
   * @param field - scalar field inside the namespace section.
   * @param value - JSON-shaped value selected by the user.
   * @returns whether the Host accepted the write, after any recovery read.
   */
  set(field: string, value: unknown): Promise<boolean> {
    return this.mutate([{ op: 'set', path: [field], value: value as JsonValue }])
  }

  /**
   * Queue one field clear; see {@link ConfigForm.unset} for the ordering,
   * revision, and recovery contract.
   * @param field - scalar field inside the namespace section.
   * @returns whether the Host accepted the clear, after any recovery read.
   */
  unset(field: string): Promise<boolean> {
    return this.mutate([{ op: 'unset', path: [field] }])
  }

  /**
   * Queue one atomic namespace mutation; see {@link ConfigForm.mutate}.
   * @param ops - ordered field operations copied when queued.
   * @param expectedRevision - optional fixed revision read by the domain editor.
   * @returns whether the Host accepted the mutation, after any recovery read.
   */
  mutate(ops: readonly SettingsPathOpView[], expectedRevision?: number): Promise<boolean> {
    const ownedOps = structuredClone(ops) as SettingsPathOpView[]
    const generation = ++this.writeGeneration
    return this.enqueue(async () => {
      const revision = expectedRevision ?? this.pendingRevision ?? this.getSnapshot().revision
      const response = await this.ctx.remote.settings.mutate(this.spec.namespace, ownedOps, revision)
      if (!response.ok) {
        await this.recover(generation)
        return false
      }
      if (this.disposed) return true
      if (generation === this.writeGeneration) {
        this.pendingRevision = undefined
        this.mirror.acceptView(response.value)
      } else {
        this.pendingRevision = response.value.revision
      }
      return true
    })
  }

  /** Reload Host state for the latest failed write; superseded failures leave recovery to it. */
  private async recover(generation: number): Promise<void> {
    if (this.disposed || generation !== this.writeGeneration) return
    this.pendingRevision = undefined
    await this.mirror.load()
  }

  /**
   * Stop queued operations, stop deriving, and wait for the current wire call
   * to settle.
   * @returns settlement after the controller reaches quiescence.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    this.writeGeneration += 1
    this.unsubscribe?.()
    await this.tail
  }

  private enqueue(operation: () => Promise<boolean>): Promise<boolean> {
    if (this.persistence === 'memory' || this.disposed) return Promise.resolve(false)
    const task = this.tail.then(async () => {
      if (this.disposed) return false
      return await operation()
    })
    // The returned task carries its own settlement to the caller; the queue
    // tail is kept fulfilled so one failed subscriber cannot strand later operations.
    this.tail = task.then(() => {}, () => {})
    return task
  }

  private derive(): void {
    if (this.disposed) return
    const mirrored = this.mirror.getSnapshot()
    if (mirrored.view === undefined) return
    const { writable } = mirrored.view
    const view = mirrored.view.namespaces.find(candidate => candidate.ns === this.spec.namespace)
    if (view === undefined) {
      this.store.update((draft) => {
        draft.status = 'unavailable'
        draft.writable = writable
      })
      return
    }
    const decoded = this.decode(view)
    this.store.update((draft) => {
      draft.revision = view.revision
      draft.base = view.base
      draft.user = view.user
      draft.writable = writable
      if (decoded === undefined) return
      draft.status = 'ready'
      draft.value = decoded
    })
  }

  private decode(view: SettingsNamespaceView): T | undefined {
    if (this.spec.decode !== undefined) return this.spec.decode(view.value)
    // Sections are plain objects by construction; schemastery alone would
    // resolve null or an array through object defaults instead of refusing.
    if (typeof view.value !== 'object' || view.value === null || Array.isArray(view.value)) return undefined
    let failure: string | undefined
    try {
      failure = this.schema.validate(this.schema.rehydrate(view.schema), view.value)
    } catch (_malformedSchemaEnvelope) {
      // A schema envelope this client cannot rehydrate vouches for no section;
      // the value is treated exactly like a schema-invalid one.
      return undefined
    }
    return failure === undefined ? view.value as T : undefined
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    configForms: ConfigForms
  }
}

/**
 * The settings domain's base service. Features that own a preference reach the
 * settings transport through this service rather than a shared function: the
 * client bundle purity gate forbids cross-plugin value imports and directs
 * cross-plugin collaboration through cordis services
 * (`packages/client/tsdown.client.ts`).
 */
export class ConfigForms extends Service {
  private readonly forms = new Map<string, ConfigFormController<unknown>>()
  /** Shared developer-tool preference owned by this settings provider. */
  readonly developerTools: DeveloperToolsPreference
  private readonly mirror: SettingsDescribeMirror
  private readonly schema: SettingsSchemaService
  private readonly persistence: 'host' | 'memory'
  /**
   * The PROVIDING fiber, kept because a Service reads `ctx` as its *consumer's*
   * fiber: letting a shared form write through the caller's context would make
   * every caller declare `remote.settings` in its own `inject`.
   */
  private readonly owner: Context

  /**
   * @param ctx - the providing plugin's context.
   * @param config - the shared describe mirror every shared form derives from,
   * the settings-owned schema operations, and the Host persistence the provider
   * resolved from `remote.$host`.
   */
  constructor(ctx: Context, config: {
    mirror: SettingsDescribeMirror
    schema: SettingsSchemaService
    persistence: 'host' | 'memory'
  }) {
    super(ctx, 'configForms')
    this.mirror = config.mirror
    this.schema = config.schema
    this.persistence = config.persistence
    this.owner = ctx
    this.developerTools = new DeveloperToolsPreference(this.get(DEVELOPER_TOOLS_NAMESPACE))
    ctx.effect(() => async () => {
      await Promise.all([...this.forms.values()].map(form => form.dispose()))
      this.forms.clear()
    }, 'ui-settings: configuration forms')
  }

  /**
   * The shared mirror's read/fold face for cross-namespace surfaces (schema
   * introspection, the served-namespace directory). Per-namespace consumers
   * use {@link get}; both derive from the same snapshot, so they can never
   * disagree about the document.
   * @returns the describe face over the shared mirror.
   */
  describe(): SettingsDescribeFace {
    return this.mirror
  }

  /** Get the shared form values and write queue for one Host plugin entry.
   * @param entryId Unique Host plugin entry id.
   * @returns The entry's form, owned by this provider.
   */
  get<T>(entryId: string): ConfigForm<T> {
    const existing = this.forms.get(entryId)
    if (existing !== undefined) return existing as ConfigFormController<T>
    const form = new ConfigFormController<T>(
      this.owner, { namespace: entryId }, this.mirror, this.persistence, this.schema,
    )
    this.forms.set(entryId, form)
    void this.mirror.ensure()
    return form
  }

  /**
   * Keep a registration alive while the Host serves any of some namespaces:
   * `register` runs once one of them is in the describe mirror, and its
   * disposer runs when none is or when the returned disposer runs. A plugin
   * whose page edits a namespace another plugin owns registers the page
   * through this, so a deployment that never composed the owner shows no
   * trace of the page. The caller owns the returned disposer and wraps it in
   * `ctx.effect`; unlike {@link bind}, nothing is registered on the caller's
   * context here.
   * @param namespaces - the settings namespaces the registration follows.
   * @param register - registers the contribution, given every namespace the Host serves; returns its disposer.
   * @returns the disposer ending the watch and any live registration.
   */
  whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void {
    let off: (() => void) | undefined
    const sync = (): void => {
      const served = new Set(this.mirror.getSnapshot().view?.namespaces.map(view => view.ns) ?? [])
      const watched = namespaces.some(namespace => served.has(namespace))
      if (watched && off === undefined) off = register(served)
      else if (!watched && off !== undefined) {
        off()
        off = undefined
      }
    }
    const unsubscribe = this.mirror.subscribe(sync)
    void this.mirror.ensure()
    sync()
    return () => {
      unsubscribe()
      off?.()
      off = undefined
    }
  }
}
