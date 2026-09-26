// @vitest-environment jsdom
/** The web-search page as the Plugins page renders it: its key control, its two fields, and their resets. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsFieldState, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import { WebSearchCard, type WebSearchCardProps } from '../src/client/WebSearchCard.tsx'
import type { WebSearchCardState } from '../src/client/web-search-card-controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en) => en[key]

const settled: SettingsFormShell = { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }

function field(text: string, rest: Partial<SettingsFieldState> = {}): SettingsFieldState {
  return { text, overridden: false, invalid: false, ...rest }
}

function cardActions() {
  return { edit: vi.fn(), resetField: vi.fn(), save: vi.fn(), discard: vi.fn() }
}

describe('WebSearchCard', () => {
  function renderWebSearch(state: Partial<WebSearchCardState> = {}) {
    const store = createSnapshotStore<WebSearchCardState>({
      ...settled,
      baseURL: field(''),
      maxUses: field('5'),
      apiKey: field(''),
      apiKeyConfigured: false,
      apiKeyWritable: true,
      ...state,
    })
    const actions = cardActions()
    const props = { ...actions, view: 'page', t, useWebSearchCard: bindSnapshotSelector(store) } as WebSearchCardProps
    render(<WebSearchCard {...props} />)
    return actions
  }

  it('renders its one-liner alone in the summary view', () => {
    const store = createSnapshotStore<WebSearchCardState>({
      ...settled, baseURL: field(''), maxUses: field('5'), apiKey: field(''), apiKeyConfigured: false, apiKeyWritable: true,
    })
    const props = { ...cardActions(), view: 'summary', t, useWebSearchCard: bindSnapshotSelector(store) } as WebSearchCardProps
    render(<WebSearchCard {...props} />)

    expect(document.body.textContent).toBe(en.description)
    expect(screen.queryByLabelText(en.apiKey)).toBeNull()
  })

  it('reports whether a key is configured without ever showing one', () => {
    renderWebSearch({ apiKeyConfigured: true })

    expect(screen.getByText(en.apiKeySet)).toBeTruthy()
    expect(screen.getByLabelText(en.apiKey)).toHaveProperty('type', 'password')
  })

  it('keeps the key control usable while the settings document is read-only', () => {
    const actions = renderWebSearch({ writable: false })

    const key = screen.getByLabelText(en.apiKey)
    expect(key).toHaveProperty('disabled', false)
    expect(screen.getByLabelText(en.baseUrl)).toHaveProperty('disabled', true)

    fireEvent.change(key, { target: { value: 'ds-secret' } })

    expect(actions.edit).toHaveBeenCalledWith('apiKey', 'ds-secret')
  })

  it('disables the key control when the reference itself is not writable', () => {
    // A key coming from the process environment: the settings document is
    // writable, the credential is not.
    renderWebSearch({ apiKeyConfigured: true, apiKeyWritable: false })

    expect(screen.getByLabelText(en.apiKey)).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.baseUrl)).toHaveProperty('disabled', false)
  })

  it('stages the endpoint, the search budget, and their resets', () => {
    const actions = renderWebSearch({
      baseURL: field('https://search.test/v1', { overridden: true }),
      maxUses: field('3', { overridden: true }),
    })

    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://other.test' } })
    fireEvent.change(screen.getByLabelText(en.maxUses), { target: { value: '4' } })
    const resets = screen.getAllByRole('button', { name: en.reset })
    expect(resets).toHaveLength(2)
    for (const reset of resets) fireEvent.click(reset)

    expect(actions.edit.mock.calls).toEqual([
      ['baseURL', 'https://other.test'],
      ['maxUses', '4'],
    ])
    expect(actions.resetField.mock.calls).toEqual([['baseURL'], ['maxUses']])
  })
})
