// @vitest-environment jsdom
/** Conversation assembly acceptance independent of Tool presentation. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ISession } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import {
  RemoteError, SlotTestRuntime, usePinnedBrowserLanguages, stubSettingsScope,
} from '@deepseek-ai/dsh-client-test-runtime'
import { InputHub } from '../src/client/input/hub.ts'
import { apply, inject, type EmptyWorkspaceOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

// jsdom implements no Range geometry (Lexical's scroll-into-view measures the
// caret with one once the surface is genuinely contenteditable).
Range.prototype.getBoundingClientRect = () => ({
  top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}),
})


usePinnedBrowserLanguages('zh-CN')

const SID = 's1' as SessionId

/** jsdom has no ResizeObserver; the composer seat publishes its height through one. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

type AppRootProps = PropsRenderSlots<'main'>
function AppRoot({ renderSlot }: AppRootProps) {
  return <>{renderSlot('main', {}, { entryKey: 'conversation' })}</>
}

const LAYOUT_CHILDREN = {
  'main': { kind: 'keyed', scope: 'root' },
} as const

function WorkspaceProbe({ open }: EmptyWorkspaceOwnerProps) {
  const [count, setCount] = useState(0)
  return (
    <button data-testid="workspace-probe" onClick={() => { setCount(value => value + 1) }}>
      {String(open)}:{count}
    </button>
  )
}

async function bench(opts?: { blank?: boolean }) {
  const runtime = await SlotTestRuntime.create()
  runtime.ctx.provide('uiWorkspace', {
    openWorkspace: vi.fn(async (_workspaceId: WorkspaceId, beforeOpen: (id: SessionId) => void) => {
      beforeOpen(SID)
      runtime.sessions.open(SID)
    }),
    openSession: (id: SessionId) => { runtime.sessions.open(id) },
  } as never)
  runtime.ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.sessions.add({
    id: SID,
    summary: { title: 'S', displayTitle: 'S', cwd: '/proj' },
    ...(opts?.blank === true ? { snapshot: { blank: true } } : {}),
    session: {
      loadOlder: vi.fn<ISession['loadOlder']>(),
      prompt: vi.fn<ISession['prompt']>(async () => ({ ok: true, value: { accepted: true } })),
    },
  })
  await runtime.root.declare(LAYOUT_CHILDREN, AppRoot)
  await runtime.mount({ inject: [...inject], apply })
  return runtime
}

describe('resident composer', () => {
  it('renders the locked view state while no session exists at all', async () => {
    const runtime = await SlotTestRuntime.create()
    runtime.ctx.provide('uiWorkspace', {
      openWorkspace: vi.fn(async (_workspaceId: WorkspaceId, beforeOpen: (id: SessionId) => void) => {
        beforeOpen(SID)
        runtime.sessions.open(SID)
      }),
      openSession: (id: SessionId) => { runtime.sessions.open(id) },
    } as never)
    runtime.ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    await runtime.root.declare(LAYOUT_CHILDREN, AppRoot)
    await runtime.mount({ inject: [...inject], apply })
    runtime.slots.register({ name: 'conversation.hero.workspace' }, WorkspaceProbe)
    const view = runtime.renderRoot()
    const textarea = view.container.querySelector<HTMLDivElement>('[data-composer-input]')
    expect(textarea).not.toBeNull()
    expect(textarea!.getAttribute('aria-disabled')).not.toBe('true')
    expect(textarea!.getAttribute('contenteditable')).not.toBe('true')
    expect(textarea!.getAttribute('aria-haspopup')).toBe('menu')
    expect(view.getByTestId('workspace-probe').textContent).toBe('false:0')
    fireEvent.click(textarea!)
    expect(view.getByTestId('workspace-probe').textContent).toBe('true:0')
    expect(textarea!.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(view.getByRole('button', { name: '选择工作区' }))
    fireEvent.keyDown(textarea!, { key: 'Enter' })
    expect(view.getByTestId('workspace-probe').textContent).toBe('true:0')
    expect(view.getByRole('button', { name: '选择工作区' })).toBeTruthy()
    await runtime.dispose()
  })

  it('keeps the complete Hero tree mounted when the first Workspace session appears', async () => {
    const runtime = await SlotTestRuntime.create()
    runtime.ctx.provide('uiWorkspace', {
      openWorkspace: vi.fn(async (_workspaceId: WorkspaceId, beforeOpen: (id: SessionId) => void) => {
        beforeOpen(SID)
        runtime.sessions.open(SID)
      }),
      openSession: (id: SessionId) => { runtime.sessions.open(id) },
    } as never)
    runtime.ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    await runtime.workspaces.update((draft) => {
      draft.items = [{ workspaceId: 'w1', title: 'Proj', path: '/proj', sessionIds: [SID] }] as never
    })
    await runtime.root.declare(LAYOUT_CHILDREN, AppRoot)
    await runtime.mount({ inject: [...inject], apply })
    runtime.slots.register({ name: 'conversation.hero.workspace' }, WorkspaceProbe)
    const view = runtime.renderRoot()

    const root = view.container.querySelector('[data-phase="hero"]')!
    const scrollBody = view.container.querySelector('[data-conversation-scroll]')!
    const composerSeat = view.container.querySelector('[data-composer-seat]')!
    const textarea = view.container.querySelector<HTMLDivElement>('[data-composer-input]')!
    const workspaceChip = view.getByRole('button', { name: '选择工作区' })
    const workspaceProbe = view.getByTestId('workspace-probe')
    expect(textarea.getAttribute('aria-disabled')).not.toBe('true')
    expect(textarea.getAttribute('contenteditable')).not.toBe('true')

    fireEvent.click(workspaceChip)
    fireEvent.click(workspaceProbe)
    expect(workspaceProbe.textContent).toBe('true:1')

    await runtime.sessions.add({
      id: SID,
      summary: { title: 'S', displayTitle: 'S', cwd: '/proj', blank: true },
      snapshot: { blank: true },
    })

    expect(view.container.querySelector('[data-phase="hero"]')).toBe(root)
    expect(view.container.querySelector('[data-conversation-scroll]')).toBe(scrollBody)
    expect(view.container.querySelector('[data-composer-seat]')).toBe(composerSeat)
    expect(view.container.querySelector<HTMLDivElement>('[data-composer-input]')).toBe(textarea)
    expect(view.getByRole('button', { name: '选择工作区' })).toBe(workspaceChip)
    expect(view.getByTestId('workspace-probe')).toBe(workspaceProbe)
    expect(workspaceProbe.textContent).toBe('true:1')
    expect(textarea.getAttribute('aria-disabled')).not.toBe('true')
    expect(textarea.getAttribute('contenteditable')).toBe('true')
    await runtime.dispose()
  })

  it('the textarea survives the blank→active conversion as the same DOM node', async () => {
    const runtime = await bench({ blank: true })
    await runtime.workspaces.update((draft) => {
      draft.items = [{ workspaceId: 'w1', title: 'Proj', path: '/proj', sessionIds: [SID] }] as never
    })
    const view = runtime.renderRoot()
    const hero = view.container.querySelector<HTMLDivElement>('[data-composer-input]')
    expect(hero).not.toBeNull()
    expect(hero!.getAttribute('aria-disabled')).not.toBe('true')

    await runtime.sessions.updateSessionSnapshot(SID, (draft) => {
      draft.blank = false
    })
    expect(view.container.querySelector<HTMLDivElement>('[data-composer-input]')).toBe(hero)
    await runtime.dispose()
  })
})

describe('prompt rejection through the assembled composer', () => {
  it('renders the promptError alert strip and keeps the draft in the machine', async () => {
    const runtime = await SlotTestRuntime.create()
    runtime.ctx.provide('uiWorkspace', {
      openWorkspace: vi.fn(async (_workspaceId: WorkspaceId, beforeOpen: (id: SessionId) => void) => {
        beforeOpen(SID)
        runtime.sessions.open(SID)
      }),
      openSession: (id: SessionId) => { runtime.sessions.open(id) },
    } as never)
    runtime.ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    const prompt = vi.fn<ISession['prompt']>(async () => ({
      ok: false,
      error: new RemoteError('session/agent-busy', 'prompt rejected before acceptance', { reason: 'busy' }),
    }))
    await runtime.sessions.add({
      id: SID,
      summary: { title: 'S', displayTitle: 'S', cwd: '/proj' },
      session: { prompt, loadOlder: vi.fn<ISession['loadOlder']>() },
    })
    await runtime.root.declare(LAYOUT_CHILDREN, AppRoot)
    await runtime.mount({ inject: [...inject], apply })
    const view = runtime.renderRoot()

    const composer = view.container.querySelector<HTMLDivElement>('[data-composer-input]')!
    // Write through the assembled input resolver (contenteditable change
    // events carry no value; the resolver is the public draft write path).
    const conversation = runtime.ctx.get('conversation') as { input: unknown }
    const shell = (conversation.input as InputHub).shell(SID)
    act(() => { shell.setDraft('do not lose this') })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() => { expect(prompt).toHaveBeenCalledOnce() })

    await runtime.sessions.updateSessionSnapshot(SID, (draft) => {
      draft.promptError = {
        op: 'send',
        error: new RemoteError('session/agent-busy', 'prompt rejected before acceptance', { reason: 'busy' }),
      }
    })
    const alert = await view.findByRole('alert')
    expect(alert.textContent).toContain('prompt rejected before acceptance (session/agent-busy)')
    await waitFor(() => {
      expect(shell.snapshot.draft).toBe('do not lose this')
    })
    await runtime.dispose()
  })
})

describe('title projection across assembled surfaces', () => {
  it('one summary update re-labels the current-session crumb', async () => {
    const runtime = await bench()
    const view = runtime.renderRoot()
    const hierarchy = view.getByRole('navigation', { name: '会话层级' })
    expect(within(hierarchy).getByRole('button', { name: 'S' }).hasAttribute('disabled')).toBe(true)

    await runtime.sessions.updateSummary(SID, { displayTitle: '修订标题', title: '修订标题' })
    await waitFor(() => {
      expect(within(hierarchy).getByRole('button', { name: '修订标题' }).hasAttribute('disabled')).toBe(true)
    })
    expect(within(hierarchy).queryByRole('button', { name: 'S' })).toBeNull()
    await runtime.dispose()
  })
})
