// @vitest-environment jsdom
/** The worktree row page: the summary names the switch, and the page stages it until one explicit save. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '../src/client/locales.ts'
import { WorktreeSettingsForm, type WorktreeSettings as WorktreeSettingsFields } from '../src/client/worktree-settings-form.ts'
import { WorktreeSettings, type WorktreeSettingsProps } from '../src/client/WorktreeSettings.tsx'

afterEach(cleanup)

const TITLE = en['settings.retainOnArchive.title']

function mount(scope: ReturnType<typeof stubConfigForm<WorktreeSettingsFields>>, view: 'page' | 'summary' = 'page') {
  const form = new WorktreeSettingsForm(scope.scope), { hooks, ...actions } = form.inject()
  const props = {
    view, ...actions, useWorktreeForm: bindSnapshotSelector(hooks.worktreeForm), t: (key: keyof typeof en) => en[key],
  } as WorktreeSettingsProps
  return { form, actions, hooks, rendered: render(<WorktreeSettings {...props} />) }
}

it('names the switch in the summary view', () => {
  const scope = stubConfigForm<WorktreeSettingsFields>()
  const m = mount(scope, 'summary')
  try {
    expect(m.rendered.container.textContent).toBe(TITLE)
  } finally { m.form.dispose() }
})

it('stages each toggle as a boolean write until save, and rejects a draft that is neither value', async () => {
  const scope = stubConfigForm<WorktreeSettingsFields>()
  scope.publish({
    status: 'ready', value: { retainOnArchive: true }, base: { retainOnArchive: false }, user: { retainOnArchive: true }, writable: true, revision: 2,
  })
  const m = mount(scope)
  try {
    const toggle = m.rendered.getByRole('switch', { name: TITLE })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(m.rendered.getByText(en['settings.retainOnArchive.description'])).toBeTruthy()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    expect(scope.mutate).not.toHaveBeenCalled()
    fireEvent.click(m.rendered.getByRole('button', { name: en['settings.save'] }))
    await vi.waitFor(() => { expect(scope.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['retainOnArchive'], value: false }], 2) })
    m.actions.edit('retainOnArchive', 'bogus')
    expect(m.hooks.worktreeForm.getSnapshot()).toMatchObject({ invalid: true, retainOnArchive: { text: 'bogus', invalid: true } })
    expect(m.rendered.getByRole('switch', { name: TITLE }).getAttribute('aria-checked')).toBe('false')
  } finally {
    m.rendered.unmount()
    m.form.dispose()
  }
  expect(scope.listenerCount()).toBe(0)
})

it('disables the switch while the document is read-only', () => {
  const scope = stubConfigForm<WorktreeSettingsFields>()
  scope.publish({ status: 'ready', value: { retainOnArchive: false } })
  const m = mount(scope)
  try {
    expect(m.rendered.getByText(en['settings.readOnly'])).toBeTruthy()
    expect(m.rendered.getByRole('switch', { name: TITLE })).toHaveProperty('disabled', true)
  } finally { m.form.dispose() }
})
