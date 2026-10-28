// @vitest-environment jsdom
/**
 * The two document-preview path controls: hidden until the Host reports a
 * desktop, busy only for their own gesture, and reporting each settled outcome
 * once to the app-wide announcement seat instead of rendering one itself.
 */
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { OpenPathAction, type OpenPathActionProps } from '../src/client/OpenPathAction.tsx'
import { OpenPathEmptyAction, type OpenPathEmptyActionProps } from '../src/client/OpenPathEmptyAction.tsx'
import type { OpenInAppPathAction } from '../src/client/open-path.ts'
import type { OpenInAppOutcome } from '../src/client/outcome.ts'
import { useOpenTargetGesture } from '../src/client/OpenTargetButton.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const t = makeTranslate(zh)
const ABSOLUTE_PATH = '/host/project/work/clip.mp4'

interface Bench {
  props: OpenPathActionProps & OpenPathEmptyActionProps
  desktop: ReturnType<typeof createSnapshotStore<boolean | null>>
  loadDesktop: ReturnType<typeof vi.fn>
  openPath: ReturnType<typeof vi.fn<(path: string, action: OpenInAppPathAction) => Promise<OpenInAppOutcome>>>
  report: Mock<(outcome: OpenInAppOutcome) => void>
}

function bench(over: { desktop?: boolean | null; openPath?: Bench['openPath'] } = {}): Bench {
  const desktop = createSnapshotStore<boolean | null>(over.desktop === undefined ? true : over.desktop)
  const loadDesktop = vi.fn(async () => {})
  const openPath = over.openPath ?? vi.fn(async (): Promise<OpenInAppOutcome> => ({ kind: 'opened' }))
  const report = vi.fn<(outcome: OpenInAppOutcome) => void>()
  function useSelector<T, R>(source: { getSnapshot(): T }): (select: (value: T) => R) => R {
    return select => select(source.getSnapshot())
  }
  const props = {
    absolutePath: ABSOLUTE_PATH,
    useOpenInAppDesktop: useSelector(desktop),
    loadDesktop,
    applications: vi.fn(async () => [{ id: '/Music.app', name: 'Music', default: true, icon: null }]),
    openPath,
    report,
    t,
  } as Bench['props']
  return { props, desktop, loadDesktop, openPath, report }
}

describe('OpenPathAction visibility', () => {
  it('renders nothing and asks for the desktop answer while it is unknown, and nothing without a desktop', () => {
    const unknown = bench({ desktop: null })
    const { container } = render(<OpenPathAction {...unknown.props} />)
    expect(container.innerHTML).toBe('')
    expect(unknown.loadDesktop).toHaveBeenCalledOnce()
    cleanup()
    const absent = bench({ desktop: false })
    expect(render(<OpenPathAction {...absent.props} />).container.innerHTML).toBe('')
    expect(absent.loadDesktop).not.toHaveBeenCalled()
  })
})

describe('OpenPathAction gestures', () => {
  it('opens the file in its default application from the main button and reveals it from the menu', async () => {
    const b = bench()
    render(<OpenPathAction {...b.props} />)
    const main = await screen.findByRole('button', { name: t('open.title', { app: 'Music' }) })
    await act(async () => { fireEvent.click(main) })
    expect(b.openPath).toHaveBeenLastCalledWith(ABSOLUTE_PATH, 'open', undefined)
    fireEvent.click(screen.getByRole('button', { name: zh['path.more'] }))
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: zh['path.reveal'] })) })
    expect(b.openPath).toHaveBeenLastCalledWith(ABSOLUTE_PATH, 'reveal', undefined)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('offers the default application from the menu too, and Escape closes the menu without a gesture', async () => {
    const b = bench()
    render(<OpenPathAction {...b.props} />)
    await act(async () => {})
    const more = screen.getByRole('button', { name: zh['path.more'] })
    fireEvent.click(more)
    expect(more.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(b.openPath).not.toHaveBeenCalled()
    fireEvent.click(more)
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Music（默认）' })) })
    expect(b.openPath).toHaveBeenLastCalledWith(ABSOLUTE_PATH, 'open', '/Music.app')
  })

  it('disables both halves while its own gesture settles and reports the failure it settled on', async () => {
    const settled = Promise.withResolvers<OpenInAppOutcome>()
    const b = bench({ openPath: vi.fn(() => settled.promise) })
    const { container } = render(<OpenPathAction {...b.props} />)
    const main = await screen.findByRole('button', { name: t('open.title', { app: 'Music' }) })
    fireEvent.click(main)
    expect(main).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: zh['path.more'] })).toHaveProperty('disabled', true)
    expect(container.querySelector('[data-open-path]')?.getAttribute('data-state')).toBe('busy')
    fireEvent.click(main)
    expect(b.openPath).toHaveBeenCalledOnce()
    await act(async () => { settled.resolve({ kind: 'failed', failure: 'openError' }); await settled.promise })
    expect(main).toHaveProperty('disabled', false)
    expect(container.querySelector('[data-open-path]')?.getAttribute('data-state')).toBe('idle')
    expect(b.report).toHaveBeenCalledTimes(1)
    expect(b.report).toHaveBeenCalledWith({ kind: 'failed', failure: 'openError' })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('OpenPathEmptyAction', () => {
  it('renders nothing without a desktop and opens the file in its default application with one', async () => {
    const absent = bench({ desktop: false })
    expect(render(<OpenPathEmptyAction {...absent.props} />).container.innerHTML).toBe('')
    cleanup()
    const b = bench()
    render(<OpenPathEmptyAction {...b.props} />)
    await act(async () => {})
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['path.open'] })) })
    expect(b.openPath).toHaveBeenCalledWith(ABSOLUTE_PATH, 'open', undefined)
    expect(b.report).toHaveBeenCalledWith({ kind: 'opened' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports an acknowledged reveal and a failed open to the announcement seat, rendering none itself', async () => {
    const revealed = bench({ openPath: vi.fn(async (): Promise<OpenInAppOutcome> => ({ kind: 'revealed' })) })
    render(<OpenPathEmptyAction {...revealed.props} applications={async () => []} />)
    await act(async () => {})
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['path.reveal'] })) })
    expect(revealed.report).toHaveBeenCalledWith({ kind: 'revealed' })
    cleanup()

    const b = bench({ openPath: vi.fn(async (): Promise<OpenInAppOutcome> => ({ kind: 'failed', failure: 'openError' })) })
    render(<OpenPathEmptyAction {...b.props} />)
    await act(async () => {})
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['path.open'] })) })
    expect(b.report).toHaveBeenCalledTimes(1)
    expect(b.report).toHaveBeenCalledWith({ kind: 'failed', failure: 'openError' })
    // The banner belongs to this plugin's overlay entry, which outlives the control.
    expect(screen.queryByRole('alert')).toBeNull()
  })
})


it('shows the default icon and current application list, and selects an application without replacing default opening', async () => {
  const b = bench()
  const icon = 'data:image/png;base64,aGVsbG8='
  const applications = vi.fn(async () => [
    { id: '/Music.app', name: 'Music', default: true, icon },
    { id: '/Player.app', name: 'Player', default: false, icon: null },
  ])
  const view = render(<OpenPathAction {...b.props} applications={applications} />)
  await act(async () => {})
  expect(view.container.querySelector('[data-open-path-open] img')?.getAttribute('src')).toBe(icon)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['path.more'] })) })
  expect(screen.getByRole('menuitem', { name: 'Music（默认）' })).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Player' })) })
  expect(b.openPath).toHaveBeenLastCalledWith(ABSOLUTE_PATH, 'open', '/Player.app')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('open.title', { app: 'Music' }) })) })
  expect(b.openPath).toHaveBeenLastCalledWith(ABSOLUTE_PATH, 'open', undefined)
})


it('ignores an obsolete file query and refreshes the default application when the menu opens', async () => {
  const b = bench()
  const old = Promise.withResolvers<readonly { id: string; name: string; default: boolean; icon: null }[]>()
  const applications = vi.fn<OpenPathActionProps['applications']>()
    .mockImplementationOnce(() => old.promise)
    .mockResolvedValue([{ id: '/Player.app', name: 'Player', default: true, icon: null }])
  const view = render(<OpenPathAction {...b.props} applications={applications} />)
  view.rerender(<OpenPathAction {...b.props} absolutePath="/other.mp3" applications={applications} />)
  await act(async () => { old.resolve([{ id: '/Old.app', name: 'Old', default: true, icon: null }]) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['path.more'] })) })
  expect(screen.queryByRole('menuitem', { name: 'Old（默认）' })).toBeNull()
  expect(screen.getByRole('menuitem', { name: 'Player（默认）' })).toBeTruthy()
  expect(applications.mock.calls[0]![1].aborted).toBe(true)
  expect(applications).toHaveBeenLastCalledWith('/other.mp3', expect.any(AbortSignal))
})

it('keeps reveal last and makes it the default when the file query fails', async () => {
  const b = bench()
  render(<OpenPathAction {...b.props} applications={async () => null} />)
  await act(async () => {})
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['path.more'] })) })
  const items = screen.getAllByRole('menuitem')
  expect(items.map(item => item.textContent)).toEqual([zh['path.appsError'], '显示文件位置（默认）'])
  expect(items[0]).toHaveProperty('disabled', true)
  await act(async () => { fireEvent.click(items[1]!) })
  expect(b.openPath).toHaveBeenLastCalledWith(ABSOLUTE_PATH, 'reveal', undefined)
})

it('opens with the first registered application when none is marked default', async () => {
  const b = bench()
  render(<OpenPathAction {...b.props} applications={async () => [{ id: '/Player.app', name: 'Player', default: false, icon: null }]} />)
  await act(async () => {})
  const main = screen.getByRole('button', { name: t('open.title', { app: 'Player' }) })
  await act(async () => { fireEvent.click(main) })
  expect(b.openPath).toHaveBeenLastCalledWith(ABSOLUTE_PATH, 'open', '/Player.app')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['path.more'] })) })
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Player（默认）', zh['path.reveal']])
})

it('uses reveal as the default only when no application is registered', async () => {
  const b = bench()
  render(<OpenPathAction {...b.props} applications={async () => []} />)
  await act(async () => {})
  expect(screen.queryByRole('button', { name: zh['path.more'] })).toBeNull()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['path.reveal'] })) })
  expect(b.openPath).toHaveBeenLastCalledWith(ABSOLUTE_PATH, 'reveal', undefined)
})


it('coalesces repeated gestures before the busy state renders', async () => {
  const pending = Promise.withResolvers<OpenInAppOutcome>()
  const b = bench({ openPath: vi.fn(() => pending.promise) })
  const { result } = renderHook(() => useOpenTargetGesture(() => b.openPath(ABSOLUTE_PATH, 'open'), b.report))
  act(() => { result.current.act({ kind: 'default' }); result.current.act({ kind: 'default' }) })
  expect(b.openPath).toHaveBeenCalledOnce()
  expect(b.report).not.toHaveBeenCalled()
  await act(async () => { pending.resolve({ kind: 'opened' }) })
  expect(result.current.pending).toBe(false)
  expect(b.report).toHaveBeenCalledOnce()
  expect(b.report).toHaveBeenCalledWith({ kind: 'opened' })
})


it('closes the application menu from its chevron without querying again', async () => {
  const b = bench()
  render(<OpenPathAction {...b.props} />)
  await act(async () => {})
  const more = screen.getByRole('button', { name: zh['path.more'] })
  await act(async () => { fireEvent.click(more) })
  expect(screen.getByRole('menu')).toBeTruthy()
  const calls = vi.mocked(b.props.applications).mock.calls.length
  await act(async () => { fireEvent.click(more) })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(b.props.applications).toHaveBeenCalledTimes(calls)
})


it('waits for the file association query before allowing a default action', async () => {
  const b = bench()
  const query = Promise.withResolvers<Awaited<ReturnType<OpenPathActionProps['applications']>>>()
  const view = render(<OpenPathAction {...b.props} applications={() => query.promise} />)
  const main = view.container.querySelector('[data-open-path-open]')!
  expect(main).toHaveProperty('disabled', true)
  fireEvent.click(main)
  expect(b.openPath).not.toHaveBeenCalled()
  await act(async () => { query.resolve([]) })
  expect(main).toHaveProperty('disabled', false)
  await act(async () => { fireEvent.click(main) })
  expect(b.openPath).toHaveBeenLastCalledWith(ABSOLUTE_PATH, 'reveal', undefined)
})


it('uses the same application menu in the prominent empty-state control', async () => {
  const b = bench()
  const view = render(<OpenPathEmptyAction {...b.props} />)
  await act(async () => {})
  expect(view.container.querySelector('[data-open-target]')?.getAttribute('data-size')).toBe('large')
  // The large control scales the menu chevron up from the compact 10px glyph.
  expect(screen.getByRole('button', { name: zh['path.more'] }).querySelector('svg')?.getAttribute('width')).toBe('14')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['path.more'] })) })
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Music（默认）', zh['path.reveal']])
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Music（默认）' })) })
  expect(b.openPath).toHaveBeenLastCalledWith(ABSOLUTE_PATH, 'open', '/Music.app')
})

it('labels the prominent default action as reveal when no application is registered', async () => {
  const b = bench()
  render(<OpenPathEmptyAction {...b.props} applications={async () => []} />)
  await act(async () => {})
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['path.reveal'] })) })
  expect(b.openPath).toHaveBeenLastCalledWith(ABSOLUTE_PATH, 'reveal', undefined)
})


it('uses a skeleton while associations load and pins reveal outside the application list', async () => {
  const b = bench()
  const pending = Promise.withResolvers<readonly { id: string; name: string; default: boolean; icon: null }[]>()
  const view = render(<OpenPathAction {...b.props} applications={() => pending.promise} />)
  expect(view.container.querySelector('[data-open-target-skeleton]')).not.toBeNull()
  expect(view.container.querySelector('[data-open-path-open] svg')).toBeNull()
  await act(async () => { pending.resolve([{ id: 'music', name: 'Music', default: true, icon: null }]) })
  expect(view.container.querySelector('[data-open-target-skeleton]')).toBeNull()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['path.more'] })) })
  const menu = screen.getByRole('menu')
  const reveal = screen.getByRole('menuitem', { name: zh['path.reveal'] })
  expect(menu.firstElementChild?.contains(reveal)).toBe(false)
  expect(menu.lastElementChild?.contains(reveal)).toBe(true)
})
