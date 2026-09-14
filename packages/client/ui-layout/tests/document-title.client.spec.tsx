// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { DocumentTitle } from '../src/client/DocumentTitle.tsx'
import type { MainPanelId, PanelInfo } from '../src/client/service.ts'

let originalTitle: string
beforeEach(() => { originalTitle = document.title })
afterEach(() => {
  try { cleanup() } finally { document.title = originalTitle }
})

function titleSources() {
  const sessionId = 'session-title' as SessionId
  const sessions = createSnapshotStore<SessionListState>({
    ids: [sessionId],
    byId: { [sessionId]: { id: sessionId, displayTitle: 'Test', running: false, blank: false, updatedAt: 1 } },
    current: sessionId,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  })
  const panelInfo = createSnapshotStore<PanelInfo>({ activePanelId: null })
  return {
    sessionId, sessions, panelInfo,
    props: { useSessions: bindSnapshotSelector(sessions), usePanelInfo: bindSnapshotSelector(panelInfo) },
  }
}

describe('DocumentTitle', () => {
  it('projects a durable title and restores the product title', () => {
    const { sessionId, sessions, props } = titleSources()
    document.title = 'stale title'
    const mounted = render(<DocumentTitle {...props} productTitle="DeepSeek Harness" />)
    expect(document.title).toBe('DeepSeek Harness')
    act(() => { sessions.update((state) => { state.byId[sessionId]!.title = 'First title' }) })
    expect(document.title).toBe('First title — DeepSeek Harness')
    act(() => { sessions.update((state) => { state.byId[sessionId]!.title = 'Revised title' }) })
    expect(document.title).toBe('Revised title — DeepSeek Harness')
    act(() => { sessions.update((state) => { state.current = undefined }) })
    expect(document.title).toBe('DeepSeek Harness')
    mounted.unmount()
    expect(document.title).toBe('DeepSeek Harness')
  })

  it('uses the localized product title supplied by the frame', () => {
    const { sessionId, sessions, props } = titleSources()
    sessions.update((state) => { state.byId[sessionId]!.title = 'First title' })
    const mounted = render(<DocumentTitle {...props} productTitle="DSH Local Build" />)
    expect(document.title).toBe('First title — DSH Local Build')
    mounted.unmount()
    expect(document.title).toBe('DSH Local Build')
  })

  it('keeps the product title across global panels and restores the latest Session title on return', () => {
    const { sessionId, sessions, panelInfo, props } = titleSources()
    sessions.update((state) => { state.byId[sessionId]!.title = 'Session title' })
    render(<DocumentTitle {...props} productTitle="Product" />)
    expect(document.title).toBe('Session title — Product')
    act(() => { panelInfo.set({ activePanelId: 'panel-a' as MainPanelId }) })
    expect(document.title).toBe('Product')
    act(() => { sessions.update((state) => { state.byId[sessionId]!.title = 'Updated title' }) })
    expect(document.title).toBe('Product')
    act(() => { panelInfo.set({ activePanelId: 'panel-b' as MainPanelId }) })
    expect(document.title).toBe('Product')
    expect(sessions.getSnapshot().current).toBe(sessionId)
    act(() => { panelInfo.set({ activePanelId: null }) })
    expect(document.title).toBe('Updated title — Product')
  })

  it('uses the product title when the current Session row is not available', () => {
    const { sessions, props } = titleSources()
    sessions.update((state) => { state.byId = {}; state.ids = [] })
    render(<DocumentTitle {...props} productTitle="Product" />)
    expect(document.title).toBe('Product')
  })
})
