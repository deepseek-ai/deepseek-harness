// @vitest-environment jsdom
/**
 * The management section's rendering rules: which actions a row offers depends
 * on its trust, a shipped composition opens in a read-only viewer, creation is
 * a copy dialog that collects an id and an optional name, and the location
 * action follows the host's desktop capability.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { AgentPresetSection } from '../src/client/AgentPresetSection.tsx'
import type { AgentPresetSectionProps } from '../src/client/AgentPresetSection.tsx'
import type { AgentPresetSectionState, CopyDraft } from '../src/client/section-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const READY: AgentPresetSectionState = {
  status: 'ready',
  error: null,
  authorable: true,
  hasDocument: true,
  showPicker: true,
  policySaving: false,
  rows: [
    { id: 'standard', trust: 'system', isDefault: true, name: '标准模式', description: '完整的编码 agent。' },
    { id: 'mine', trust: 'user', isDefault: false },
  ],
  copy: null,
  view: null,
  pendingDelete: null,
  deleting: false,
  revealedPaths: {},
}

/**
 * Render the section over a fixed snapshot, with every action a spy.
 * @param state - the snapshot to render.
 * @returns the spies, so a test can assert what a click reached.
 */
function renderSection(
  state: Partial<AgentPresetSectionState> = {},
  options: { creator?: boolean } = {},
) {
  const store = createSnapshotStore<AgentPresetSectionState>({ ...READY, ...state })
  const actions = {
    load: vi.fn(() => Promise.resolve()),
    // The shell-owned section affordance (SettingsSectionOwnerProps.close).
    close: vi.fn(),
    ...options.creator === false ? {} : { startCreatorDraft: vi.fn() },
    view: vi.fn(() => Promise.resolve()),
    closeView: vi.fn(),
    beginCopy: vi.fn(),
    cancelCopy: vi.fn(),
    setCopyId: vi.fn(),
    setCopyName: vi.fn(),
    confirmCopy: vi.fn(() => Promise.resolve()),
    openLocation: vi.fn(() => Promise.resolve()),
    confirmDelete: vi.fn(),
    remove: vi.fn(() => Promise.resolve()),
    makeDefault: vi.fn(() => Promise.resolve()),
    setPickerVisible: vi.fn(() => Promise.resolve()),
  }
  const props = {
    ...actions,
    useAgentPresetSection: bindSnapshotSelector(store),
    t: (key: keyof typeof en) => en[key],
  } as unknown as AgentPresetSectionProps
  render(<AgentPresetSection {...props} />)
  return actions
}

/** Locate a card by the id it prints, not by its display name. */
function rowFor(id: string): HTMLElement {
  const key = screen.getAllByText(id).find(node => node.tagName === 'CODE')
  const row = key?.closest('li') ?? null
  /* v8 ignore next -- every rendered card prints its id */
  if (row === null) throw new Error(`no card for ${id}`)
  return row
}

describe('the preset list', () => {
  it('reads the roster once when it first renders', async () => {
    const actions = renderSection()

    await waitFor(() => { expect(actions.load).toHaveBeenCalledTimes(1) })
  })

  it('shows resolved copy for built-ins and falls back to custom ids', () => {
    renderSection()

    // Display copy is what a picker reads; the id stays visible as the key the
    // composition and the session header actually carry.
    expect(screen.getByText(en.presetStandardName)).toBeTruthy()
    expect(screen.getByText(en.presetStandardDescription)).toBeTruthy()
    const mine = rowFor('mine')
    expect(within(mine).getAllByText('mine').length).toBeGreaterThan(0)
    expect(within(mine).getByText(en.noDescription)).toBeTruthy()
  })

  it('marks trust and the one in use, and offers no "set default" on it', () => {
    renderSection()

    const standard = rowFor('standard')
    expect(within(standard).getByText(en.builtIn)).toBeTruthy()
    expect(within(standard).getByText(en.inUse)).toBeTruthy()
    expect(within(standard).queryByText(en.setDefault)).toBeNull()
    expect(within(rowFor('mine')).getByText(en.userTrust)).toBeTruthy()
  })

  it('explains and reverses a Host-disabled picker without offering preset changes', () => {
    const actions = renderSection({
      showPicker: false,
      error: 'settings write disconnected',
      rows: [
        ...READY.rows,
        { id: 'cordis', trust: 'system', isDefault: false, name: '创造模式' },
      ],
    })

    const toggle = screen.getByRole('switch', { name: en.showPicker })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    expect(actions.setPickerVisible).toHaveBeenCalledWith(true)
    expect(screen.getByRole('alert').textContent).toBe('settings write disconnected')

    const creator = screen.getByRole('button', { name: en.creatorDraft })
    expect(creator).toHaveProperty('disabled', true)
    expect(creator.getAttribute('title')).toBe(en.enablePickerToCreate)

    const standard = within(rowFor('standard')).getByRole('button', {
      name: `${en.selectionOffDefault}: ${en.presetStandardName}`,
    })
    expect(standard.getAttribute('title')).toBe(en.selectionOffDefault)
    expect(within(rowFor('standard')).getByText(en.selectionOffDefault)).toBeTruthy()

    const mine = within(rowFor('mine')).getByRole('button', {
      name: `${en.enablePickerToSetDefault}: mine`,
    })
    expect(mine).toHaveProperty('disabled', true)
    expect(mine.getAttribute('title')).toBe(en.enablePickerToSetDefault)
    fireEvent.click(mine)
    expect(actions.makeDefault).not.toHaveBeenCalled()
  })

  it('separates built-in presets from custom ones', () => {
    renderSection()

    // Two different things: one set ships with the deployment and is
    // read-only, the other is the user's own.
    expect(screen.getByRole('heading', { name: en.builtInGroup })).toBeTruthy()
    expect(screen.getByRole('heading', { name: en.customGroup })).toBeTruthy()
  })

  it('shows no group heading for a set nobody has', () => {
    renderSection({ rows: [{ id: 'standard', trust: 'system', isDefault: true }] })

    expect(screen.queryByRole('heading', { name: en.customGroup })).toBeNull()
  })

  it('leads with the two ways a preset is created', () => {
    renderSection()

    // The page has no create button: the intro is what tells a first-time
    // reader that copying an existing preset — or drafting one in Creator
    // mode — IS the way to make one.
    expect(screen.getByText(new RegExp('Creator mode'))).toBeTruthy()
  })

  it('picks a preset by clicking its card, and the one in use is inert', () => {
    const actions = renderSection()

    const inUse = within(rowFor('standard')).getByRole('button', { name: `${en.inUse}: ${en.presetStandardName}` })
    expect(inUse).toHaveProperty('disabled', true)
    fireEvent.click(inUse)

    // Clicking the card IS the choice; the preset already in use cannot be
    // re-picked, so the click reaches nothing.
    expect(actions.makeDefault).not.toHaveBeenCalled()
  })

  it('offers View on a shipped row and the location on a custom one', () => {
    renderSection()

    // A shipped preset is the composition a copy starts from — reading it is
    // the point. A custom preset is edited in its files, so its row leads
    // there instead; there is no editor for either.
    const standard = rowFor('standard')
    expect(within(standard).getByRole('button', { name: `${en.view}: ${en.presetStandardName}` })).toBeTruthy()
    expect(within(standard).queryByRole('button', { name: `${en.openLocation}: ${en.presetStandardName}` })).toBeNull()
    const mine = rowFor('mine')
    expect(within(mine).getByRole('button', { name: `${en.openLocation}: mine` })).toBeTruthy()
    expect(within(mine).queryByRole('button', { name: `${en.view}: mine` })).toBeNull()
  })

  it('offers Delete only for a locally authored preset', () => {
    renderSection()

    expect(within(rowFor('mine')).getByRole('button', { name: `${en.delete}: mine` })).toBeTruthy()
    expect(within(rowFor('standard')).queryByRole('button', { name: `${en.delete}: ${en.presetStandardName}` })).toBeNull()
  })

  it('disables duplication when nothing is writable, and says why', () => {
    renderSection({ authorable: false })

    const duplicate = within(rowFor('standard')).getByRole('button', { name: `${en.duplicate}: ${en.presetStandardName}` })
    expect(duplicate).toHaveProperty('disabled', true)
    expect(duplicate.getAttribute('data-tip')).toBe(en.duplicateUnavailable)
  })

  it('marks a broken custom preset: unselectable, uncopyable, still deletable', () => {
    const actions = renderSection({
      rows: [
        { id: 'standard', trust: 'system', isDefault: true },
        {
          id: 'ghost', trust: 'user', isDefault: false, name: '幽灵预设', description: '我自己写的',
          broken: 'the composition file agent.cordis.yml is missing',
        },
      ],
    })

    const ghost = rowFor('ghost')
    // The badge carries the reason for a pointer, and the body cannot pick
    // what cannot mount.
    expect(within(ghost).getByText(en.brokenBadge).textContent)
      .toBe(`${en.brokenBadge}the composition file agent.cordis.yml is missing`)
    // A picker card keeps showing what the preset is; a package specifier in
    // its place would tell a chooser nothing they can act on there.
    expect(within(ghost).getByText('我自己写的')).toBeTruthy()
    // Reachable without a pointer: the disabled body leaves the tab order, so
    // this node is the only reading assistive technology gets.
    expect(within(ghost).getByRole('alert').textContent).toContain('is missing')
    // `aria-disabled`, not `disabled`: the card stays in the tab order so a
    // keyboard reaches the reason the face no longer shows, and refuses the
    // pick itself rather than by being unreachable.
    const body = within(ghost).getByRole('button', { name: `${en.brokenBadge}: 幽灵预设` })
    expect(body).toHaveProperty('disabled', false)
    expect(body.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(body)
    expect(actions.makeDefault).not.toHaveBeenCalled()
    // Copying a broken preset would only mint another broken one; deleting
    // and the location remain — the files are where it gets fixed.
    const duplicate = within(ghost).getByRole('button', { name: `${en.duplicate}: 幽灵预设` })
    expect(duplicate).toHaveProperty('disabled', true)
    expect(duplicate.getAttribute('data-tip')).toBe(en.brokenNoCopy)
    expect(within(ghost).getByRole('button', { name: `${en.delete}: 幽灵预设` })).toBeTruthy()
    expect(within(ghost).getByRole('button', { name: `${en.openLocation}: 幽灵预设` })).toBeTruthy()
  })

  it('withholds the viewer on a broken shipped preset', () => {
    renderSection({
      rows: [{ id: 'standard', trust: 'system', isDefault: false, name: '标准模式', broken: 'the composition is not valid YAML' }],
    })

    // There is no readable composition to offer; the reason on the card is
    // the whole story a shipped row can tell.
    const standard = rowFor('standard')
    expect(within(standard).queryByRole('button', { name: `${en.view}: ${en.presetStandardName}` })).toBeNull()
    expect(within(standard).getByRole('alert').textContent).toContain('not valid YAML')
  })

  it('labels the location by what it will do without a desktop', () => {
    renderSection({ hasDocument: false })

    expect(within(rowFor('mine')).getByRole('button', { name: `${en.showLocation}: mine` })).toBeTruthy()
  })

  it('shows a revealed directory on its row', () => {
    renderSection({ revealedPaths: { mine: '/home/user/.dsh/.agent-presets/mine' } })

    const mine = rowFor('mine')
    expect(within(mine).getByText('/home/user/.dsh/.agent-presets/mine')).toBeTruthy()
    expect(within(mine).getByText(en.revealedPathLabel)).toBeTruthy()
    // The reveal belongs to its row alone.
    expect(within(rowFor('standard')).queryByText(en.revealedPathLabel)).toBeNull()
  })

  it('routes the row actions to the controller', () => {
    const actions = renderSection()

    // The card body is the control that picks a preset.
    fireEvent.click(within(rowFor('mine')).getByRole('button', { name: `${en.setDefault}: mine` }))
    fireEvent.click(within(rowFor('mine')).getByRole('button', { name: `${en.openLocation}: mine` }))
    fireEvent.click(within(rowFor('mine')).getByRole('button', { name: `${en.duplicate}: mine` }))
    fireEvent.click(within(rowFor('standard')).getByRole('button', { name: `${en.view}: ${en.presetStandardName}` }))

    expect(actions.makeDefault).toHaveBeenCalledWith('mine')
    expect(actions.openLocation).toHaveBeenCalledWith('mine')
    expect(actions.beginCopy).toHaveBeenCalledWith('mine')
    expect(actions.view).toHaveBeenCalledWith('standard')
  })

  it('starts a creator-mode draft session and leaves settings', () => {
    const actions = renderSection({
      rows: [...READY.rows, { id: 'cordis', trust: 'system', isDefault: false, name: '创造模式' }],
    })

    fireEvent.click(screen.getByRole('button', { name: en.creatorDraft }))

    expect(actions.startCreatorDraft).toHaveBeenCalledTimes(1)
    // Leaving settings is part of the gesture: the flow lands in the new
    // session, not behind the modal.
    expect(actions.close).toHaveBeenCalledTimes(1)
  })

  it('keeps the empty custom group on screen: heading plus the creator entry', () => {
    renderSection({
      rows: [
        { id: 'standard', trust: 'system', isDefault: true, name: '标准模式' },
        { id: 'cordis', trust: 'system', isDefault: false, name: '创造模式' },
      ],
    })

    // No member yet, but the place where one's own preset will appear stays.
    expect(screen.getByRole('heading', { name: en.customGroup })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.creatorDraft })).toBeTruthy()
    expect(screen.queryByText(`· ${en.userTrust}`)).toBeNull()
  })

  it('hides the creator entry without the flow or the preset, disables it without a root', () => {
    renderSection()
    expect(screen.queryByRole('button', { name: en.creatorDraft })).toBeNull()
    cleanup()

    renderSection({
      rows: [...READY.rows, { id: 'cordis', trust: 'system', isDefault: false, name: '创造模式' }],
    }, { creator: false })
    expect(screen.queryByRole('button', { name: en.creatorDraft })).toBeNull()
    cleanup()

    const actions = renderSection({
      authorable: false,
      rows: [...READY.rows, { id: 'cordis', trust: 'system', isDefault: false, name: '创造模式' }],
    })
    const disabled = screen.getByRole('button', { name: en.creatorDraft })
    expect(disabled).toHaveProperty('disabled', true)
    fireEvent.click(disabled)
    expect(actions.startCreatorDraft).not.toHaveBeenCalled()
  })

  it('shows a page-level failure without hiding the list', () => {
    renderSection({ error: 'settings are read-only' })

    expect(screen.getByRole('alert').textContent).toBe('settings are read-only')
    expect(rowFor('mine')).toBeTruthy()
  })

  it('renders nothing when the deployment composes no presets', () => {
    const { container } = render(<AgentPresetSection {...({
      useAgentPresetSection: bindSnapshotSelector(
        createSnapshotStore<AgentPresetSectionState>({ ...READY, status: 'unavailable', rows: [] })),
      t: (key: keyof typeof en) => en[key],
      load: vi.fn(() => Promise.resolve()),
    } as unknown as AgentPresetSectionProps)} />)

    expect(container.firstChild).toBeNull()
  })

  it('offers a retry when the roster could not be read', () => {
    const actions = renderSection({ status: 'error', error: 'roster unavailable' })

    expect(screen.getByRole('alert').textContent).toContain('roster unavailable')
    fireEvent.click(screen.getByText(en.retry))

    expect(actions.load).toHaveBeenCalledTimes(2)
  })
})

describe('the copy dialog', () => {
  const draft: CopyDraft = {
    from: 'standard', fromTitle: '标准模式', id: '', name: '', saving: false, error: null,
  }

  it('names its source and collects only an id and a display name', () => {
    const actions = renderSection({ copy: draft })

    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-label')).toBe(`${en.copyTitle} · ${en.copyOf} ${en.presetStandardName}`)
    expect(within(dialog).getByText(en.copyIntro)).toBeTruthy()
    fireEvent.change(within(dialog).getByPlaceholderText(en.presetIdPlaceholder), { target: { value: 'my-agent' } })
    fireEvent.change(within(dialog).getByPlaceholderText(en.displayNamePlaceholder), { target: { value: '我的模式' } })

    expect(actions.setCopyId).toHaveBeenCalledWith('my-agent')
    expect(actions.setCopyName).toHaveBeenCalledWith('我的模式')
    // Nothing else is collected: the description and the composition are
    // edited in the preset's own files.
    expect(within(dialog).queryByRole('textbox', { name: /description/i })).toBeNull()
  })

  it('creates and cancels through the controller', () => {
    const actions = renderSection({ copy: { ...draft, id: 'my-agent' } })

    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByText(en.create))
    fireEvent.click(within(dialog).getByText(en.cancel))

    expect(actions.confirmCopy).toHaveBeenCalledTimes(1)
    expect(actions.cancelCopy).toHaveBeenCalledTimes(1)
  })

  it('blocks a copy the host would refuse, and says why', () => {
    const actions = renderSection({ copy: { ...draft, id: 'Upper Case' } })

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('alert').textContent).toBe(en.idInvalid)
    fireEvent.click(within(dialog).getByText(en.create))

    // Disabled rather than round-tripping: the id is a directory name and the
    // rule is the host's own.
    expect(actions.confirmCopy).not.toHaveBeenCalled()
  })

  it('shows the host\'s refusal instead of the local blocker', () => {
    renderSection({ copy: { ...draft, id: 'my-agent', error: 'already exists' } })

    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe('already exists')
  })

  it('reports a copy in flight and blocks a second click', () => {
    const actions = renderSection({ copy: { ...draft, id: 'my-agent', saving: true } })

    fireEvent.click(within(screen.getByRole('dialog')).getByText(en.creating))

    expect(actions.confirmCopy).not.toHaveBeenCalled()
  })

  it('dismisses on Escape', () => {
    const actions = renderSection({ copy: draft })

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(actions.cancelCopy).toHaveBeenCalledTimes(1)
  })
})

describe('the read-only viewer', () => {
  it('shows the composition text under the preset\'s name', () => {
    renderSection({ view: { id: 'standard', title: '标准模式', content: '- id: tool-bash\n' } })

    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-label')).toBe(`${en.view} · ${en.presetStandardName}`)
    expect(within(dialog).getByText(en.composition)).toBeTruthy()
    expect(within(dialog).getByText(/tool-bash/).textContent).toBe('- id: tool-bash\n')
  })

  it('keeps the loaded title when the viewed row leaves the roster', () => {
    renderSection({ view: { id: 'retired', title: 'Retired mode', content: '- id: tool-bash\n' } })

    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe(`${en.view} · Retired mode`)
  })

  it('closes through the controller', () => {
    const actions = renderSection({ view: { id: 'standard', title: '标准模式', content: '- id: x\n' } })

    fireEvent.click(within(screen.getByRole('dialog')).getByText(en.close))

    expect(actions.closeView).toHaveBeenCalledTimes(1)
  })

  it('dismisses on Escape', () => {
    const actions = renderSection({ view: { id: 'standard', title: '标准模式', content: '- id: x\n' } })

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(actions.closeView).toHaveBeenCalledTimes(1)
  })
})

describe('deleting a preset', () => {
  it('asks before deleting', () => {
    const actions = renderSection()

    fireEvent.click(within(rowFor('mine')).getByRole('button', { name: `${en.delete}: mine` }))

    expect(actions.confirmDelete).toHaveBeenCalledWith('mine')
  })

  it('confirms and dismisses through the controller', () => {
    const actions = renderSection({ pendingDelete: 'mine' })

    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByText(en.deleteConfirm))
    fireEvent.click(within(dialog).getByText(en.cancel))

    expect(actions.remove).toHaveBeenCalledTimes(1)
    expect(actions.confirmDelete).toHaveBeenLastCalledWith(null)
  })

  it('dismisses the confirmation on Escape', () => {
    const actions = renderSection({ pendingDelete: 'mine' })

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(actions.confirmDelete).toHaveBeenCalledWith(null)
  })

  it('reports a delete in flight', () => {
    const actions = renderSection({ pendingDelete: 'mine', deleting: true })

    fireEvent.click(within(screen.getByRole('dialog')).getByText(en.deleting))

    expect(actions.remove).not.toHaveBeenCalled()
  })
})

describe('a long card description', () => {
  /** jsdom has no ResizeObserver; the description watches its own box through one. */
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  const LONG = '始终用简体中文交流的友好通用助手，提供持久 bash 与文件编辑能力。'.repeat(8)

  /** Force the clamp to report an overflow: jsdom lays nothing out, so both heights are 0. */
  function clamp(overflowing: boolean): void {
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(overflowing ? 400 : 80)
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(80)
  }

  beforeEach(() => { vi.stubGlobal('ResizeObserver', ResizeObserverStub) })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('offers the whole description on hover once the card cuts it off', () => {
    clamp(true)
    vi.useFakeTimers()
    try {
      renderSection({ rows: [{ id: 'zh', trust: 'user', isDefault: false, name: '中文助手', description: LONG }] })

      fireEvent.mouseEnter(within(rowFor('zh')).getByText(LONG))
      act(() => { vi.advanceTimersByTime(400) })

      expect(screen.getByRole('tooltip').textContent).toBe(LONG)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays quiet when the description already fits', () => {
    clamp(false)
    vi.useFakeTimers()
    try {
      renderSection({ rows: [{ id: 'zh', trust: 'user', isDefault: false, name: '中文助手', description: '短描述。' }] })

      fireEvent.mouseEnter(within(rowFor('zh')).getByText('短描述。'))
      act(() => { vi.advanceTimersByTime(400) })

      // A bubble repeating what is already fully on the card is noise.
      expect(screen.queryByRole('tooltip')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders where the runtime has no ResizeObserver', () => {
    vi.unstubAllGlobals()
    clamp(true)

    expect(() => {
      renderSection({ rows: [{ id: 'zh', trust: 'user', isDefault: false, description: LONG }] })
    }).not.toThrow()
    // The first measurement does not depend on the observer.
    expect(within(rowFor('zh')).getByText(LONG).getAttribute('title')).toBe('')
  })
})
