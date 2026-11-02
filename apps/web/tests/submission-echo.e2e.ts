// @vitest-environment jsdom
// Submission echo over the BUILT client graph (keyless RemoteMock transport):
// a text-plus-image send stays in the read-only composer, with its image rail
// and a busy send control, until the fixture host accepts the prompt; only then
// does the composer clear, and the conversation shows the message once. The
// fixture host echoes the prompt requestId as the durable source's rpcId, so
// the reconciliation here is the production correlation, not a test hook.
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import { createAssembledSessionComposer, installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'

installAssembledBootEnv()

it('keeps a send in the composer until the Host accepts it and then shows the message once', async () => {
  const remote = mountAssembledApp()
  const composer = await createAssembledSessionComposer(remote)
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

  // Synchronously after the keystroke, before the prompt is even serialized
  // (it starts after a paint yield): the draft and its image stay in the
  // read-only composer behind a busy send control, and the conversation shows
  // nothing yet.
  expect(document.querySelector('[data-submission-echo]')).toBeNull()
  expect(composer.textContent).toBe('回显这条消息')
  expect(composer.getAttribute('contenteditable')).toBe('false')
  expect(document.querySelector('[role="group"][aria-label="Pending attachments"] img')).not.toBeNull()
  expect(screen.getByRole('button', { name: 'Sending message' }).getAttribute('aria-busy')).toBe('true')

  // The Host accepts the prompt: the composer clears and becomes editable
  // again, its rail is gone, and the durable user/message (source.rpcId
  // echoes the prompt requestId) is the one bubble, its image rendering from
  // the durable gallery.
  await waitFor(() => {
    expect(composer.textContent).toBe('')
    expect(composer.getAttribute('contenteditable')).toBe('true')
    expect(document.querySelector('[role="group"][aria-label="Pending attachments"]')).toBeNull()
  }, { timeout: 10_000 })
  await waitFor(() => {
    if (document.querySelector('[data-submission-echo]') !== null) {
      throw new Error('submission echo still present after the durable node arrived')
    }
    if (document.querySelector('[data-align="end"] img') === null) {
      throw new Error('durable user gallery missing')
    }
  }, { timeout: 10_000 })
  expect(screen.getAllByText('回显这条消息')).toHaveLength(1)
})
