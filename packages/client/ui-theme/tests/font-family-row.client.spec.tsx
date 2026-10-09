// @vitest-environment jsdom
/** FontFamilyRow behavior: the field shows the persisted list, blur and Enter
 * commit the normalized input, and the field follows store changes. Also
 * covers the font-list normalization it relies on. */
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { FontFamilyRow } from '../src/client/FontFamilyRow.tsx'
import type { FontFamilyRowComponentProps } from '../src/client/FontFamilyRow.tsx'
import { createFontRowStore } from '../src/client/settings-store.ts'
import { normalizeFontFamily, type FontRole } from '../src/theme-settings.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

afterEach(cleanup)

const COPY: Record<string, string> = {
  'fontFamily.code.title': 'Code font',
  'fontFamily.code.description': 'Used for code',
  'fontFamily.placeholder': 'Default',
}

/** Empty global standard-kit hooks (the row reads neither). */
function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} })
  return bindSnapshotSelector(store)
}
function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  })
  return bindSnapshotSelector(store)
}

type AttentionSnapshot = Parameters<Parameters<FontFamilyRowComponentProps['useSessionStatus']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionStatus: FontFamilyRowComponentProps['useSessionStatus'] = selector => selector(noAttention)

function mount(kind: FontRole = 'code', code = '') {
  const store = createFontRowStore().create()
  store.actions.sync({ text: 14, code: 11, terminal: 13 }, { text: '', code, terminal: '' }, 0)
  const setFontFamily = vi.fn()
  const props: FontFamilyRowComponentProps = {
    useSessions: emptySessions(),
    useSessionStatus,
    usePanelInfo, useSessionRetainInfo: () => undefined, useResource,
    useWorkspaces: emptyWorkspaces(),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    t: (key: string) => COPY[key] ?? key,
    role: kind,
    setFontFamily,
  }
  render(<FontFamilyRow {...props} />)
  return { store, setFontFamily, field: screen.getByRole<HTMLInputElement>('textbox', { name: 'Code font' }) }
}

describe('normalizeFontFamily', () => {
  it('quotes family names, keeps generic keywords, and drops empty names', () => {
    expect(normalizeFontFamily(" 'JetBrains Mono' ,, MONOSPACE, ui-monospace ")).toBe('"JetBrains Mono", MONOSPACE, ui-monospace')
    expect(normalizeFontFamily(' , ')).toBe('')
  })

  it('removes characters that could escape the string or the boot script, and is idempotent', () => {
    const list = normalizeFontFamily('Fira\\"Code</style>\u0007, Sarasa  Mono SC')
    expect(list).toBe('"FiraCode/style", "Sarasa Mono SC"')
    expect(normalizeFontFamily(list)).toBe(list)
  })
})

describe('FontFamilyRow', () => {
  it('shows the role copy and the persisted list, with a default placeholder', () => {
    const { field } = mount('code', '"Iosevka"')
    expect(screen.getByText('Used for code')).toBeDefined()
    expect(field.value).toBe('"Iosevka"')
    expect(field.placeholder).toBe('Default')
  })

  it('commits the normalized list on blur and shows it in the field', () => {
    const b = mount()
    fireEvent.change(b.field, { target: { value: 'Fira Code, monospace' } })
    fireEvent.blur(b.field)
    expect(b.setFontFamily).toHaveBeenCalledWith('"Fira Code", monospace')
    expect(b.field.value).toBe('"Fira Code", monospace')
  })

  it('ignores Enter while an input method is composing', () => {
    const b = mount()
    fireEvent.change(b.field, { target: { value: '思源' } })
    fireEvent.keyDown(b.field, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(b.field, { key: 'Enter', keyCode: 229 })
    expect(b.setFontFamily).not.toHaveBeenCalled()
    expect(b.field.value).toBe('思源')
  })

  it('commits on Enter and follows later store changes', () => {
    const b = mount('code', '"Iosevka"')
    b.field.focus()
    fireEvent.change(b.field, { target: { value: '' } })
    fireEvent.keyDown(b.field, { key: 'Enter' })
    expect(b.setFontFamily).toHaveBeenCalledWith('')
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Code font' }), { key: 'a' })
    expect(b.setFontFamily).toHaveBeenCalledOnce()
    act(() => { b.store.actions.sync({ text: 14, code: 11, terminal: 13 }, { text: '', code: '"Hack"', terminal: '' }, 1) })
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Code font' }).value).toBe('"Hack"')
    act(() => { b.store.actions.sync({ text: 14, code: 11, terminal: 13 }, { text: '', code: '"Stale"', terminal: '' }, 1) })
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Code font' }).value).toBe('"Hack"')
  })
})
