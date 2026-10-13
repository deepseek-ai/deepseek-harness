// @vitest-environment jsdom
/** The switch follows accepted Host state, including refused and delayed saves. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ComponentProps } from 'react'
import { UploadRow, UploadToast } from '../src/client/UploadRow.tsx'
import { UploadPreference, type UploadSettings } from '../src/client/upload-preference.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

function fixture(writable = true) {
  const formState = createSnapshotStore<ConfigFormSnapshot<UploadSettings>>({
    status: 'ready', value: { enabled: true }, base: {}, user: {}, revision: 0, writable,
  })
  const set = vi.fn(async (_field: string, enabled: unknown) => {
    formState.update((state) => { state.value = { enabled: enabled === true } })
    return true
  })
  const form: ConfigForm<UploadSettings> = {
    getSnapshot: () => formState.getSnapshot(), subscribe: listener => formState.subscribe(listener),
    set, unset: vi.fn(), mutate: vi.fn(),
  }
  const preference = new UploadPreference(form)
  const props = {
    useUpload: bindSnapshotSelector(formState), useMutation: bindSnapshotSelector(preference.state),
    setEnabled: (enabled: boolean) => preference.setEnabled(enabled), dismiss: () => { preference.dismiss() },
    t: (key: keyof typeof en) => en[key],
  } as ComponentProps<typeof UploadRow>
  return { formState, set, preference, props }
}

it('shows a saved preference and keeps its notice after the row unmounts', async () => {
  const { props, set } = fixture()
  const row = render(<UploadRow {...props} />)
  render(<UploadToast {...props} />)
  fireEvent.click(screen.getByRole('switch', { name: en.title }))
  await waitFor(() => { expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false') })
  expect(set).toHaveBeenCalledWith('enabled', false)
  row.unmount()
  expect(screen.getByText(en.saved)).toBeTruthy()
})

it.each(['refused', 'rejected'] as const)('retains accepted state after a %s write', async (failure) => {
  const { props, set } = fixture()
  if (failure === 'refused') set.mockResolvedValue(false)
  else set.mockRejectedValue(new Error('Disconnected'))
  render(<><UploadRow {...props} /><UploadToast {...props} /></>)
  fireEvent.click(screen.getByRole('switch'))
  await screen.findByText(en.failed)
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
})

it('disables input until a pending write settles', async () => {
  const { props, set, preference } = fixture()
  const pending = Promise.withResolvers<boolean>()
  set.mockReturnValue(pending.promise)
  render(<UploadRow {...props} />)
  fireEvent.click(screen.getByRole('switch'))
  expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true)
  await preference.setEnabled(true)
  expect(set).toHaveBeenCalledTimes(1)
  pending.resolve(false)
  await waitFor(() => { expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(false) })
})

it('shows the Chinese label and cannot edit read-only settings', async () => {
  const { props, set } = fixture(false)
  const translated: Record<string, string> = zh
  const { container } = render(<UploadRow {...props} t={key => translated[key] ?? key} />)
  await expect(container.textContent + '\n').toMatchFileSnapshot('./expected/upload-row.zh.txt')
  expect(screen.getByRole('switch', { name: zh.title }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  fireEvent.click(screen.getByRole('switch'))
  expect(set).not.toHaveBeenCalled()
})
