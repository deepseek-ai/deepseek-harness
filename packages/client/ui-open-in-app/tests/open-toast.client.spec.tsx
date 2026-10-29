// @vitest-environment jsdom
/** Mobile handoff feedback and native-open failures rendered outside the initiating panel. */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import {
  OpenInAppToast,
  type OpenInAppToastProps, type OpenInAppToastState,
} from '../src/client/open-toast.tsx'
import { en, ja, es, fr, de, ru, pt, zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

function mount(state: OpenInAppToastState | null, dictionary: typeof en | typeof zh = en) {
  const dismiss = vi.fn()
  const props = {
    useToast: <T,>(select: (value: OpenInAppToastState | null) => T): T => select(state),
    dismiss,
    t: makeTranslate(dictionary),
  } as OpenInAppToastProps
  return { view: render(<OpenInAppToast {...props} />), dismiss }
}

describe('open-in-app toast source', () => {
  it.each([
    ['iPhone', 'iPhone', 'iPhone', 5, 390, true],
    ['Android', 'Android', 'Linux armv8l', 5, 390, true],
    ['desktop-mode iPad', 'Macintosh', 'MacIntel', 5, 1024, true],
    ['desktop browser', 'Macintosh', 'MacIntel', 0, 1280, false],
    ['narrow desktop browser', 'Macintosh', 'MacIntel', 0, 390, false],
    ['touch Windows desktop', 'Windows NT', 'Win32', 10, 1280, false],
    ['Electron desktop', 'Macintosh Electron', 'MacIntel', 0, 1280, false],
  ] as const)('announces successes only for mobile devices: %s', async (_device, userAgent, platform, maxTouchPoints, width, mobile) => {
    vi.resetModules()
    vi.stubGlobal('navigator', { userAgent, platform, maxTouchPoints })
    vi.stubGlobal('innerWidth', width)
    const { createOpenInAppToastSource } = await import('../src/client/open-toast.tsx')
    const source = createOpenInAppToastSource()
    const listener = vi.fn()
    const stop = source.hooks.toast.subscribe(listener)
    expect(source.hooks.toast.getSnapshot()).toBeNull()

    source.report({ kind: 'skipped' })
    expect(listener).not.toHaveBeenCalled()
    expect(source.hooks.toast.getSnapshot()).toBeNull()

    source.report({ kind: 'opened' })
    expect(source.hooks.toast.getSnapshot()).toEqual(mobile ? { kind: 'opened', seq: 1 } : null)
    source.report({ kind: 'revealed' })
    expect(source.hooks.toast.getSnapshot()).toEqual(mobile ? { kind: 'revealed', seq: 2 } : null)
    const previous = source.hooks.toast.getSnapshot()
    source.report({ kind: 'skipped' })
    expect(source.hooks.toast.getSnapshot()).toBe(previous)

    source.report({ kind: 'failed', failure: 'openError' })
    expect(source.hooks.toast.getSnapshot()).toEqual({ kind: 'failed', failure: 'openError', seq: mobile ? 3 : 1 })
    source.report({ kind: 'failed', failure: 'revealError' })
    expect(source.hooks.toast.getSnapshot()).toEqual({ kind: 'failed', failure: 'revealError', seq: mobile ? 4 : 2 })
    if (!mobile) {
      source.report({ kind: 'opened' })
      expect(source.hooks.toast.getSnapshot()).toEqual({ kind: 'failed', failure: 'revealError', seq: 2 })
    }
    source.dismiss()
    expect(source.hooks.toast.getSnapshot()).toBeNull()
    expect(listener).toHaveBeenCalledTimes(mobile ? 5 : 3)

    stop()
    source.report({ kind: 'failed', failure: 'openError' })
    expect(listener).toHaveBeenCalledTimes(mobile ? 5 : 3)
  })
})

describe('OpenInAppToast', () => {
  it('renders nothing while no outcome shows', () => {
    mount(null)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows where the acknowledged open happened and dismisses once it has faded', () => {
    vi.useFakeTimers()
    const { dismiss } = mount({ kind: 'opened', seq: 1 })
    expect(screen.getByRole('alert').textContent).toBe('Opened on another device')
    act(() => { vi.runAllTimers() })
    expect(dismiss).toHaveBeenCalledOnce()
  })

  it('shows the other-device confirmation in Chinese', () => {
    mount({ kind: 'opened', seq: 1 }, zh)
    expect(screen.getByRole('alert').textContent).toBe('已在其它设备打开')
  })

  it.each([
    ['en', en], ['zh', zh], ['ja', ja], ['es', es],
    ['fr', fr], ['de', de], ['ru', ru], ['pt', pt],
  ] as const)('localizes the other-device file-location confirmation: %s', (_locale, dictionary) => {
    mount({ kind: 'revealed', seq: 2 }, dictionary)
    expect(screen.getByRole('alert').textContent).toBe(dictionary['path.revealed'])
  })

  it('shows the warning banner for a failed open and for a failed reveal', () => {
    mount({ kind: 'failed', failure: 'openError', seq: 3 })
    expect(screen.getByRole('alert').textContent).toBe(en['path.openError'])
    cleanup()
    mount({ kind: 'failed', failure: 'revealError', seq: 4 }, zh)
    expect(screen.getByRole('alert').textContent).toBe(zh['path.revealError'])
  })
})
