import { describe, expect, it, vi } from 'vitest'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { stubConfigForm, type StubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { ShellCardController, type ShellSettings } from '../src/client/shell-card-controller.ts'

/** Make the stub behave like a Host that accepts every write. */
function acceptWrites<T>(host: StubConfigForm<T>): void {
  const section = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().value as object })
  const layer = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().user as object })
  host.set.mockImplementation((field: string, value: unknown) => {
    host.publish({ value: { ...section(), [field]: value } as T, user: { ...layer(), [field]: value } })
  })
  host.mutate.mockImplementation((ops: readonly SettingsPathOpView[]) => {
    const value = { ...section() }
    const user = { ...layer() }
    for (const op of ops) {
      const field = op.path[0]!
      if (op.op === 'set') {
        value[field] = op.value
        user[field] = op.value
      } else {
        Reflect.deleteProperty(user, field)
        value[field] = (host.scope.getSnapshot().base as Record<string, unknown> | undefined)?.[field]
      }
    }
    host.publish({ value: value as T, user })
    return Promise.resolve(true)
  })
  host.unset.mockImplementation((field: string) => {
    const user = Object.fromEntries(Object.entries(layer()).filter(([key]) => key !== field))
    const base = host.scope.getSnapshot().base as Record<string, unknown> | undefined
    host.publish({ value: { ...section(), [field]: base?.[field] } as T, user })
  })
}

/** The card plugin's context, scripted down to the namespaces a card reaches. */
describe('ShellCardController', () => {
  it('projects both fields and saves them in one write pass', async () => {
    const host = stubConfigForm<ShellSettings>()
    acceptWrites(host)
    const controller = new ShellCardController(host.scope)
    host.publish({
      status: 'ready',
      writable: true,
      value: { timeoutMs: 5_000, maxOutputBytes: 64_000 },
      base: { timeoutMs: 60_000, maxOutputBytes: 64_000 },
      user: { timeoutMs: 5_000 },
    })
    const face = controller.inject()

    expect(face.hooks.shellCard.getSnapshot()).toMatchObject({
      available: true,
      writable: true,
      dirty: false,
      timeoutMs: { text: '5000', overridden: true },
      maxOutputBytes: { text: '64000', overridden: false },
    })

    face.edit('timeoutMs', '9000')
    face.edit('maxOutputBytes', '1024')
    expect(face.hooks.shellCard.getSnapshot().dirty).toBe(true)

    face.save()
    await vi.waitFor(() => { expect(host.mutate).toHaveBeenCalledTimes(1) })

    expect(host.mutate.mock.calls.map(([ops]) => ops)).toEqual([[['timeoutMs', 9_000], ['maxOutputBytes', 1_024]].map(([field, value]) => ({ op: 'set', path: [field], value }))])
    expect(face.hooks.shellCard.getSnapshot().dirty).toBe(false)
  })

  it('stages a reset and applies it on save', async () => {
    const host = stubConfigForm<ShellSettings>()
    acceptWrites(host)
    const controller = new ShellCardController(host.scope)
    host.publish({
      status: 'ready',
      writable: true,
      value: { timeoutMs: 5_000 },
      base: { timeoutMs: 60_000 },
      user: { timeoutMs: 5_000 },
    })
    const face = controller.inject()

    face.resetField('timeoutMs')
    expect(face.hooks.shellCard.getSnapshot().timeoutMs.text).toBe('60000')

    face.save()
    await vi.waitFor(() => { expect(host.mutate).toHaveBeenCalledWith([{ op: 'unset', path: ['timeoutMs'] }], undefined) })

    expect(face.hooks.shellCard.getSnapshot()).toMatchObject({
      dirty: false,
      timeoutMs: { text: '60000', overridden: false },
    })
  })

  it('discards staged edits without writing', () => {
    const host = stubConfigForm<ShellSettings>()
    const controller = new ShellCardController(host.scope)
    host.publish({ status: 'ready', writable: true, value: { timeoutMs: 5_000 }, user: {} })
    const face = controller.inject()

    face.edit('timeoutMs', '9000')
    face.discard()

    expect(face.hooks.shellCard.getSnapshot().timeoutMs.text).toBe('5000')
    expect(host.set).not.toHaveBeenCalled()
  })
})
