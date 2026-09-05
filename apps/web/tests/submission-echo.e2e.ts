// @vitest-environment jsdom
// Local submission echo over the BUILT client graph (keyless fixture Connection RPC
// transport): a text-plus-image send paints its echo bubble synchronously on
// the submit keystroke — before serialization, transport, or the fixture's
// durable admission — with the composer already cleared and editable, and the
// durable user/message replaces the echo without a duplicate. The fixture host
// echoes the prompt requestId as the durable source's rpcId, so the retirement
// path here is the production correlation, not a test hook.
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'

installAssembledBootEnv()

it('paints the submission echo on the send keystroke and swaps it for the durable node', async () => {
  mountAssembledApp()

  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  const start = tree.querySelector<HTMLButtonElement>('button[aria-label="New session in fixture"]')
  if (start === null) throw new Error('fixture Workspace new-session action missing')
  fireEvent.click(start)

  const composer = await waitFor(() => {
    const surface = document.querySelector<HTMLElement>('[data-composer-input]')
    if (surface === null) throw new Error('composer surface missing')
    return surface
  }, { timeout: 10_000 })
  const image = new File([new Uint8Array([137, 80, 78, 71])], 'echoed.png', { type: 'image/png' })
  fireEvent.paste(composer, {
    clipboardData: {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
      getData: () => '',
    },
  })
  await waitFor(() => {
    if (document.querySelector('[role="group"][aria-label="Pending attachments"] img') === null) {
      throw new Error('attachment rail missing')
    }
  }, { timeout: 5_000 })
  fireEvent.paste(composer, {
    clipboardData: { items: [], getData: () => '回显这条消息' },
  })
  await waitFor(() => { expect(composer.textContent).toBe('回显这条消息') })
  fireEvent.keyDown(composer, { key: 'Enter' })

  // Synchronously after the keystroke: the echo bubble is in the flow with
  // the draft text and the object-URL preview, while the prompt has not even
  // been serialized yet (it starts after a paint yield). The composer is
  // already cleared, editable, and free of the rail.
  const echo = document.querySelector<HTMLElement>('[data-submission-echo]')
  if (echo === null) throw new Error('submission echo missing on the send keystroke')
  expect(echo.textContent).toContain('回显这条消息')
  expect(echo.querySelector('img')?.getAttribute('src')?.split(':')[0]).toBe('blob')
  expect(composer.textContent).toBe('')
  expect(composer.getAttribute('contenteditable')).toBe('true')
  expect(document.querySelector('[role="group"][aria-label="Pending attachments"]')).toBeNull()

  // The fixture's durable user/message (source.rpcId echoes the prompt
  // requestId) replaces the echo: one bubble, no marker left, and the image
  // now renders from the durable gallery.
  await waitFor(() => {
    if (document.querySelector('[data-submission-echo]') !== null) {
      throw new Error('submission echo still present after the durable node arrived')
    }
  }, { timeout: 10_000 })
  expect(screen.getAllByText('回显这条消息')).toHaveLength(1)
  await waitFor(() => {
    if (document.querySelector('[data-align="end"] img') === null) {
      throw new Error('durable user gallery missing')
    }
  }, { timeout: 10_000 })
})
