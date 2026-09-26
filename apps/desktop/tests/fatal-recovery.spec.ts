import { afterEach, expect, it, vi } from 'vitest'
import type { MessageBoxOptions } from 'electron'
import { CRASH_REPORT_WAIT_MS, DesktopFatalRecovery } from '../src/fatal-recovery.ts'
import type { CrashReportSource } from '../src/crash-report.ts'
import { resolveDesktopLocale } from '../src/locale.ts'

function fixture(
  locale = 'en',
  writeReport: (error: unknown, source: CrashReportSource) => Promise<string | undefined> = async () => undefined,
) {
  const choice = Promise.withResolvers<{ response: number; checkboxChecked: boolean }>()
  const stopped = Promise.withResolvers<undefined>()
  const operations = {
    messages: () => resolveDesktopLocale(locale).messages,
    show: vi.fn((_options: MessageBoxOptions) => choice.promise),
    stop: vi.fn(() => stopped.promise),
    disablePlugins: vi.fn(async () => {}),
    exit: vi.fn(),
    restart: vi.fn(),
    writeReport: vi.fn(writeReport),
  }
  return { operations, choice, stopped, recovery: new DesktopFatalRecovery(operations) }
}

/** The dialog opens only after the report write settles, so tests wait for the first show() call. */
async function shown(operations: { show: ReturnType<typeof vi.fn> }): Promise<void> {
  await vi.waitFor(() => { expect(operations.show).toHaveBeenCalled() })
}

const REPORT_PATH = 'C:\\Users\\someone\\AppData\\Roaming\\DeepSeek Harness\\logs\\crash-2026-09-22T10-30-00-000Z-host.log'

afterEach(() => { vi.restoreAllMocks() })

it.each(['en', 'zh-CN'])('offers only exit and restart for a listener conflict in %s', async (locale) => {
  const { operations, choice, stopped, recovery } = fixture(locale)
  const pending = recovery.report(new AggregateError([
    new Error('webserver (@deepseek-ai/dsh-host-webserver): Error: listen EADDRINUSE: address already in use 127.0.0.1:19387'),
  ], 'required startup failure'), 'host')
  await shown(operations)
  const options = operations.show.mock.calls[0]![0]
  expect(options.buttons).toEqual([operations.messages().exitApplication, operations.messages().restartApplication])
  await expect([options.title, options.message, options.detail, ...options.buttons!].join('\n') + '\n')
    .toMatchFileSnapshot(`expected/fatal-address-in-use-${locale}.txt`)
  choice.resolve({ response: 1, checkboxChecked: false })
  stopped.resolve(undefined)
  await pending
  expect(operations.restart).toHaveBeenCalledOnce()
  expect(operations.disablePlugins).not.toHaveBeenCalled()
})

it.each(['win32', 'darwin', 'linux'] as const)('offers the same listener conflict recovery on %s', async (platform) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  const { operations, choice, stopped, recovery } = fixture()
  const pending = recovery.report(new Error('listen EADDRINUSE: address already in use'), 'main')
  await shown(operations)
  expect(operations.show.mock.calls[0]![0].buttons).toEqual([
    operations.messages().exitApplication, operations.messages().restartApplication,
  ])
  expect(operations.show.mock.calls[0]![0].detail).toBe(operations.messages().startupAddressInUse)
  choice.resolve({ response: 0, checkboxChecked: false })
  stopped.resolve(undefined)
  await pending
})

it.each(['en', 'zh-CN'])('records the %s native recovery dialog', async (locale) => {
  const { operations, choice, stopped, recovery } = fixture(locale)
  const pending = recovery.report(new AggregateError([new Error('Plugin initialization failed')], 'Desktop Host failed'), 'main')
  await shown(operations)
  const options = operations.show.mock.calls[0]![0]
  await expect([options.title, options.message, options.detail, ...options.buttons!].join('\n') + '\n')
    .toMatchFileSnapshot(`expected/fatal-dialog-${locale}.txt`)
  choice.resolve({ response: 0, checkboxChecked: false })
  stopped.resolve(undefined)
  await pending
})

it('locks the first report before the dialog settles and never resets after an action', async () => {
  const { operations, choice, stopped, recovery } = fixture()
  const pending = recovery.report(new Error('first failure'), 'main')
  await shown(operations)
  await recovery.report(new Error('second failure'), 'main')
  expect(operations.show).toHaveBeenCalledOnce()
  expect(operations.show.mock.calls[0]![0].detail).toContain('first failure')
  choice.resolve({ response: 1, checkboxChecked: false })
  stopped.resolve(undefined)
  await pending
  await recovery.report(new Error('third failure'), 'main')
  expect(operations.show).toHaveBeenCalledOnce()
})

it.each([0, 1, 2])('waits for shutdown before executing choice %s', async (response) => {
  const { operations, choice, stopped, recovery } = fixture()
  const stopping = Promise.withResolvers<undefined>()
  operations.stop.mockImplementation(() => { stopping.resolve(undefined); return stopped.promise })
  const pending = recovery.report(new Error('fatal'), 'main')
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
  await recovery.report(new Error('fatal'), 'main')
  expect(operations.show).toHaveBeenCalledTimes(2)
  expect(operations.show.mock.calls[1]![0].detail).toContain('profile is read-only')
  expect(operations.restart).not.toHaveBeenCalled()
  expect(operations.exit).toHaveBeenCalledOnce()
})

it('allows exit after shutdown cleanup fails', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const { operations, choice, stopped, recovery } = fixture()
  const pending = recovery.report(new Error('fatal'), 'main')
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
  await recovery.report(new Error('😀'.repeat(32768) + '\nfinal backend failure'), 'main')
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

it.each(['en', 'zh-CN'])('names the report file even when the error is short enough to show whole, in %s', async (locale) => {
  const { operations, choice, stopped, recovery } = fixture(locale, async () => REPORT_PATH)
  const pending = recovery.report(new Error('Desktop Host failed\nPlugin initialization failed'), 'host')
  await shown(operations)
  await vi.waitFor(() => { expect(operations.show).toHaveBeenCalledOnce() })
  expect(operations.writeReport).toHaveBeenCalledWith(expect.any(Error), 'host')
  const options = operations.show.mock.calls[0]![0]
  expect(options.detail).not.toContain(operations.messages().diagnosticTruncated)
  expect(options.detail).toContain(REPORT_PATH)
  await expect([options.title, options.message, options.detail, ...options.buttons!].join('\n') + '\n')
    .toMatchFileSnapshot(`expected/fatal-dialog-with-report-${locale}.txt`)
  choice.resolve({ response: 0, checkboxChecked: false })
  stopped.resolve(undefined)
  await pending
})

it('keeps the report line inside the detail budget when the error is long', async () => {
  const { operations, choice, stopped, recovery } = fixture('en', async () => REPORT_PATH)
  const pending = recovery.report(new Error('😀'.repeat(32768) + '\nfinal backend failure'), 'web-boot')
  await shown(operations)
  await vi.waitFor(() => { expect(operations.show).toHaveBeenCalledOnce() })
  const detail = operations.show.mock.calls[0]![0].detail!
  expect(detail.length).toBeLessThanOrEqual(1200)
  expect(detail.split('\n').length).toBeLessThanOrEqual(12)
  expect(detail.isWellFormed()).toBe(true)
  expect(detail).toContain(operations.messages().diagnosticTruncated)
  expect(detail).toContain('final backend failure')
  expect(detail).toContain(REPORT_PATH)
  expect(detail.indexOf(REPORT_PATH)).toBeLessThan(detail.indexOf(operations.messages().startupReinstallAdvice))
  choice.resolve({ response: 0, checkboxChecked: false })
  stopped.resolve(undefined)
  await pending
})

it('names the report file in the listener-conflict dialog too', async () => {
  const { operations, choice, stopped, recovery } = fixture('en', async () => REPORT_PATH)
  const pending = recovery.report(new Error('listen EADDRINUSE: address already in use 127.0.0.1:19387'), 'host')
  await shown(operations)
  await vi.waitFor(() => { expect(operations.show).toHaveBeenCalledOnce() })
  const options = operations.show.mock.calls[0]![0]
  expect(options.buttons).toHaveLength(2)
  expect(options.detail).toBe(`${operations.messages().startupAddressInUse}\n${operations.messages().reportWrittenTo.replace('{path}', REPORT_PATH)}`)
  choice.resolve({ response: 0, checkboxChecked: false })
  stopped.resolve(undefined)
  await pending
})

it('shows the dialog without a path when the report write fails or returns nothing', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  for (const writeReport of [async () => undefined, async () => { throw new Error('disk full') }]) {
    const { operations, choice, stopped, recovery } = fixture('en', writeReport)
    const pending = recovery.report(new Error('fatal'), 'main')
    await shown(operations)
    await vi.waitFor(() => { expect(operations.show).toHaveBeenCalledOnce() })
    expect(operations.show.mock.calls[0]![0].detail).toBe(`fatal\n\n${operations.messages().startupReinstallAdvice}`)
    choice.resolve({ response: 0, checkboxChecked: false })
    stopped.resolve(undefined)
    await pending
  }
})

it('does not wait longer than the report deadline before showing the dialog', async () => {
  vi.useFakeTimers()
  try {
    const { operations, choice, stopped, recovery } = fixture('en', () => new Promise<string>(() => {}))
    const pending = recovery.report(new Error('fatal'), 'main')
    await vi.advanceTimersByTimeAsync(CRASH_REPORT_WAIT_MS - 1)
    expect(operations.show).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(operations.show).toHaveBeenCalledOnce()
    expect(operations.show.mock.calls[0]![0].detail).not.toContain('crash-')
    choice.resolve({ response: 0, checkboxChecked: false })
    stopped.resolve(undefined)
    await pending
  } finally {
    vi.useRealTimers()
  }
})

it('writes the report once for the first fatal failure and not for the recovery-failure redisplay', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const { operations, stopped, recovery } = fixture('en', async () => REPORT_PATH)
  operations.show.mockResolvedValueOnce({ response: 2, checkboxChecked: false })
    .mockResolvedValueOnce({ response: 0, checkboxChecked: false })
  operations.disablePlugins.mockRejectedValueOnce(new Error('profile is read-only'))
  stopped.resolve(undefined)
  await recovery.report(new Error('fatal'), 'host')
  expect(operations.show).toHaveBeenCalledTimes(2)
  expect(operations.writeReport).toHaveBeenCalledOnce()
  expect(operations.show.mock.calls[1]![0].detail).toContain(REPORT_PATH)
})
