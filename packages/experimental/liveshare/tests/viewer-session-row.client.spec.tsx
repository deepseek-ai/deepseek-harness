// @vitest-environment jsdom
/** Viewer-owned lineage markers alongside the shared Session menu. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, inject } from '../src/client/viewer-session-row.tsx'
import { en, NS, zh } from '../src/client/locales.ts'

const SHARED = 'shared' as SessionId
const contexts: Context[] = []

afterEach(async () => {
  cleanup()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Mount the viewer's lineage contribution under the sidebar's declared slots. */
async function bench() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: {
    'sidebar.workspaces.session.menu.item': { kind: 'list', scope: 'root' },
    'sidebar.session.row.leading': { kind: 'list', scope: 'root' },
  } } as never, () => null)
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  locale.register(NS, { zh, en })
  await ctx.plugin({ inject: [...inject], apply }).await()
  const entry = slots.entriesOfSlot('sidebar.session.row.leading')[0]!
  const View = entry.component as (props: Record<string, unknown>) => ReactNode
  const marker = (projectionValues?: unknown, sourceTitle?: string) => render(<View
    sessionId={SHARED} t={locale.bind('liveshare')}
    useSessions={(selector: (value: unknown) => unknown) => selector({ byId: {
      [SHARED]: { id: SHARED, projectionValues },
      'fx-source': { id: 'fx-source', title: sourceTitle },
    } })}
  />)
  return { slots, marker }
}

describe('viewer Session lineage', () => {
  it('contributes no duplicate Session menu actions', async () => {
    const page = await bench()
    expect(page.slots.entriesOfSlot('sidebar.workspaces.session.menu.item')).toEqual([])
  })

  it.each([undefined, {}, { forkLineage: null }, { forkLineage: [] },
    { forkLineage: { origin: 'root' } }, { forkLineage: { origin: 'fork', workspaceReadOnly: false } },
  ])('leaves a non-viewer lineage unmarked (%j)', async (projectionValues) => {
    const page = await bench()
    expect(page.marker(projectionValues).container.textContent).toBe('')
  })

  it.each([undefined, 'missing-source'])('uses the branch label without a known source title (%s)', async (sourceSessionId) => {
    const page = await bench()
    const view = page.marker({ forkLineage: { origin: 'fork', workspaceReadOnly: true, sourceSessionId } })
    fireEvent.pointerEnter(view.container.querySelector('span') as HTMLElement)
    expect(view.container.textContent).toContain('分叉会话')
  })

  it('marks a branch with the title its source Session carries', async () => {
    const page = await bench()
    const view = page.marker({ forkLineage: {
      origin: 'fork', workspaceReadOnly: true, sourceSessionId: 'fx-source',
    } }, '上游会话')
    fireEvent.pointerEnter(view.container.querySelector('span') as HTMLElement)
    expect(view.container.textContent).toContain('来自「上游会话」的分支')
  })
})
