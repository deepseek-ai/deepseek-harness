/**
 * The staged form model: what a draft shows before it is written, which wire
 * call a save reaches, and what happens to drafts the Host did not accept.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  SettingsFormModel, settingsNumberField, settingsTextField,
  type SettingsFormPathOp, type SettingsFormScope, type SettingsFormScopeSnapshot,
} from '../src/index.ts'

interface StubScope<T> {
  scope: SettingsFormScope<T>
  mutate: ReturnType<typeof vi.fn<SettingsFormScope<T>['mutate']>>
  publish: (next: Partial<SettingsFormScopeSnapshot<T>>) => void
}

/** An in-memory scope: starts loading, records mutations, and lets the test publish Host acceptances. */
function stubScope<T>(): StubScope<T> {
  let snapshot: SettingsFormScopeSnapshot<T> = { status: 'loading', value: undefined, base: undefined, user: undefined, writable: false, revision: undefined }
  const listeners = new Set<() => void>()
  const mutate = vi.fn<SettingsFormScope<T>['mutate']>(() => Promise.resolve(true))
  const scope: SettingsFormScope<T> = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    mutate,
  }
  return { scope, mutate, publish: (next) => { snapshot = { ...snapshot, ...next }; for (const listener of listeners) listener() } }
}

/** Make the stub behave like a Host that accepts every write. */
function acceptWrites<T>(host: StubScope<T>): void {
  const section = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().value as object })
  const layer = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().user as object })
  host.mutate.mockImplementation((ops: readonly SettingsFormPathOp[]) => {
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
}

describe('SettingsFormModel', () => {
  function form() {
    const host = stubScope<Record<string, unknown>>()
    const subject = new SettingsFormModel(host.scope, [settingsNumberField('timeoutMs'), settingsTextField('baseURL')])
    host.publish({
      status: 'ready',
      writable: true,
      value: { timeoutMs: 60_000, baseURL: 'https://search.test/v1' },
      base: { timeoutMs: 60_000, baseURL: 'https://search.test/v1' },
      user: {},
    })
    return { host, subject }
  }

  it('reports a failed credential write even when another credential succeeds', async () => {
    const host = stubScope<Record<string, unknown>>()
    host.publish({ status: 'ready', writable: true, value: {} })
    const first = vi.fn(() => Promise.resolve(false))
    const second = vi.fn(() => Promise.resolve(true))
    const subject = new SettingsFormModel(host.scope, [], [{ field: 'first', write: first }, { field: 'second', write: second }])
    subject.actions().edit('first', 'one')
    subject.actions().edit('second', 'two')
    await subject.save()
    expect(first).toHaveBeenCalledWith('one')
    expect(second).toHaveBeenCalledWith('two')
    expect(subject.shell()).toMatchObject({ failed: true, dirty: true })
  })

  it('retains drafts after transport failure and allows a retry', async () => {
    const { host, subject } = form()
    subject.actions().edit('timeoutMs', '9000')
    host.mutate.mockRejectedValueOnce(new Error('disconnected'))
    await subject.save()
    expect(subject.shell()).toMatchObject({ dirty: true, failed: true, saving: false })
    acceptWrites(host)
    await subject.save()
    expect(subject.shell()).toMatchObject({ dirty: false, failed: false, saving: false })
  })

  it('shows the effective value and stays clean until something is staged', () => {
    const { subject } = form()

    expect(subject.field('timeoutMs')).toEqual({ text: '60000', overridden: false, invalid: false })
    expect(subject.shell()).toMatchObject({ available: true, writable: true, dirty: false, invalid: false })
  })

  it('marks a field the user layer carries as overridden', () => {
    const { host, subject } = form()

    host.publish({ value: { timeoutMs: 60_000 }, user: { timeoutMs: 60_000 } })

    // An override equal to the composition default is still an override.
    expect(subject.field('timeoutMs').overridden).toBe(true)
  })

  it('writes nothing until the form is saved', async () => {
    const { host, subject } = form()
    acceptWrites(host)

    subject.actions().edit('timeoutMs', '9000')

    expect(subject.field('timeoutMs')).toEqual({ text: '9000', overridden: true, invalid: false })
    expect(subject.shell().dirty).toBe(true)
    expect(host.mutate).not.toHaveBeenCalled()

    await subject.save()

    expect(host.mutate.mock.calls.map(([ops]) => ops)).toEqual([[['timeoutMs', 9_000]].map(([field, value]) => ({ op: 'set', path: [field], value }))])
    expect(subject.shell()).toMatchObject({ dirty: false, failed: false, saving: false })
  })

  it('drops a draft that settles back on the value already shown', async () => {
    const { host, subject } = form()

    subject.actions().edit('timeoutMs', '9000')
    subject.actions().edit('timeoutMs', '60000')

    expect(subject.shell().dirty).toBe(false)
    await subject.save()

    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('refuses to save while a draft is not a value the field accepts', async () => {
    const { host, subject } = form()

    subject.actions().edit('timeoutMs', 'soon')

    expect(subject.field('timeoutMs')).toEqual({ text: 'soon', overridden: false, invalid: true })
    expect(subject.shell()).toMatchObject({ dirty: true, invalid: true })

    await subject.save()

    expect(host.mutate).not.toHaveBeenCalled()
    expect(subject.field('timeoutMs').text).toBe('soon')
  })

  it('stages a reset that clears the field only once saved', async () => {
    const { host, subject } = form()
    acceptWrites(host)
    host.publish({ value: { timeoutMs: 9_000 }, user: { timeoutMs: 9_000 } })

    subject.actions().resetField('timeoutMs')

    // The badge previews the save: the field will no longer be overridden.
    expect(subject.field('timeoutMs')).toEqual({ text: '60000', overridden: false, invalid: false })
    expect(host.mutate).not.toHaveBeenCalled()

    await subject.save()

    expect(host.mutate).toHaveBeenCalledWith([{ op: 'unset', path: ['timeoutMs'] }], undefined)
    expect(subject.shell()).toMatchObject({ dirty: false, failed: false })
  })

  it('treats resetting an inherited field as no change at all', async () => {
    const { host, subject } = form()

    subject.actions().resetField('timeoutMs')

    expect(subject.shell().dirty).toBe(false)
    await subject.save()

    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('clears a number field by emptying it', async () => {
    const { host, subject } = form()
    acceptWrites(host)
    host.publish({ user: { timeoutMs: 9_000 } })

    subject.actions().edit('timeoutMs', '')

    expect(subject.field('timeoutMs')).toEqual({ text: '', overridden: false, invalid: false })
    await subject.save()

    expect(host.mutate).toHaveBeenCalledWith([{ op: 'unset', path: ['timeoutMs'] }], undefined)
  })

  it('clears a text field by emptying it', async () => {
    const { host, subject } = form()
    acceptWrites(host)
    host.publish({ user: { baseURL: 'https://search.test/v1' } })

    subject.actions().edit('baseURL', '   ')
    await subject.save()

    expect(host.mutate).toHaveBeenCalledWith([{ op: 'unset', path: ['baseURL'] }], undefined)
  })

  it('writes the trimmed text of a text field', async () => {
    const { host, subject } = form()
    acceptWrites(host)

    subject.actions().edit('baseURL', '  https://other.test  ')
    await subject.save()

    expect(host.mutate.mock.calls.map(([ops]) => ops)).toEqual([[['baseURL', 'https://other.test']].map(([field, value]) => ({ op: 'set', path: [field], value }))])
  })

  it('keeps the drafts a save did not land, and reports the failure', async () => {
    const { host, subject } = form()
    host.mutate.mockResolvedValue(false)

    subject.actions().edit('timeoutMs', '9000')
    await subject.save()

    // The stub Host accepted the call without storing it, exactly as a
    // validator that refuses the value does.
    expect(host.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['timeoutMs'], value: 9_000 }], undefined)
    expect(subject.shell()).toMatchObject({ dirty: true, failed: true, saving: false })
    expect(subject.field('timeoutMs').text).toBe('9000')
  })

  it('reports a reset the Host did not apply as a failure', async () => {
    const { host, subject } = form()
    host.mutate.mockResolvedValue(false)
    host.publish({ user: { timeoutMs: 9_000 } })

    subject.actions().resetField('timeoutMs')
    await subject.save()

    expect(host.mutate).toHaveBeenCalledWith([{ op: 'unset', path: ['timeoutMs'] }], undefined)
    expect(subject.shell().failed).toBe(true)
  })

  it('clears the failure as soon as the user edits again', async () => {
    const { host, subject } = form()
    host.mutate.mockResolvedValue(false)

    subject.actions().edit('timeoutMs', '9000')
    await subject.save()
    expect(subject.shell().failed).toBe(true)

    subject.actions().edit('timeoutMs', '9001')

    expect(subject.shell().failed).toBe(false)
  })

  it('discards every staged edit', async () => {
    const { host, subject } = form()

    subject.actions().edit('timeoutMs', '9000')
    subject.actions().discard()

    expect(subject.field('timeoutMs').text).toBe('60000')
    expect(subject.shell()).toMatchObject({ dirty: false, failed: false })

    // A discard with nothing staged publishes nothing.
    const before = subject.shell()
    subject.actions().discard()
    expect(subject.shell()).toEqual(before)

    await subject.save()
    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('refuses a second save while one is in flight', async () => {
    const { host, subject } = form()
    acceptWrites(host)

    subject.actions().edit('timeoutMs', '9000')
    const first = subject.save()
    expect(subject.shell().saving).toBe(true)
    const second = subject.save()
    await Promise.all([first, second])

    expect(host.mutate).toHaveBeenCalledTimes(1)
  })

  it('publishes a projection whenever the scope or a draft changes', () => {
    const { host, subject } = form()
    const store = subject.bind(() => subject.field('timeoutMs').text)
    expect(store.getSnapshot()).toBe('60000')

    host.publish({ value: { timeoutMs: 1_000 } })
    expect(store.getSnapshot()).toBe('1000')

    subject.actions().edit('timeoutMs', '2000')
    expect(store.getSnapshot()).toBe('2000')
  })

  it('refuses to address a field the card never declared', () => {
    const { subject } = form()

    expect(() => subject.field('nope')).toThrow('plugin card has no field nope')
  })

  it('renders an absent section value as an empty draft', () => {
    const host = stubScope<Record<string, unknown>>()
    const subject = new SettingsFormModel(host.scope, [settingsNumberField('timeoutMs'), settingsTextField('baseURL')])

    host.publish({ status: 'ready', writable: true, value: {}, base: {}, user: undefined })

    expect(subject.field('timeoutMs').text).toBe('')
    expect(subject.field('baseURL').text).toBe('')
    expect(subject.shell().available).toBe(true)
  })

  it('stays unavailable while the namespace is not served', () => {
    const host = stubScope<Record<string, unknown>>()
    const subject = new SettingsFormModel(host.scope, [settingsNumberField('timeoutMs')])

    host.publish({ status: 'unavailable' })

    expect(subject.shell()).toMatchObject({ available: false, writable: false })
  })
})
