// @vitest-environment jsdom
/**
 * The standalone viewer's Session row verbs: the branch row the viewer page offers under its access
 * snapshot, and how a refused branch is stated.
 *
 * The viewer page renders the normal sidebar, so ui-workspace's shipped rows are present; this
 * module shadows the shipped branch row by id. The bench declares the same slot lists, registers
 * shipped rows as any page would, and mounts the viewer module, so the assertions cover the
 * shadowing and the viewer's own answers rather than a hand-built component.
 */

import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { menuOpenStateFactory } from '@deepseek-ai/dsh-client-ui-workspace/src/client/contract/slots.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, ViewerForkMenuItem, type ViewerForkMenuItemProps } from '../src/client/viewer-session-row.tsx'
import { en, NS, zh } from '../src/client/locales.ts'

const MENU_ITEM = 'sidebar.workspaces.session.menu.item'
const ROW_ACTION = 'sidebar.workspaces.session.row.action'
const SHARED = 'shared' as SessionId

afterEach(cleanup)

/**
 * Stand-in for one shipped ui-workspace row, which hides itself under the page's access snapshot.
 * @returns A labelled menu row.
 */
function ShippedRow(): ReactNode {
  return <button type="button" role="menuitem">shipped</button>
}

/**
 * One viewer page: the slot lists ui-workspace declares, shipped rows registered as the owner
 * package does, and the viewer module mounted over them.
 * @param forkRejects - Rejection a branch attempt should report, when the lane exercises one.
 * @returns The page's context, its slot registry, and the spies its services record.
 */
async function bench(forkRejects?: Error) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: {
      [MENU_ITEM]: { kind: 'list', scope: 'root', inject: { hooks: { menuOpenState: menuOpenStateFactory } } },
      [ROW_ACTION]: { kind: 'list', scope: 'root' },
      'shell.overlay': { kind: 'list', scope: 'root' },
      'sidebar.session.row.leading': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  // The Liveshare client face registers the dictionaries this child plugin renders with.
  locale.register(NS, { zh, en })
  const forkSession = forkRejects === undefined
    ? vi.fn(async () => undefined)
    : vi.fn(() => Promise.reject(forkRejects))
  ctx.provide('uiWorkspace', { forkSession, openListedBranch: vi.fn(), openSession: vi.fn() } as never)
  // The shipped rows the viewer page carries.
  for (const [id, order] of [['pin', 100], ['rename', 200], ['fork', 300], ['archive', 400]] as const) {
    slots.register({ name: MENU_ITEM, id, order }, ShippedRow)
  }
  for (const [id, order] of [['archive', 100], ['pin', 200]] as const) {
    slots.register({ name: ROW_ACTION, id, order }, ShippedRow)
  }
  slots.register({ name: 'shell.overlay', id: 'workspace.session-rename' }, ShippedRow)
  await ctx.plugin({ inject: [...inject], apply }).await()
  return { ctx, slots, locale, forkSession }
}

/**
 * Render the viewer's branch row and collect the menu labels it produces.
 * @param slots - The page's slot registry.
 * @param t - Viewer translator bound to this package's namespace.
 * @param forkAllowed - Whether the access snapshot includes `session/fork` for the row's Session.
 * @returns The menuitem labels the row rendered, and the access questions it asked.
 */
function forkRowLabels(slots: SlotRegistry, t: ViewerForkMenuItemProps['t'], forkAllowed: boolean) {
  const entry = slots.entriesOfSlot(MENU_ITEM).find(row => row.options.id === 'fork')!
  const useSessionAccess = vi.fn((_sessionId: SessionId, _endpoint: string) => forkAllowed)
  const injected = entry.inject?.() as { forkSession: unknown }
  const View = entry.component as (props: Record<string, unknown>) => ReactNode
  const { container } = render(<View
    sessionId={SHARED} displayTitle="Shared Session" useMenuOpenState={() => [true, vi.fn()]}
    useSessionAccess={useSessionAccess} forkSession={injected.forkSession} t={t}
  />)
  return {
    labels: [...container.querySelectorAll('[role="menuitem"]')].map(element => element.textContent ?? ''),
    useSessionAccess,
  }
}

describe('viewer Session row verbs', () => {
  it.each<[boolean, string[]]>([
    [false, []],
    [true, ['分叉会话']],
  ])('offers the branch row only while the access snapshot includes session/fork (%s)', async (allowed, expected) => {
    const page = await bench()
    const t = page.locale.bind('liveshare')
    // The viewer's branch row wins the shipped fork cell at the shipped position; every other shipped
    // row keeps its own cell and hides itself under the page's access snapshot.
    expect(page.slots.entries(MENU_ITEM)).toHaveLength(5)
    // The list renders its cell winners by order, so the branch row keeps the shipped position.
    const winners = [...page.slots.entriesOfSlot(MENU_ITEM)]
      .sort((left, right) => (left.options.order ?? 0) - (right.options.order ?? 0))
    expect(winners.map(entry => [entry.options.id, entry.options.order])).toEqual(
      [['pin', 100], ['rename', 200], ['fork', 300], ['archive', 400]],
    )
    for (const entry of page.slots.entriesOfSlot(MENU_ITEM)) {
      expect(entry.component).toBe(entry.options.id === 'fork' ? ViewerForkMenuItem : ShippedRow)
    }
    const row = forkRowLabels(page.slots, t, allowed)
    expect(row.labels).toEqual(expected)
    expect(row.useSessionAccess).toHaveBeenCalledWith(SHARED, 'session/fork')
  })

  it('leaves the shipped hover actions and the rename dialog unshadowed', async () => {
    const page = await bench()
    expect(page.slots.entriesOfSlot(ROW_ACTION).map(entry => entry.component)).toEqual([ShippedRow, ShippedRow])
    expect(page.slots.entriesOfSlot('shell.overlay').map(entry => entry.component)).toEqual([ShippedRow])
  })

  it('contains a branch refusal without changing the view', async () => {
    const page = await bench(new Error('refused'))
    const fork = page.slots.entriesOfSlot(MENU_ITEM).find(entry => entry.options.id === 'fork')!
    const injected = fork.inject!() as { forkSession: (sessionId: SessionId) => void }
    injected.forkSession(SHARED)
    expect(page.forkSession).toHaveBeenCalledWith(SHARED)
    // The rejection is consumed by the row; the shared conversation surface carries no refusal
    // notice, so the page leaves its current selection alone.
    await Promise.resolve()
  })

  it('branches from the menu row, closing the menu before the branch is requested', async () => {
    const page = await bench()
    const t = page.locale.bind('liveshare')
    const entry = page.slots.entriesOfSlot(MENU_ITEM).find(row => row.options.id === 'fork')!
    const setMenuOpen = vi.fn()
    const forkSession = vi.fn()
    const View = entry.component as (props: Record<string, unknown>) => ReactNode
    const { container } = render(<View
      sessionId={SHARED} displayTitle="Shared Session" useMenuOpenState={() => [true, setMenuOpen]}
      useSessionAccess={() => true} forkSession={forkSession} t={t}
    />)

    fireEvent.click(container.querySelector('[role="menuitem"]') as HTMLElement)

    expect(setMenuOpen).toHaveBeenCalledWith(false)
    expect(forkSession).toHaveBeenCalledWith(SHARED)
  })

  it('marks a branch whose published lineage names no source with the plain branch label', async () => {
    const page = await bench()
    const entry = page.slots.entriesOfSlot('sidebar.session.row.leading')[0]!
    const View = entry.component as (props: Record<string, unknown>) => ReactNode
    // A Host that publishes the lineage without a source id naming a string names no source to label.
    const list = {
      byId: {
        [SHARED]: { id: SHARED, projectionValues: { forkLineage: { origin: 'fork', workspaceReadOnly: true } } },
        'fx-source': { id: 'fx-source', title: '上游会话' },
      },
    }
    const { container } = render(<View
      sessionId={SHARED} t={page.locale.bind('liveshare')}
      useSessions={(selector: (value: unknown) => unknown) => selector(list)}
    />)

    fireEvent.pointerEnter(container.querySelector('span') as HTMLElement)
    expect(container.textContent).toContain('分叉会话')
    expect(container.textContent).not.toContain('上游会话')
  })

  it('marks a branch with the title its source Session carries', async () => {
    const page = await bench()
    const entry = page.slots.entriesOfSlot('sidebar.session.row.leading')[0]!
    const View = entry.component as (props: Record<string, unknown>) => ReactNode
    const list = {
      byId: {
        [SHARED]: {
          id: SHARED,
          projectionValues: { forkLineage: { origin: 'fork', workspaceReadOnly: true, sourceSessionId: 'fx-source' } },
        },
        'fx-source': { id: 'fx-source', title: '上游会话' },
      },
    }
    const { container } = render(<View
      sessionId={SHARED} t={page.locale.bind('liveshare')}
      useSessions={(selector: (value: unknown) => unknown) => selector(list)}
    />)

    fireEvent.pointerEnter(container.querySelector('span') as HTMLElement)
    expect(container.textContent).toContain('来自「上游会话」的分支')
  })
})
