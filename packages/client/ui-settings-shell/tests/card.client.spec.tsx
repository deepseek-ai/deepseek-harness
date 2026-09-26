// @vitest-environment jsdom
/** The shell page as the Plugins page renders it: its one-liner, its two fields, and what a save does. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsFieldState, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import { ShellCard, type ShellCardProps } from '../src/client/ShellCard.tsx'
import type { ShellCardState } from '../src/client/shell-card-controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en) => en[key]

const settled: SettingsFormShell = { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }

function field(text: string, rest: Partial<SettingsFieldState> = {}): SettingsFieldState {
  return { text, overridden: false, invalid: false, ...rest }
}

function renderCard(state: Partial<ShellCardState> = {}, view: 'summary' | 'page' = 'page') {
  const store = createSnapshotStore<ShellCardState>({
    ...settled, timeoutMs: field('60000'), maxOutputBytes: field('64000'), ...state,
  })
  const actions = { edit: vi.fn(), resetField: vi.fn(), save: vi.fn(), discard: vi.fn() }
  const props = { ...actions, view, t, useShellCard: bindSnapshotSelector(store) } as ShellCardProps
  render(<ShellCard {...props} />)
  return actions
}

describe('ShellCard', () => {
  it('renders its one-liner alone in the summary view', () => {
    renderCard({}, 'summary')

    expect(document.body.textContent).toBe(en.description)
    expect(screen.queryByLabelText(en.timeoutMs)).toBeNull()
  })

  it('says the plugin is not loaded in place of its fields while its namespace is unavailable', () => {
    renderCard({ available: false })

    expect(screen.getByRole('status').textContent).toBe(en.unavailable)
    expect(screen.queryByLabelText(en.timeoutMs)).toBeNull()
  })

  it('shows its fields at once on its page, without a title of its own', () => {
    renderCard()

    expect(screen.getByLabelText(en.timeoutMs)).toBeTruthy()
    expect(screen.getByLabelText(en.maxOutputBytes)).toBeTruthy()
    expect(screen.queryByText(en.title)).toBeNull()
  })

  it('stages an edit instead of writing it', () => {
    const actions = renderCard()

    fireEvent.change(screen.getByLabelText(en.timeoutMs), { target: { value: '9000' } })

    expect(actions.edit).toHaveBeenCalledWith('timeoutMs', '9000')
    expect(actions.save).not.toHaveBeenCalled()
  })

  it('offers the reset for an overridden field only, and addresses each field separately', () => {
    const actions = renderCard({ maxOutputBytes: field('64000', { overridden: true }) })

    // One badge and one reset: the timeout is still inherited.
    expect(screen.getAllByText(en.overridden)).toHaveLength(1)
    fireEvent.change(screen.getByLabelText(en.maxOutputBytes), { target: { value: '1024' } })
    fireEvent.click(screen.getByRole('button', { name: en.reset }))

    expect(actions.edit).toHaveBeenCalledWith('maxOutputBytes', '1024')
    expect(actions.resetField).toHaveBeenCalledWith('maxOutputBytes')
    cleanup()

    const timeout = renderCard({ timeoutMs: field('9000', { overridden: true }) })
    fireEvent.click(screen.getByRole('button', { name: en.reset }))
    expect(timeout.resetField).toHaveBeenCalledWith('timeoutMs')
  })

  it('keeps the save inert until something is staged, offers no discard, and writes the staged edits when saved', () => {
    renderCard()
    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    cleanup()

    const actions = renderCard({ dirty: true, timeoutMs: field('9000', { overridden: true }) })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    expect(actions.save).toHaveBeenCalledOnce()
    expect(actions.discard).not.toHaveBeenCalled()
  })

  it('drops the staged edits when it leaves the page', () => {
    const actions = renderCard({ dirty: true })
    expect(actions.discard).not.toHaveBeenCalled()

    cleanup()

    expect(actions.discard).toHaveBeenCalledOnce()
  })

  it('blocks the save while a draft is invalid and says why, reports a save in flight, and a save the deployment refused', () => {
    renderCard({ dirty: true, invalid: true, timeoutMs: field('soon', { invalid: true }) })
    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    expect(screen.getByText(en.invalidNumber)).toBeTruthy()
    cleanup()

    renderCard({ dirty: true, saving: true })
    expect(screen.getByRole('button', { name: en.saving })).toHaveProperty('disabled', true)
    cleanup()

    renderCard({ dirty: true, failed: true })
    expect(screen.getByText(en.saveFailed)).toBeTruthy()
    expect(screen.getByLabelText(en.timeoutMs)).toBeTruthy()
  })

  it('says the document is read-only and disables its controls', () => {
    renderCard({ writable: false })

    expect(screen.getByRole('status')).toHaveProperty('textContent', en.readOnly)
    expect(screen.getByLabelText(en.timeoutMs)).toHaveProperty('disabled', true)
  })
})
