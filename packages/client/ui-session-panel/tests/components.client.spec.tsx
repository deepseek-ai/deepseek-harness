// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef, type ReactNode } from 'react'
import { useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives'
import { contextMenuHook, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ConversationLayout } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { EnvironmentSection } from '../src/client/EnvironmentSection.tsx'
import { ProjectRow } from '../src/client/ProjectRow.tsx'
import { SessionPanel } from '../src/client/SessionPanel.tsx'
import { SessionPanelToggle } from '../src/client/SessionPanelToggle.tsx'
import type {
  EnvironmentSectionProps, ProjectRowProps, SessionPanelProps, SessionPanelSectionEntry,
  SessionPanelSectionOwnerProps, SessionPanelToggleProps, SessionPanelVisibility,
} from '../src/client/slots.ts'
import { DOCK_MIN_GUTTER } from '../src/client/visibility.ts'
import { en, zh } from '../src/client/locales.ts'

const SID = 'session-1' as SessionId
const t = makeTranslate(zh) as SessionPanelToggleProps['t']
const WIDE: ConversationLayout = { endGutter: DOCK_MIN_GUTTER, shown: true }
const NARROW: ConversationLayout = { endGutter: DOCK_MIN_GUTTER - 1, shown: true }
const DOCKED: SessionPanelVisibility = { pinned: true, overlay: null }

function selectorOf<T>(value: T) {
  return <S,>(select: (current: T) => S): S => select(value)
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  })
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SessionPanelToggle', () => {
  function toggleProps(layout: ConversationLayout, visibility: SessionPanelVisibility, toggle = vi.fn()) {
    const renderSlot = vi.fn(() => <span>需要处理</span>)
    const props = {
      sessionId: SID, useLayout: selectorOf(layout), useVisibility: selectorOf(visibility), toggle, renderSlot, t,
    } as SessionPanelToggleProps
    return { props, toggle, renderSlot }
  }

  it('names the panel together with its indicators and reports the docked panel as expanded', () => {
    const { props, renderSlot } = toggleProps(WIDE, DOCKED)
    render(<SessionPanelToggle {...props} />)
    const button = screen.getByRole('button', { name: '会话面板 需要处理' })
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.getAttribute('aria-controls')).toBe(`dsh-session-panel-${SID}`)
    expect(renderSlot).toHaveBeenCalledWith('conversation.session.panel.indicator', {})
  })

  it('flips docking with room to dock and opens the overlay without it', () => {
    const wide = toggleProps(WIDE, DOCKED)
    render(<SessionPanelToggle {...wide.props} />)
    fireEvent.click(screen.getByRole('button'))
    expect(wide.toggle).toHaveBeenCalledWith(SID, true)
    cleanup()
    const narrow = toggleProps(NARROW, DOCKED)
    render(<SessionPanelToggle {...narrow.props} />)
    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.hasAttribute('aria-controls')).toBe(false)
    fireEvent.click(button)
    expect(narrow.toggle).toHaveBeenCalledWith(SID, false)
  })

  it('reports an open overlay as expanded', () => {
    const { props } = toggleProps(NARROW, { pinned: false, overlay: SID })
    render(<SessionPanelToggle {...props} />)
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true')
  })
})

describe('SessionPanel', () => {
  const SECTIONS: readonly SessionPanelSectionEntry[] = [
    { id: 'environment', label: '环境' },
    { id: 'change-requests', label: '变更请求' },
  ]

  function panelProps(layout: ConversationLayout, visibility: SessionPanelVisibility, closeOverlay = vi.fn()) {
    const owners: SessionPanelSectionOwnerProps[] = []
    const renderSlot = ((key: string, owner: object, opts?: { only?: string; entryKey?: string }): ReactNode => {
      if (key === 'conversation.session.panel.section.actions') {
        return opts?.entryKey === 'change-requests' ? <button type="button">刷新</button> : null
      }
      owners.push(owner as SessionPanelSectionOwnerProps)
      return <p>{`${opts?.only ?? ''} body`}</p>
    }) as SessionPanelProps['renderSlot']
    const props = {
      sessionId: SID,
      useLayout: selectorOf(layout),
      useVisibility: selectorOf(visibility),
      useSections: selectorOf(SECTIONS),
      closeOverlay,
      renderSlot,
      t,
    } as SessionPanelProps
    return { props, owners, closeOverlay }
  }

  it('renders nothing while hidden', () => {
    const { props } = panelProps(WIDE, { pinned: false, overlay: null })
    const view = render(<SessionPanel {...props} />)
    expect(view.container.innerHTML).toBe('')
  })

  it('docks with one titled region per section in roster order and each section body', () => {
    const { props, owners } = panelProps(WIDE, DOCKED)
    render(<SessionPanel {...props} />)
    const panel = screen.getByRole('complementary', { name: '会话面板' })
    expect(panel.getAttribute('data-session-panel')).toBe('docked')
    expect(panel.id).toBe(`dsh-session-panel-${SID}`)
    const regions = screen.getAllByRole('region')
    expect(regions.map(region => region.getAttribute('aria-labelledby'))).toEqual([
      `dsh-session-panel-${SID}-environment`, `dsh-session-panel-${SID}-change-requests`,
    ])
    expect(screen.getByRole('heading', { name: '变更请求' })).toBeTruthy()
    expect(screen.getByText('environment body')).toBeTruthy()
    expect(screen.getByRole('button', { name: '刷新' })).toBeTruthy()
    expect(owners.every(owner => owner.presentation === 'docked')).toBe(true)
  })

  it('closes the overlay on Escape from inside and returns focus to the toggle', () => {
    const { props, owners, closeOverlay } = panelProps(NARROW, { pinned: true, overlay: SID })
    const toggle = document.createElement('button')
    toggle.id = `dsh-session-panel-toggle-${SID}`
    document.body.append(toggle)
    try {
      render(<SessionPanel {...props} />)
      const panel = screen.getByRole('complementary')
      expect(panel.getAttribute('data-session-panel')).toBe('overlay')
      fireEvent.keyDown(document, { key: 'Enter' })
      expect(closeOverlay).not.toHaveBeenCalled()
      screen.getByRole('button', { name: '刷新' }).focus()
      fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' })
      expect(closeOverlay).toHaveBeenCalledWith(SID)
      expect(document.activeElement).toBe(toggle)
      owners[0]?.dismissOverlay()
      expect(closeOverlay).toHaveBeenCalledTimes(2)
    } finally {
      toggle.remove()
    }
  })

  it('closes the overlay on Escape from the page without moving focus', () => {
    const { props, closeOverlay } = panelProps(NARROW, { pinned: true, overlay: SID })
    render(<SessionPanel {...props} />)
    const outside = document.createElement('input')
    document.body.append(outside)
    try {
      outside.focus()
      fireEvent.keyDown(outside, { key: 'Escape' })
      expect(closeOverlay).toHaveBeenCalledWith(SID)
      expect(document.activeElement).toBe(outside)
    } finally {
      outside.remove()
    }
  })

  it('closes the overlay on an outside pointerdown but not on the panel, the toggle, or an open menu', () => {
    const { props, closeOverlay } = panelProps(NARROW, { pinned: true, overlay: SID })
    const toggle = document.createElement('button')
    toggle.id = `dsh-session-panel-toggle-${SID}`
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const item = document.createElement('button')
    menu.append(item)
    document.body.append(toggle, menu)
    try {
      render(<SessionPanel {...props} />)
      fireEvent.pointerDown(screen.getByText('environment body'))
      fireEvent.pointerDown(toggle)
      fireEvent.pointerDown(item)
      expect(closeOverlay).not.toHaveBeenCalled()
      fireEvent.pointerDown(document.body)
      expect(closeOverlay).toHaveBeenCalledWith(SID)
    } finally {
      toggle.remove()
      menu.remove()
    }
  })

  it('leaves Escape to other handlers while docked, after another handler took it, or behind a modal', () => {
    const docked = panelProps(WIDE, DOCKED)
    render(<SessionPanel {...docked.props} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.pointerDown(document.body)
    expect(docked.closeOverlay).not.toHaveBeenCalled()
    cleanup()
    const overlay = panelProps(NARROW, { pinned: true, overlay: SID })
    render(<SessionPanel {...overlay.props} />)
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    event.preventDefault()
    document.dispatchEvent(event)
    expect(overlay.closeOverlay).not.toHaveBeenCalled()
    // A modal opened over the overlay registers its Escape after the panel's, so the panel sees it first.
    function Modal() {
      const dialog = useRef<HTMLDivElement>(null)
      useModalLayer(dialog, true, () => {})
      return <div ref={dialog} role="dialog" aria-modal="true" />
    }
    const modal = render(<Modal />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(overlay.closeOverlay).not.toHaveBeenCalled()
    modal.unmount()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(overlay.closeOverlay).toHaveBeenCalledWith(SID)
  })

  it('leaves Escape to an input method composing text, including the key that ends the composition', () => {
    const { props, closeOverlay } = panelProps(NARROW, { pinned: true, overlay: SID })
    render(<SessionPanel {...props} />)
    fireEvent(document, new Event('compositionstart'))
    fireEvent.keyDown(document, { key: 'Escape', isComposing: true })
    fireEvent(document, new Event('compositionend'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(closeOverlay).not.toHaveBeenCalled()
    fireEvent.keyUp(document, { key: 'Escape' })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(closeOverlay).toHaveBeenCalledWith(SID)
  })

  it('hands focus to the toggle when the panel hides with the keyboard inside it', () => {
    const toggle = document.createElement('button')
    toggle.id = `dsh-session-panel-toggle-${SID}`
    const outside = document.createElement('button')
    document.body.append(toggle, outside)
    try {
      const docked = panelProps(WIDE, DOCKED)
      const view = render(<SessionPanel {...docked.props} />)
      const control = screen.getByRole('button', { name: '刷新' })
      control.focus()
      // Moves within the panel, and blurs that name no next target, keep the keyboard inside.
      fireEvent.focusOut(control, { relatedTarget: screen.getByRole('complementary') })
      fireEvent.focusOut(control, { relatedTarget: null })
      view.rerender(<SessionPanel {...panelProps(NARROW, DOCKED).props} />)
      expect(document.activeElement).toBe(toggle)
      // Focus that already left the panel stays where it went.
      view.rerender(<SessionPanel {...docked.props} />)
      screen.getByRole('button', { name: '刷新' }).focus()
      outside.focus()
      view.rerender(<SessionPanel {...panelProps(NARROW, DOCKED).props} />)
      expect(document.activeElement).toBe(outside)
      // A panel that hides without having held focus moves nothing.
      view.rerender(<SessionPanel {...docked.props} />)
      view.rerender(<SessionPanel {...panelProps(NARROW, DOCKED).props} />)
      expect(document.activeElement).toBe(outside)
    } finally {
      toggle.remove()
      outside.remove()
    }
  })
})

describe('EnvironmentSection', () => {
  it('renders its rows straight into the section body', () => {
    const renderSlot = vi.fn(() => <span>row</span>)
    render(<>{EnvironmentSection({ renderSlot } as EnvironmentSectionProps)}</>)
    expect(renderSlot).toHaveBeenCalledWith('conversation.session.panel.environment.row', {})
    expect(screen.getByText('row')).toBeTruthy()
  })
})

describe('ProjectRow', () => {
  function rowProps(over: {
    workingDirectory?: string | null
    workspacePath?: string
    cwd?: string
    home?: string
  }, open = vi.fn()) {
    const renderFactorySlot = vi.fn((_name: string, input: { label: string }) => <button type="button">{input.label}</button>)
    const props = {
      sessionId: SID,
      useProjection: (key: string) => key === 'workingDirectory' ? over.workingDirectory : undefined,
      useWorkspaces: selectorOf({
        items: over.workspacePath === undefined ? [] : [{ path: over.workspacePath, sessionIds: [SID] }],
      }),
      useSessions: selectorOf({ byId: over.cwd === undefined ? {} : { [SID]: { cwd: over.cwd } } }),
      useHost: selectorOf({ home: over.home, isLoopback: true }),
      useContextMenu: contextMenuHook(open),
      renderFactorySlot,
      t,
    } as ProjectRowProps
    return { props, renderFactorySlot, open }
  }

  function folderOf(container: HTMLElement): { name: string | null; parent: string | null } {
    const folder = container.querySelector('[data-session-panel-project] [tabindex="0"]') as HTMLElement
    const [name, parent] = [...folder.children]
    return { name: name?.textContent ?? null, parent: parent?.textContent ?? null }
  }

  it('shows the working directory as its name and parent folder, with the label and full path in the tooltip', () => {
    const { props, renderFactorySlot } = rowProps({
      workingDirectory: '/Users/me/projects/app/.worktrees/fix',
      cwd: '/Users/me/projects/app',
      workspacePath: '/Users/me/projects/app',
      home: '/Users/me',
    })
    const view = render(<ProjectRow {...props} />)
    expect(folderOf(view.container)).toEqual({ name: 'fix', parent: '~/projects/app/.worktrees' })
    fireEvent.keyDown(document.body, { key: 'Tab' })
    fireEvent.focus(view.container.querySelector('[data-session-panel-project] [tabindex="0"]') as HTMLElement)
    expect(screen.getByRole('tooltip', { hidden: true }).textContent).toBe('工作目录\n~/projects/app/.worktrees/fix')
    expect(renderFactorySlot).toHaveBeenCalledWith('contextMenu.button', expect.objectContaining({
      target: { kind: 'directory', value: { sessionId: SID, path: '/Users/me/projects/app/.worktrees/fix' } },
      label: '工作目录操作',
      size: 'sm',
    }))
    expect(screen.getByRole('button', { name: '工作目录操作' })).toBeTruthy()
  })

  it('falls back to the directory the Session was created in and opens the directory menu on right-click', () => {
    const { props, open } = rowProps({ cwd: '/srv/app', workspacePath: '/srv' })
    const view = render(<ProjectRow {...props} />)
    expect(folderOf(view.container)).toEqual({ name: 'app', parent: '/srv' })
    fireEvent.contextMenu(view.container.querySelector('[data-session-panel-project]') as HTMLElement)
    expect(open).toHaveBeenCalledWith({ kind: 'directory', value: { sessionId: SID, path: '/srv/app' } }, expect.anything())
  })

  it('falls back to the listing Workspace when no directory is recorded, keeping a root parent and omitting an absent one', () => {
    const atRoot = render(<ProjectRow {...rowProps({ workingDirectory: null, workspacePath: '/srv' }).props} />)
    expect(folderOf(atRoot.container)).toEqual({ name: 'srv', parent: '/' })
    atRoot.unmount()
    const atHome = render(<ProjectRow {...rowProps({ workingDirectory: '/Users/me', home: '/Users/me' }).props} />)
    expect(folderOf(atHome.container)).toEqual({ name: '~', parent: null })
  })

  it('renders nothing before the Session directory is known', () => {
    const { props } = rowProps({})
    const view = render(<ProjectRow {...props} />)
    expect(view.container.innerHTML).toBe('')
  })
})

describe('dictionaries', () => {
  it('keeps the English dictionary key-identical to the Chinese source of truth', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})
