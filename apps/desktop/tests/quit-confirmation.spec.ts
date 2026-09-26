import type { MessageBoxOptions, MessageBoxReturnValue, NativeImage } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopQuitInspection } from '../src/host-process.ts'
import { resolveDesktopLocale } from '../src/locale.ts'
import { DesktopQuitConfirmation, resolveDesktopQuitPrompt } from '../src/quit-confirmation.ts'

afterEach(() => { vi.restoreAllMocks() })

function setup(platform: NodeJS.Platform, inspect: () => Promise<DesktopQuitInspection> | undefined, locale = 'zh') {
  const shown: MessageBoxOptions[] = []
  let answer: MessageBoxReturnValue = { response: 0, checkboxChecked: false }
  const focus = vi.fn()
  const icon: NativeImage = { isEmpty: () => false } as never
  const confirmation = new DesktopQuitConfirmation({
    locale: () => resolveDesktopLocale(locale), inspect, focus, platform, icon,
    show: async (options) => { shown.push(options); return answer },
  })
  return { confirmation, shown, focus, icon, answer: (value: number) => { answer = { response: value, checkboxChecked: false } } }
}

describe('quit prompt selection', () => {
  it.each([
    [{ activeTasks: false, scheduledTasks: false }, undefined],
    [{ activeTasks: true, scheduledTasks: false }, 'quitActiveTasks'],
    [{ activeTasks: false, scheduledTasks: true }, 'quitScheduledTasks'],
    [{ activeTasks: true, scheduledTasks: true }, 'quitActiveAndScheduledTasks'],
    ['unknown', 'quitActiveTasks'],
  ] as const)('maps %j to %s', (inspection, prompt) => {
    expect(resolveDesktopQuitPrompt(inspection)).toBe(prompt)
  })
})

describe('DesktopQuitConfirmation', () => {
  it('quits silently when nothing is running and no Host is ready', async () => {
    const idle = setup('darwin', async () => ({ activeTasks: false, scheduledTasks: false }))
    expect(await idle.confirmation.confirm()).toBe(true)
    const starting = setup('darwin', () => undefined)
    expect(await starting.confirmation.confirm()).toBe(true)
    expect([...idle.shown, ...starting.shown]).toEqual([])
  })

  it('shows the macOS alert with the warning icon, Chinese copy, and Quit as the default right-hand button', async () => {
    const f = setup('darwin', async () => ({ activeTasks: true, scheduledTasks: true }))
    expect(await f.confirmation.confirm()).toBe(true)
    expect(f.shown).toEqual([{
      type: 'warning', title: 'DeepSeek Harness', message: '退出 DeepSeek Harness？',
      detail: '当前正在运行的任务将会中断，且应用关闭期间，定时任务不会运行',
      buttons: ['退出', '取消'], defaultId: 0, cancelId: 1, noLink: true,
    }])
  })

  it('shows the Windows task dialog with the application icon and plain buttons in English', async () => {
    const f = setup('win32', async () => ({ activeTasks: false, scheduledTasks: true }), 'en')
    f.answer(1)
    expect(await f.confirmation.confirm()).toBe(false)
    expect(f.shown).toEqual([{
      type: 'none', icon: f.icon, title: 'DeepSeek Harness', message: 'Quit DeepSeek Harness?',
      detail: 'Scheduled tasks will not run while the app is closed.',
      buttons: ['Quit', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true,
    }])
  })

  it('warns about running tasks when the inspection fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = setup('darwin', async () => { throw new Error('desktop quit: inspection timed out') })
    f.answer(1)
    expect(await f.confirmation.confirm()).toBe(false)
    expect(f.shown.map(options => options.detail)).toEqual(['当前正在运行的任务将会中断'])
    expect(console.warn).toHaveBeenCalledWith('desktop quit: task inspection unavailable', expect.any(Error))
  })

  it('joins an open confirmation instead of stacking a second one and inspects once per decision', async () => {
    const inspected = Promise.withResolvers<DesktopQuitInspection>()
    const inspect = vi.fn(() => inspected.promise)
    const f = setup('darwin', inspect)
    const first = f.confirmation.confirm()
    const second = f.confirmation.confirm()
    expect(second).toBe(first)
    expect(f.focus).toHaveBeenCalledOnce()
    expect(inspect).toHaveBeenCalledOnce()
    inspected.resolve({ activeTasks: true, scheduledTasks: false })
    expect(await first).toBe(true)
    expect(f.shown).toHaveLength(1)
    // The decision is closed: the next request starts a fresh inspection.
    expect(f.confirmation.confirm()).not.toBe(first)
    expect(inspect).toHaveBeenCalledTimes(2)
  })

  it('resolves a pending decision to false without a box once disposed, and refuses later requests', async () => {
    const inspected = Promise.withResolvers<DesktopQuitInspection>()
    const f = setup('darwin', () => inspected.promise)
    const pending = f.confirmation.confirm()
    f.confirmation.dispose()
    inspected.resolve({ activeTasks: true, scheduledTasks: false })
    expect(await pending).toBe(false)
    expect(f.shown).toEqual([])
    expect(await f.confirmation.confirm()).toBe(false)
    expect(f.focus).not.toHaveBeenCalled()
  })

  it('does not approve a quit from a box answered after disposal', async () => {
    const answered = Promise.withResolvers<MessageBoxReturnValue>()
    const confirmation = new DesktopQuitConfirmation({
      locale: () => resolveDesktopLocale('en'), inspect: async () => ({ activeTasks: true, scheduledTasks: false }),
      focus: () => {}, platform: 'darwin', show: () => answered.promise,
    })
    const pending = confirmation.confirm()
    await Promise.resolve()
    confirmation.dispose()
    answered.resolve({ response: 0, checkboxChecked: false })
    expect(await pending).toBe(false)
  })
})
