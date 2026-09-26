import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { describe, expect, it, vi } from 'vitest'
import type {
  SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { SettingsSchemaService } from '../src/client/schema.ts'
import { ConfigFormController, ConfigForms } from '../src/client/config-form.ts'
import { SettingsDescribeMirror } from '../src/client/settings-mirror.ts'

const settingsSchema = new SettingsSchemaService(new Context())

interface UiTestSettings {
  preference: 'light' | 'dark' | 'system'
}

const ENVELOPE = z.object({
  preference: z.union(['light', 'dark', 'system']).default('system'),
}).toJSON()

/** What a Remote call answers with: no carrier envelope, and a typed failure. */
type Answer<T> =
  | { ok: true; value: T }
  | { ok: false; error: RemoteError }

function ok<T>(value: T): Answer<T> {
  return { ok: true, value }
}

function rejected<T>(): Answer<T> {
  return { ok: false, error: new RemoteError('settings/rejected', 'conflict', { ns: 'ui-test' }) }
}

/** The providing plugin's context, scripted down to the settings namespace. */
function ctxWith(settings: object) {
  return { remote: { settings } } as never
}

function view(value: JsonValue, revision = 0): SettingsNamespaceView {
  return {
    ns: 'ui-test',
    // `toJSON()` already produced the wire envelope; its declared type is the
    // schema builder's, so one cast names what the Host actually sends.
    schema: JSON.parse(JSON.stringify(ENVELOPE)) as JsonValue,
    value,
    autoGenerate: true, applies: 'live',
    secrets: [],
    revision,
  }
}

function described(value: JsonValue, revision = 0) {
  return ok({ writable: true, hasDocument: true, namespaces: [view(value, revision)] })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** A host-mode mirror plus a controller derived from it, over one scripted context. */
function derivedScope(
  api: { describe?: ReturnType<typeof vi.fn>; mutate?: ReturnType<typeof vi.fn> },
  spec: { namespace: string; decode?: (section: unknown) => UiTestSettings | undefined } = { namespace: 'ui-test' },
) {
  const ctx = ctxWith(api)
  const mirror = new SettingsDescribeMirror(ctx)
  const scope = new ConfigFormController<UiTestSettings>(ctx, spec, mirror, 'host', settingsSchema)
  return { mirror, scope }
}

/** Record each distinct published section, starting from the current one. */
function trackValues(scope: ConfigForm<UiTestSettings>): Array<UiTestSettings | undefined> {
  const seen: Array<UiTestSettings | undefined> = [scope.getSnapshot().value]
  scope.subscribe(() => {
    const value = scope.getSnapshot().value
    if (value !== seen[seen.length - 1]) seen.push(value)
  })
  return seen
}

describe('ConfigFormController', () => {
  it('starts loading and derives a schema-valid section with revision and writability', async () => {
    const describeCall = vi.fn().mockResolvedValueOnce(described({ preference: 'dark' }, 3))
    const { mirror, scope } = derivedScope({ describe: describeCall })
    expect(scope.getSnapshot()).toEqual({
      status: 'loading', value: undefined, revision: undefined, writable: false, mode: 'host',
    })
    await mirror.load()
    expect(scope.getSnapshot()).toEqual({
      status: 'ready', value: { preference: 'dark' }, revision: 3, writable: true, mode: 'host',
    })
  })

  it('keeps the last good value across invalid, rejected, and failed reads while tracking revisions', async () => {
    const describeCall = vi.fn()
      .mockResolvedValueOnce(described({ preference: 'dark' }, 3))
      .mockResolvedValueOnce(described({ preference: 'sepia' }, 4))
      .mockResolvedValueOnce(described(null, 5))
      .mockResolvedValueOnce(described('scalar', 6))
      .mockResolvedValueOnce(described(['queue'], 7))
      .mockResolvedValueOnce(rejected())
      .mockRejectedValueOnce(new Error('offline'))
    const { mirror, scope } = derivedScope({ describe: describeCall })
    const good = trackValues(scope)
    for (let i = 0; i < 7; i++) await mirror.load()
    expect(scope.getSnapshot()).toMatchObject({
      status: 'ready', value: { preference: 'dark' }, revision: 7,
    })
    expect(good).toEqual([undefined, { preference: 'dark' }])
  })

  it('treats a schema envelope it cannot rehydrate as vouching for no section', async () => {
    const broken = { ...view({ preference: 'dark' }, 2), schema: null }
    const describeCall = vi.fn()
      .mockResolvedValueOnce(ok({ writable: true, hasDocument: true, namespaces: [broken] }))
    const { mirror, scope } = derivedScope({ describe: describeCall })
    await mirror.load()
    expect(scope.getSnapshot()).toMatchObject({ status: 'loading', value: undefined, revision: 2 })
  })

  it('reports an unexposed namespace as unavailable and recovers when it reappears', async () => {
    const describeCall = vi.fn()
      .mockResolvedValueOnce(described({ preference: 'light' }, 1))
      .mockResolvedValueOnce(ok({ writable: true, hasDocument: true, namespaces: [] }))
      .mockResolvedValueOnce(described({ preference: 'system' }, 2))
    const { mirror, scope } = derivedScope({ describe: describeCall })
    await mirror.load()
    expect(scope.getSnapshot().status).toBe('ready')
    await mirror.load()
    expect(scope.getSnapshot()).toMatchObject({ status: 'unavailable', value: { preference: 'light' } })
    await mirror.load()
    expect(scope.getSnapshot()).toMatchObject({ status: 'ready', value: { preference: 'system' }, revision: 2 })
  })

  it('applies a custom decode override in place of the wire schema', async () => {
    const describeCall = vi.fn()
      .mockResolvedValueOnce(described({ preference: 'light' }, 1))
      .mockResolvedValueOnce(described({ preference: 'dark' }, 2))
    const { mirror, scope } = derivedScope({ describe: describeCall }, {
      namespace: 'ui-test',
      decode: section => (section as UiTestSettings).preference === 'dark'
        ? section as UiTestSettings
        : undefined,
    })
    await mirror.load()
    expect(scope.getSnapshot()).toMatchObject({ status: 'loading', value: undefined, revision: 1 })
    await mirror.load()
    expect(scope.getSnapshot()).toMatchObject({ status: 'ready', value: { preference: 'dark' }, revision: 2 })
  })

  it('serializes rapid set writes, carries revisions, and publishes only the latest settlement', async () => {
    const first = deferred<Answer<SettingsNamespaceView>>()
    const describeCall = vi.fn().mockResolvedValue(described({ preference: 'system' }, 4))
    const mutate = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(ok(view({ preference: 'light' }, 6)))
    const { mirror, scope } = derivedScope({ describe: describeCall, mutate })
    const published = trackValues(scope)
    await mirror.load()
    const dark = scope.set('preference', 'dark')
    const light = scope.set('preference', 'light')
    await vi.waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
    first.resolve(ok(view({ preference: 'dark' }, 5)))
    await Promise.all([dark, light])
    expect(published.map(section => section?.preference)).toEqual([undefined, 'system', 'light'])
    expect(scope.getSnapshot()).toMatchObject({ value: { preference: 'light' }, revision: 6 })
    expect(mutate).toHaveBeenNthCalledWith(1,
      'ui-test',
      [{ op: 'set', path: ['preference'], value: 'dark' }],
      4,
    )
    expect(mutate).toHaveBeenNthCalledWith(2,
      'ui-test',
      [{ op: 'set', path: ['preference'], value: 'light' }],
      5,
    )
  })

  it('sends one copied multi-field mutation behind one revision fence', async () => {
    const describeCall = vi.fn().mockResolvedValueOnce(described({ preference: 'system' }, 7))
    const mutate = vi.fn().mockResolvedValueOnce(ok(view({ preference: 'dark' }, 8)))
    const { mirror, scope } = derivedScope({ describe: describeCall, mutate })
    await mirror.load()
    const ops: SettingsPathOpView[] = [
      { op: 'set', path: ['enabled'], value: true },
      { op: 'set', path: ['allowedModels'], value: [{ provider: 'alpha', model: 'fast' }] },
    ]

    const write = scope.mutate(ops)
    ops[0] = { op: 'unset', path: ['enabled'] }
    const queued = ops[1]
    if (queued?.op !== 'set' || !Array.isArray(queued.value)) throw new Error('expected a set operation with a list value')
    ;(queued.value[0] as { model: string }).model = 'changed'
    await write

    expect(mutate).toHaveBeenCalledWith(
      'ui-test',
      [
        { op: 'set', path: ['enabled'], value: true },
        { op: 'set', path: ['allowedModels'], value: [{ provider: 'alpha', model: 'fast' }] },
      ],
      7,
    )
  })

  it('preserves an editor-owned revision fence behind earlier queued writes', async () => {
    const first = deferred<Answer<SettingsNamespaceView>>()
    const describeCall = vi.fn()
      .mockResolvedValueOnce(described({ preference: 'system' }, 7))
      .mockResolvedValueOnce(described({ preference: 'dark' }, 8))
    const mutate = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(rejected())
    const { mirror, scope } = derivedScope({ describe: describeCall, mutate })
    await mirror.load()

    const earlier = scope.set('preference', 'dark')
    const fenced = scope.mutate([{ op: 'set', path: ['preference'], value: 'light' }], 7)
    first.resolve(ok(view({ preference: 'dark' }, 8)))
    await Promise.all([earlier, fenced])

    expect(mutate).toHaveBeenNthCalledWith(
      2,
      'ui-test',
      [{ op: 'set', path: ['preference'], value: 'light' }],
      7,
    )
    expect(scope.getSnapshot()).toMatchObject({ value: { preference: 'dark' }, revision: 8 })
  })

  it('folds the latest write answer into the mirror so a sibling scope sees it', async () => {
    const describeCall = vi.fn().mockResolvedValueOnce(described({ preference: 'system' }, 4))
    const mutate = vi.fn().mockResolvedValueOnce(ok(view({ preference: 'dark' }, 5)))
    const ctx = ctxWith({ describe: describeCall, mutate })
    const mirror = new SettingsDescribeMirror(ctx)
    const writer = new ConfigFormController<UiTestSettings>(ctx, { namespace: 'ui-test' }, mirror, 'host', settingsSchema)
    const sibling = new ConfigFormController<UiTestSettings>(ctx, { namespace: 'ui-test' }, mirror, 'host', settingsSchema)
    await mirror.load()
    await writer.set('preference', 'dark')
    expect(describeCall).toHaveBeenCalledTimes(1)
    expect(sibling.getSnapshot()).toMatchObject({ value: { preference: 'dark' }, revision: 5 })
  })

  it('re-reads after a revisionless first write lands during the initial read', async () => {
    const initial = deferred<ReturnType<typeof described>>()
    const describeCall = vi.fn()
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValueOnce(described({ preference: 'dark' }, 2))
    const mutate = vi.fn().mockResolvedValueOnce(ok(view({ preference: 'dark' }, 2)))
    const { mirror, scope } = derivedScope({ describe: describeCall, mutate })
    const loading = mirror.load()
    await Promise.resolve()

    await scope.set('preference', 'dark')
    initial.resolve(described({ preference: 'system' }, 1))
    await loading

    expect(mutate).toHaveBeenCalledWith(
      'ui-test',
      [{ op: 'set', path: ['preference'], value: 'dark' }],
      undefined,
    )
    expect(describeCall).toHaveBeenCalledTimes(2)
    expect(scope.getSnapshot()).toMatchObject({ value: { preference: 'dark' }, revision: 2 })
  })

  it('recovers the latest refused write from Host state', async () => {
    const describeCall = vi.fn()
      .mockResolvedValueOnce(described({ preference: 'system' }, 2))
      .mockResolvedValueOnce(described({ preference: 'light' }, 3))
    const mutate = vi.fn()
      .mockResolvedValueOnce(rejected())
      .mockResolvedValueOnce(rejected())
    const { mirror, scope } = derivedScope({ describe: describeCall, mutate })
    const published = trackValues(scope)
    await mirror.load()
    await scope.set('preference', 'dark')
    await scope.set('preference', 'system')
    expect(published.map(section => section?.preference)).toEqual([undefined, 'system', 'light'])
  })

  it('does not recover superseded refused writes', async () => {
    const describeCall = vi.fn().mockResolvedValueOnce(described({ preference: 'system' }, 2))
    const mutate = vi.fn()
      .mockResolvedValueOnce(rejected())
      .mockResolvedValueOnce(rejected())
      .mockResolvedValueOnce(ok(view({ preference: 'light' }, 3)))
    const { mirror, scope } = derivedScope({ describe: describeCall, mutate })
    const published = trackValues(scope)
    await mirror.load()
    await Promise.all([
      scope.set('preference', 'dark'),
      scope.set('preference', 'system'),
      scope.set('preference', 'light'),
    ])
    expect(describeCall).toHaveBeenCalledTimes(1)
    expect(published.map(section => section?.preference)).toEqual([undefined, 'system', 'light'])
  })

  it('keeps the write queue usable when a subscriber throws', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    const describeCall = vi.fn()
      .mockResolvedValueOnce(described({ preference: 'dark' }, 1))
      .mockResolvedValueOnce(described({ preference: 'light' }, 2))
    const { mirror, scope } = derivedScope({ describe: describeCall })
    let thrown = false
    scope.subscribe(() => {
      if (thrown) return
      thrown = true
      throw new Error('subscriber failed')
    })
    await expect(mirror.load()).resolves.toBeUndefined()
    await expect(mirror.load()).resolves.toBeUndefined()
    expect(scope.getSnapshot()).toMatchObject({ value: { preference: 'light' }, revision: 2 })
    expect(report).toHaveBeenCalledWith('[client-store] subscriber failed:', expect.objectContaining({
      message: 'subscriber failed',
    }))
    report.mockRestore()
  })

  it('keeps the write queue usable when a write publication listener throws', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    const describeCall = vi.fn().mockResolvedValueOnce(described({ preference: 'system' }, 1))
    const mutate = vi.fn()
      .mockResolvedValueOnce(ok(view({ preference: 'dark' }, 2)))
      .mockResolvedValueOnce(ok(view({ preference: 'light' }, 3)))
    const { mirror, scope } = derivedScope({ describe: describeCall, mutate })
    await mirror.load()
    let shouldThrow = true
    mirror.subscribe(() => {
      if (!shouldThrow) return
      shouldThrow = false
      throw new Error('write subscriber failed')
    })

    await expect(scope.set('preference', 'dark')).resolves.toBe(true)
    await expect(scope.set('preference', 'light')).resolves.toBe(true)

    expect(mutate).toHaveBeenCalledTimes(2)
    expect(scope.getSnapshot()).toMatchObject({ value: { preference: 'light' }, revision: 3 })
    expect(report).toHaveBeenCalledWith('[client-store] subscriber failed:', expect.objectContaining({
      message: 'write subscriber failed',
    }))
    report.mockRestore()
  })

  it('keeps the write queue usable after a failed mirror fold', async () => {
    const describeCall = vi.fn().mockResolvedValueOnce(described({ preference: 'system' }, 1))
    const mutate = vi.fn()
      .mockResolvedValueOnce(ok(view({ preference: 'dark' }, 2)))
      .mockResolvedValueOnce(ok(view({ preference: 'light' }, 3)))
    const { mirror, scope } = derivedScope({ describe: describeCall, mutate })
    await mirror.load()
    vi.spyOn(mirror, 'acceptView').mockImplementationOnce(() => {
      throw new Error('mirror fold failed')
    })

    await expect(scope.set('preference', 'dark')).rejects.toThrow('mirror fold failed')
    await expect(scope.set('preference', 'light')).resolves.toBe(true)

    expect(mutate).toHaveBeenCalledTimes(2)
    expect(mutate).toHaveBeenNthCalledWith(2,
      'ui-test',
      [{ op: 'set', path: ['preference'], value: 'light' }],
      1,
    )
    expect(scope.getSnapshot()).toMatchObject({ value: { preference: 'light' }, revision: 3 })
  })

  it('cancels queued and post-dispose writes while draining the in-flight mutation', async () => {
    const first = deferred<Answer<SettingsNamespaceView>>()
    const mutate = vi.fn().mockReturnValue(first.promise)
    const describeCall = vi.fn()
    const { scope } = derivedScope({ describe: describeCall, mutate })
    const published = trackValues(scope)
    const dark = scope.set('preference', 'dark')
    await vi.waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
    const light = scope.set('preference', 'light')
    let stopped = false
    const stop = scope.dispose().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    first.resolve(ok(view({ preference: 'dark' }, 1)))
    await Promise.all([dark, light, stop])
    await scope.set('preference', 'system')
    expect(mutate).toHaveBeenCalledOnce()
    expect(describeCall).not.toHaveBeenCalled()
    expect(published).toEqual([undefined])
  })

  it('stops deriving from the mirror after dispose', async () => {
    const describeCall = vi.fn()
      .mockResolvedValueOnce(described({ preference: 'dark' }, 1))
      .mockResolvedValueOnce(described({ preference: 'light' }, 2))
    const { mirror, scope } = derivedScope({ describe: describeCall })
    await mirror.load()
    expect(scope.getSnapshot()).toMatchObject({ value: { preference: 'dark' } })
    await scope.dispose()
    await mirror.load()
    expect(scope.getSnapshot()).toMatchObject({ value: { preference: 'dark' }, revision: 1 })
  })

  it('ignores a mirror notification already queued when disposal starts', async () => {
    let notify = (): void => {}
    let snapshot = {
      status: 'ready' as const,
      view: {
        writable: true, hasDocument: true,
        namespaces: [view({ preference: 'dark' }, 1)],
      },
      error: null,
    }
    const mirror = {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        notify = listener
        return () => {}
      },
    } as never
    const scope = new ConfigFormController<UiTestSettings>(
      ctxWith({}), { namespace: 'ui-test' }, mirror, 'host', settingsSchema)
    expect(scope.getSnapshot()).toMatchObject({ value: { preference: 'dark' }, revision: 1 })

    await scope.dispose()
    snapshot = {
      ...snapshot,
      view: { ...snapshot.view, namespaces: [view({ preference: 'light' }, 2)] },
    }
    notify()

    expect(scope.getSnapshot()).toMatchObject({ value: { preference: 'dark' }, revision: 1 })
  })

  it('keeps a remote browser in memory mode without Host calls', async () => {
    const describeCall = vi.fn()
    const mutate = vi.fn()
    const ctx = ctxWith({ describe: describeCall, mutate })
    const mirror = new SettingsDescribeMirror(ctx, 'memory')
    const scope = new ConfigFormController<UiTestSettings>(
      ctx, { namespace: 'ui-test' }, mirror, 'memory', settingsSchema)
    expect(scope.getSnapshot()).toEqual({
      status: 'unavailable', value: undefined, revision: undefined, writable: false, mode: 'memory',
    })
    await mirror.load()
    await scope.set('preference', 'dark')
    await scope.dispose()
    expect(describeCall).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()
  })

  it('carries the composition base and the user layer into the snapshot', async () => {
    const layered: SettingsNamespaceView = {
      ...view({ preference: 'dark' }, 3),
      base: { preference: 'system' },
      user: { preference: 'dark' },
    }
    const describeCall = vi.fn()
      .mockResolvedValueOnce(ok({ writable: true, hasDocument: true, namespaces: [layered] }))
    const { mirror, scope } = derivedScope({ describe: describeCall })

    await mirror.load()

    expect(scope.getSnapshot()).toMatchObject({
      value: { preference: 'dark' },
      base: { preference: 'system' },
      user: { preference: 'dark' },
    })
  })

  it('reports an inherited field as absent from the user layer', async () => {
    const inherited: SettingsNamespaceView = { ...view({ preference: 'system' }, 1), base: { preference: 'system' } }
    const describeCall = vi.fn()
      .mockResolvedValueOnce(ok({ writable: true, hasDocument: true, namespaces: [inherited] }))
    const { mirror, scope } = derivedScope({ describe: describeCall })

    await mirror.load()

    expect(scope.getSnapshot().user).toBeUndefined()
  })

  it('clears one field through an unset op fenced by the held revision', async () => {
    const mutate = vi.fn().mockResolvedValueOnce(ok(view({ preference: 'system' }, 4)))
    const describeCall = vi.fn().mockResolvedValueOnce(described({ preference: 'dark' }, 3))
    const { mirror, scope } = derivedScope({ describe: describeCall, mutate })
    await mirror.load()

    await scope.unset('preference')

    expect(mutate).toHaveBeenCalledWith(
      'ui-test',
      [{ op: 'unset', path: ['preference'] }],
      3,
    )
    expect(scope.getSnapshot()).toMatchObject({ value: { preference: 'system' }, revision: 4 })
  })

  it('recovers the Host state when the latest clear is refused', async () => {
    const mutate = vi.fn().mockResolvedValueOnce(rejected())
    const describeCall = vi.fn()
      .mockResolvedValueOnce(described({ preference: 'dark' }, 3))
      .mockResolvedValueOnce(described({ preference: 'light' }, 5))
    const { mirror, scope } = derivedScope({ describe: describeCall, mutate })
    await mirror.load()

    await scope.unset('preference')

    expect(scope.getSnapshot()).toMatchObject({ value: { preference: 'light' }, revision: 5 })
  })
})

describe('ConfigForms.get', () => {
  it('shares accepted values and one write queue across consumers of the same entry', async () => {
    const describeCall = vi.fn().mockResolvedValue(described({ preference: 'dark' }, 1))
    const mirror = new SettingsDescribeMirror(ctxWith({ describe: describeCall }))
    const ctx = new Context()
    let theme!: ConfigForm<UiTestSettings>
    let locale!: ConfigForm<UiTestSettings>
    new TestRemote(ctx, { settings: { describe: describeCall } })
    await ctx.plugin(ConfigForms, { mirror, schema: settingsSchema, persistence: 'host' }).await()
    expect(ctx.configForms.describe()).toBe(mirror)
    const fiber = ctx.plugin({
      inject: ['remote', 'configForms'],
      apply: (plugin: Context) => {
        theme = plugin.configForms.get<UiTestSettings>('ui-test')
        locale = plugin.configForms.get<UiTestSettings>('ui-test')
      },
    })
    await fiber.await()
    await vi.waitFor(() => {
      expect(theme.getSnapshot()).toMatchObject({ status: 'ready', value: { preference: 'dark' } })
      expect(locale.getSnapshot()).toMatchObject({ status: 'ready', value: { preference: 'dark' } })
    })
    expect(describeCall).toHaveBeenCalledTimes(1)
    expect(theme).toBe(locale)
    await fiber.dispose()
    await mirror.load()
    expect(theme.getSnapshot()).toMatchObject({ revision: 1 })
  })

  it('binds a remote browser in memory mode without starting a settings read', async () => {
    const describeCall = vi.fn()
    const mirror = new SettingsDescribeMirror(ctxWith({ describe: describeCall }), 'memory')
    const ctx = new Context()
    let scope!: ConfigForm<UiTestSettings>
    new TestRemote(ctx, { settings: { describe: describeCall } })
    await ctx.plugin(ConfigForms, { mirror, schema: settingsSchema, persistence: 'memory' }).await()
    const fiber = ctx.plugin({
      inject: ['remote', 'configForms'],
      apply: (plugin: Context) => {
        scope = plugin.configForms.get<UiTestSettings>('ui-test')
      },
    })
    await fiber.await()
    expect(scope.getSnapshot()).toMatchObject({ status: 'unavailable', mode: 'memory', writable: false })
    await fiber.dispose()
    expect(describeCall).not.toHaveBeenCalled()
  })
})
