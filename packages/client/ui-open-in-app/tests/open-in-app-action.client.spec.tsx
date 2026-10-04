// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ShortcutCatalogEntry, ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import { OpenInAppAction, type OpenInAppActionProps } from '../src/client/OpenInAppAction.tsx'
import { OpenInAppController } from '../src/client/controller.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const t: OpenInAppActionProps['t'] = makeTranslate(zh)

interface Bench {
  props: OpenInAppActionProps
  launch: ReturnType<typeof vi.fn>
  choose: ReturnType<typeof vi.fn>
}

function bench(over: {
  apps?: readonly string[] | null
  choice?: string
  absolutePath?: string
  shortcuts?: readonly ShortcutCatalogEntry[]
  launch?: (appId: string, path: string) => Promise<void>
} = {}): Bench {
  const apps = createSnapshotStore<readonly string[] | null>(over.apps ?? null)
  const choice = createSnapshotStore<string>(over.choice ?? '')
  const controller = new OpenInAppController(async (_input, init) => {
    const request = JSON.parse(init?.body as string) as { app: string; path: string }
    await over.launch?.(request.app, request.path)
    return new Response('', { status: 200 })
  })
  const launch = vi.fn((appId: string, path: string) => controller.launch(appId, path))
  const choose = vi.fn()
  const props: OpenInAppActionProps = {
    absolutePath: over.absolutePath ?? '/w',
    useOpenInAppApps: bindSnapshotSelector(apps),
    useOpenInAppChoice: bindSnapshotSelector(choice),
    useOpenInAppLaunch: bindSnapshotSelector(controller.operation),
    useShortcuts: bindSnapshotSelector(createSnapshotStore(over.shortcuts ?? [])),
    launch,
    choose,
    iconUrl: (appId: string) => `open-in-app/icon/${appId}`,
    t,
  }
  return { props, launch, choose }
}

describe('OpenInAppAction visibility', () => {
  it('advertises the configured workspace accelerator', () => {
    render(<OpenInAppAction {...bench({ apps: ['finder'], absolutePath: '/w', shortcuts: [{
      id: 'workspace.openLocal' as ShortcutCommandId, label: 'Open', aliases: [], binding: null,
      keys: ['Ctrl', 'O'], aria: 'Control+O', modified: true, conflicts: [], issue: null,
    }] }).props} />)
    expect(screen.getByRole('button', { name: t('open.title', { app: zh['app.finder'] }) }).getAttribute('aria-keyshortcuts')).toBe('Control+O')
  })
  it('renders nothing before availability arrives, with no apps, and for unnameable ids', () => {
    for (const over of [
      { apps: null, absolutePath: '/w' },
      { apps: [], absolutePath: '/w' },
      { apps: [], choice: 'vscode', absolutePath: '/w' },
      { apps: ['someday-an-app'], absolutePath: '/w' },
    ] as const) {
      const { container } = render(<OpenInAppAction {...bench(over).props} />)
      expect(container.innerHTML).toBe('')
      cleanup()
    }
  })

  it('shows the remembered choice, falling back to the first available app when it is gone', () => {
    render(<OpenInAppAction {...bench({ apps: ['finder', 'cursor'], choice: 'cursor', absolutePath: '/w' }).props} />)
    expect(screen.getByRole('button', { name: t('open.title', { app: 'Cursor' }) }).querySelector('img')?.getAttribute('src')).toBe('open-in-app/icon/cursor')
    cleanup()

    render(<OpenInAppAction {...bench({ apps: ['finder', 'cursor'], choice: 'vscode', absolutePath: '/w' }).props} />)
    expect(screen.getByRole('button', { name: t('open.title', { app: zh['app.finder'] }) }).querySelector('img')?.getAttribute('src')).toBe('open-in-app/icon/finder')
  })
})

describe('OpenInAppAction launching', () => {
  it('disables both buttons and ignores duplicate gestures until the launch settles', async () => {
    const pending = Promise.withResolvers<undefined>()
    const b = bench({ apps: ['finder', 'cursor'], absolutePath: '/w/dir', launch: () => pending.promise })
    const view = render(<OpenInAppAction {...b.props} />)
    const main = screen.getByRole('button', { name: t('open.title', { app: zh['app.finder'] }) })
    fireEvent.click(main)
    expect(main).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: zh['path.more'] })).toHaveProperty('disabled', true)
    fireEvent.click(main)
    expect(b.launch).toHaveBeenCalledOnce()
    expect(view.container.querySelector('[data-open-target]')?.getAttribute('data-state')).toBe('busy')
    await act(async () => { pending.resolve(undefined) })
    expect(main).toHaveProperty('disabled', false)
  })

  it('announces launch failure without changing the remembered application', async () => {
    const b = bench({ apps: ['finder', 'cursor'], absolutePath: '/w', launch: async () => { throw new Error('gone') } })
    render(<OpenInAppAction {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['path.more'] }))
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Cursor' })) })
    expect(screen.getByRole('alert').textContent).toContain(zh['path.openError'])
    expect(b.choose).not.toHaveBeenCalled()
  })

  it('lists only applications, marks the remembered default, and remembers a successful choice', async () => {
    const b = bench({ apps: ['finder', 'cursor', 'terminal'], absolutePath: '/w/dir' })
    render(<OpenInAppAction {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['path.more'] }))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['访达（默认）', 'Cursor', '终端'])
    expect(screen.queryByText(zh['path.reveal'])).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Cursor' })) })
    expect(b.launch).toHaveBeenCalledWith('cursor', '/w/dir')
    expect(b.choose).toHaveBeenCalledWith('cursor')
  })

  it('closes on Escape without launching and falls back after an icon fails', async () => {
    const b = bench({ apps: ['finder', 'terminal'], absolutePath: '/w' })
    const view = render(<OpenInAppAction {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['path.more'] }))
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(b.launch).not.toHaveBeenCalled()
    const image = view.container.querySelector('img')!
    fireEvent.error(image)
    expect(view.container.querySelector('img')).toBeNull()
    expect(view.container.querySelector('svg')).not.toBeNull()
  })

  it('names the selected application in the tooltip', async () => {
    render(<OpenInAppAction {...bench({ apps: ['finder'], absolutePath: '/w' }).props} />)
    fireEvent.mouseEnter(screen.getByRole('button', { name: t('open.title', { app: zh['app.finder'] }) }))
    expect(await screen.findByText(t('open.title', { app: zh['app.finder'] }))).toBeTruthy()
  })
})


it('omits the dropdown when only one directory application is available', () => {
  render(<OpenInAppAction {...bench({ apps: ['finder'], absolutePath: '/w' }).props} />)
  expect(screen.getAllByRole('button')).toHaveLength(1)
  expect(screen.queryByRole('button', { name: zh['path.more'] })).toBeNull()
})

it('opens the displayed directory and follows its changes', async () => {
  const b = bench({ apps: ['finder'], absolutePath: '/displayed-directory' })
  const view = render(<OpenInAppAction {...b.props} absolutePath="/displayed-directory" />)
  await act(async () => { fireEvent.click(screen.getByRole('button')) })
  expect(b.launch).toHaveBeenLastCalledWith('finder', '/displayed-directory')

  view.rerender(<OpenInAppAction {...b.props} absolutePath="/another-directory" />)
  await act(async () => { fireEvent.click(screen.getByRole('button')) })
  expect(b.launch).toHaveBeenLastCalledWith('finder', '/another-directory')
})
