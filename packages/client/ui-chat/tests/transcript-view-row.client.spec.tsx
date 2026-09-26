// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { TranscriptViewRow, type TranscriptViewRowProps } from '../src/client/settings/TranscriptViewRow.tsx'
import { PerformanceUsageRow } from '../src/client/settings/PerformanceUsageRow.tsx'
import type { LinkOpening, PerformanceUsageMode, TranscriptViewMode } from '../src/chat-settings.ts'
import { LinkOpeningRow } from '../src/client/settings/LinkOpeningRow.tsx'
import { en, zh } from '../src/client/locale.ts'

afterEach(cleanup)

function emptySessions() {
  return bindSnapshotSelector(createSnapshotStore<SessionListState>({
    ids: [], byId: {}, phase: 'ready', projectionsBySession: {},
  }))
}

function emptyWorkspaces() {
  return bindSnapshotSelector(createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  }))
}

function noPendingInteraction() {
  return bindSnapshotSelector(createSnapshotStore<SessionStatusSnapshot>(new Map()))
}

// The resource hook the resources plugin merges into GlobalStandardProps; this row reads no address.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined })) as GlobalStandardProps['useResource']

function mount(mode: TranscriptViewMode = 'standard', dictionary: typeof en | typeof zh = en) {
  const source = createSnapshotStore<TranscriptViewMode>(mode)
  const setTranscriptView = vi.fn((next: TranscriptViewMode) => { source.set(next) })
  const props: TranscriptViewRowProps = {
    usePanelInfo: selector => selector({ activePanelId: null }),
    useSessions: emptySessions(),
    useSessionStatus: noPendingInteraction(),
    useWorkspaces: emptyWorkspaces(),
    useSessionRetainInfo: () => undefined,
    useResource,
    useTranscriptView: bindSnapshotSelector(source),
    setTranscriptView,
    t: makeTranslate(dictionary),
  }
  render(<TranscriptViewRow {...props} />)
  return { setTranscriptView, props }
}

describe('TranscriptViewRow', () => {
  it('explains the preference and shows Standard by default', () => {
    mount()
    expect(screen.getByText('Work details')).toBeDefined()
    expect(screen.getByText('Choose how much detail to show for tool calls')).toBeDefined()
    expect(screen.getByRole('button', { name: /Standard/ }).getAttribute('aria-expanded')).toBe('false')
  })

  it.each([
    ['compact', 'Compact'],
    ['detailed', 'Detailed'],
    ['verbose', 'Verbose'],
  ] as const)('selects %s and follows the mirrored value', (mode, label) => {
    const b = mount()
    fireEvent.click(screen.getByRole('button', { name: /Standard/ }))
    expect(screen.queryByRole('menuitem', { name: 'Normal' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Expanded' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: label }))
    expect(b.setTranscriptView).toHaveBeenCalledWith(mode)
    const trigger = screen.getByRole('button', { name: label })
    fireEvent.click(trigger)
    expect(screen.getByRole('menuitem', { name: 'Compact' })).toBeDefined()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menuitem', { name: 'Compact' })).toBeNull()
  })

  it('shows all four work-detail values in Chinese', () => {
    const b = mount('compact', zh)
    expect(screen.getByText('工作步骤展示')).toBeDefined()
    expect(screen.getByText('选择希望看到多少工具调用细节')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '简洁' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '标准' }))
    expect(b.setTranscriptView).toHaveBeenLastCalledWith('standard')
    fireEvent.click(screen.getByRole('button', { name: '标准' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '详细' }))
    expect(b.setTranscriptView).toHaveBeenLastCalledWith('detailed')
    fireEvent.click(screen.getByRole('button', { name: '详细' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '完全展开' }))
    expect(b.setTranscriptView).toHaveBeenLastCalledWith('verbose')
    expect(screen.getByRole('button', { name: '完全展开' })).toBeDefined()
  })

  it('returns focus before publishing a mode change without refocusing after the menu closes', async () => {
    const b = mount()
    const trigger = screen.getByRole('button', { name: /Standard/ })
    fireEvent.click(trigger)
    const item = screen.getByRole('menuitem', { name: 'Detailed' })
    item.focus()
    const focus = vi.spyOn(trigger, 'focus')
    const publish = b.setTranscriptView.getMockImplementation()!
    let focusedAtPublication = false
    b.setTranscriptView.mockImplementation((mode) => {
      focusedAtPublication = document.activeElement === trigger
      publish(mode)
    })
    try {
      await act(async () => { fireEvent.click(item) })
      expect(focusedAtPublication).toBe(true)
      expect(document.activeElement).toBe(trigger)
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
      expect(screen.queryByRole('menu')).toBeNull()
    } finally {
      focus.mockRestore()
    }
  })
})


describe('LinkOpeningRow', () => {
  it('follows browser availability without clearing the saved destination', () => {
    const b = mount()
    const browserAvailable = createSnapshotStore(false)
    const source = createSnapshotStore<LinkOpening>('new-tab')
    render(<LinkOpeningRow
      {...b.props}
      useLinkOpening={bindSnapshotSelector(source)}
      useBrowserAvailable={bindSnapshotSelector(browserAvailable)}
      setLinkOpening={vi.fn()}
    />)
    expect(screen.queryByText('Open chat links in')).toBeNull()
    act(() => { browserAvailable.set(true) })
    expect(screen.getByRole('button', { name: 'Default Browser' })).toBeDefined()
    act(() => { browserAvailable.set(false) })
    expect(screen.queryByText('Open chat links in')).toBeNull()
    expect(source.getSnapshot()).toBe('new-tab')
  })

  it.each([
    [en, 'Open chat links in', 'Choose where to open web links', 'In-App Sidebar', 'Default Browser'],
    [zh, '网页链接默认打开方式', '对话中网页链接的打开位置', '应用内侧边栏', '默认浏览器'],
  ] as const)('selects either destination using localized labels (%s)', (dictionary, title, description, sidebar, newTab) => {
    const b = mount('compact', dictionary)
    const source = createSnapshotStore<LinkOpening>('sidebar')
    const setLinkOpening = vi.fn((destination: LinkOpening) => { source.set(destination) })
    render(<LinkOpeningRow
      {...b.props}
      useLinkOpening={bindSnapshotSelector(source)}
      useBrowserAvailable={bindSnapshotSelector(createSnapshotStore(true))}
      setLinkOpening={setLinkOpening}
    />)
    expect(screen.getByText(title)).toBeDefined()
    expect(screen.getByText(description)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: sidebar }))
    fireEvent.click(screen.getByRole('menuitem', { name: newTab }))
    expect(setLinkOpening).toHaveBeenLastCalledWith('new-tab')
    fireEvent.click(screen.getByRole('button', { name: newTab }))
    fireEvent.click(screen.getByRole('menuitem', { name: sidebar }))
    expect(setLinkOpening).toHaveBeenLastCalledWith('sidebar')
    expect(screen.getByRole('button', { name: sidebar }).getAttribute('aria-expanded')).toBe('false')
    expect(b.setTranscriptView).not.toHaveBeenCalled()
  })
})

describe('PerformanceUsageRow', () => {
  it('selects compact statistics independently of conversation display', () => {
    const b = mount()
    const source = createSnapshotStore<PerformanceUsageMode>('detailed')
    const setPerformanceUsage = vi.fn((mode: PerformanceUsageMode) => { source.set(mode) })
    render(<PerformanceUsageRow
      {...b.props}
      usePerformanceUsage={bindSnapshotSelector(source)}
      setPerformanceUsage={setPerformanceUsage}
    />)
    expect(screen.getByText('Performance & usage')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Detailed' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Compact' }))
    expect(setPerformanceUsage).toHaveBeenCalledWith('compact')
    expect(screen.getAllByRole('button', { name: 'Compact' })).toHaveLength(1)
    expect(b.setTranscriptView).not.toHaveBeenCalled()
  })
})
