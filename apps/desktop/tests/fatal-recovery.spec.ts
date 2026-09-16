import { afterEach, expect, it, vi } from 'vitest'
import type { MessageBoxOptions } from 'electron'
import { DesktopFatalRecovery } from '../src/fatal-recovery.ts'
import { resolveDesktopLocale } from '../src/locale.ts'

function fixture(locale = 'en') {
  const choice = Promise.withResolvers<{ response: number; checkboxChecked: boolean }>()
  const stopped = Promise.withResolvers<undefined>()
  const operations = {
    messages: () => resolveDesktopLocale(locale).messages,
    show: vi.fn((_options: MessageBoxOptions) => choice.promise),
    stop: vi.fn(() => stopped.promise),
    disablePlugins: vi.fn(async () => {}),
    exit: vi.fn(),
    restart: vi.fn(),
  }
  return { operations, choice, stopped, recovery: new DesktopFatalRecovery(operations) }
}

afterEach(() => { vi.restoreAllMocks() })

it.each(['en', 'zh-CN'])('records the %s native recovery dialog', async (locale) => {
  const { operations, choice, stopped, recovery } = fixture(locale)
  const pending = recovery.report(new AggregateError([new Error('Plugin initialization failed')], 'Desktop Host failed'))
  const options = operations.show.mock.calls[0]![0]
  await expect([options.title, options.message, options.detail, ...options.buttons!].join('\n') + '\n')
    .toMatchFileSnapshot(`expected/fatal-dialog-${locale}.txt`)
  choice.resolve({ response: 0, checkboxChecked: false })
  stopped.resolve(undefined)
  await pending
})

it('locks the first report before the dialog settles and never resets after an action', async () => {
  const { operations, choice, stopped, recovery } = fixture()
  const pending = recovery.report(new Error('first failure'))
  await recovery.report(new Error('second failure'))
  expect(operations.show).toHaveBeenCalledOnce()
  expect(operations.show.mock.calls[0]![0].detail).toContain('first failure')
  choice.resolve({ response: 1, checkboxChecked: false })
  stopped.resolve(undefined)
  await pending
  await recovery.report(new Error('third failure'))
  expect(operations.show).toHaveBeenCalledOnce()
})

it.each([0, 1, 2])('waits for shutdown before executing choice %s', async (response) => {
  const { operations, choice, stopped, recovery } = fixture()
  const stopping = Promise.withResolvers<undefined>()
  operations.stop.mockImplementation(() => { stopping.resolve(undefined); return stopped.promise })
  const pending = recovery.report(new Error('fatal'))
  choice.resolve({ response, checkboxChecked: false })
  await stopping.promise
  expect(operations.exit).not.toHaveBeenCalled()
  expect(operations.restart).not.toHaveBeenCalled()
  expect(operations.disablePlugins).not.toHaveBeenCalled()
  stopped.resolve(undefined)
  await pending
  expect(operations.exit).toHaveBeenCalledTimes(response === 0 ? 1 : 0)
  expect(operations.restart).toHaveBeenCalledTimes(response === 0 ? 0 : 1)
  expect(operations.disablePlugins).toHaveBeenCalledTimes(response === 2 ? 1 : 0)
})

it('reports a user-requested disable failure and allows exit without restarting', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const { operations, stopped, recovery } = fixture()
  operations.show.mockResolvedValueOnce({ response: 2, checkboxChecked: false })
    .mockResolvedValueOnce({ response: 0, checkboxChecked: false })
  operations.disablePlugins.mockRejectedValueOnce(new Error('profile is read-only'))
  stopped.resolve(undefined)
  await recovery.report(new Error('fatal'))
  expect(operations.show).toHaveBeenCalledTimes(2)
  expect(operations.show.mock.calls[1]![0].detail).toContain('profile is read-only')
  expect(operations.restart).not.toHaveBeenCalled()
  expect(operations.exit).toHaveBeenCalledOnce()
})

it('allows exit after shutdown cleanup fails', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const { operations, choice, stopped, recovery } = fixture()
  const pending = recovery.report(new Error('fatal'))
  choice.resolve({ response: 0, checkboxChecked: false })
  stopped.reject(new Error('cleanup failed'))
  await pending
  expect(operations.exit).toHaveBeenCalledOnce()
})

it.each(['en', 'zh-CN'])('bounds long diagnostics and recovery-operation errors in %s', async (locale) => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const { operations, stopped, recovery } = fixture(locale)
  operations.show.mockResolvedValueOnce({ response: 2, checkboxChecked: false })
    .mockResolvedValueOnce({ response: 0, checkboxChecked: false })
  operations.disablePlugins.mockRejectedValueOnce(new Error('read-only\n'.repeat(5000) + 'final write failure'))
  stopped.resolve(undefined)
  await recovery.report(new Error('😀'.repeat(32768) + '\nfinal backend failure'))
  for (const [options] of operations.show.mock.calls) {
    expect(options.detail!.length).toBeLessThanOrEqual(1200)
    expect(options.detail!.split('\n').length).toBeLessThanOrEqual(12)
    expect(options.detail).toContain(operations.messages().diagnosticTruncated)
    expect(options.detail).toContain(operations.messages().startupReinstallAdvice)
    expect(options.detail!.isWellFormed()).toBe(true)
  }
  expect(operations.show.mock.calls[0]![0].detail).toContain('final backend failure')
  expect(operations.show.mock.calls[1]![0].detail).toContain('final write failure')
})
