// @vitest-environment jsdom
// The command attachment envelope over the BUILT client graph (real
// bundles via AppWebEntry, keyless fixture Connection RPC): an enter
// submission carrying composer attachments resolves only through a command whose
// descriptor declares `input.attachments`. A non-declaring command refuses with
// one composer error banner and everything retained; a declaring command
// consumes the images — serialized through the real draft-image chain into
// the commands/execute payload — and clears the composer on success, including
// when the image is the whole `/plan` task.
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'

installAssembledBootEnv()

/** Open a fresh fixture session and return its composer surface. */
async function freshComposer(): Promise<HTMLElement> {
  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  const start = tree.querySelector<HTMLButtonElement>('button[aria-label="New session in fixture"]')
  if (start === null) throw new Error('fixture Workspace new-session action missing')
  fireEvent.click(start)
  return await waitFor(() => {
    const surface = document.querySelector<HTMLElement>(
      '[data-composer-input][data-placeholder="Describe what you want to build... / commands, @ files or sessions"]',
    )
    if (surface === null) throw new Error('composer surface missing')
    return surface
  }, { timeout: 10_000 })
}

/** Type through the clipboard: jsdom carries no editable beforeinput; the
 * paste command inserts at the caret, committing a microtask later. */
async function pasteText(surface: HTMLElement, text: string): Promise<void> {
  fireEvent.paste(surface, {
    clipboardData: { items: [], getData: () => text },
  })
  await waitFor(() => { expect(surface.textContent).toContain(text) })
}

/** Paste one tiny PNG into the composer and wait for its rail thumbnail. */
async function pasteImage(textarea: HTMLElement, name: string): Promise<void> {
  const image = new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' })
  fireEvent.paste(textarea, {
    clipboardData: {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
      getData: () => '',
    },
  })
  await waitFor(() => {
    const rail = document.querySelector('[role="group"][aria-label="Pending attachments"]')
    if (rail === null) throw new Error('attachment rail missing')
    expect([...rail.querySelectorAll('img')].map(img => img.getAttribute('alt'))).toContain(name)
  }, { timeout: 5_000 })
}

it('refuses an image-carrying submit to a non-declaring command and keeps draft and images', async () => {
  mountAssembledApp()
  const textarea = await freshComposer()
  await pasteImage(textarea, 'ref.png')

  // /echo is a leadingInput fixture command without `input.attachments`.
  await pasteText(textarea, '/echo hello')
  fireEvent.keyDown(textarea, { key: 'Enter' })

  // The refusal rides the same transient error banner as other composer
  // failures; session activity remains on its separate status live region.
  const notice = await waitFor(() => {
    const el = [...document.querySelectorAll('[role="alert"]')]
      .find(candidate => candidate.textContent?.includes('attachments') ?? false)
    if (el === undefined) throw new Error('composer refusal banner missing')
    return el
  }, { timeout: 5_000 })
  expect(notice.textContent).toBe('/echo does not accept attachments; remove them first')
  expect([...document.querySelectorAll('[role="status"]')]
    .some(candidate => candidate.textContent?.includes('attachments') ?? false)).toBe(false)
  // The whole envelope is retained: draft text and the rail thumbnail.
  await waitFor(() => { expect(textarea.textContent).toBe('/echo hello') })
  const rail = document.querySelector('[role="group"][aria-label="Pending attachments"]')
  expect([...(rail?.querySelectorAll('img') ?? [])].map(img => img.getAttribute('alt'))).toEqual(['ref.png'])
})

it('consumes images through a declaring command and clears the composer on success', async () => {
  mountAssembledApp()
  const textarea = await freshComposer()
  await pasteImage(textarea, 'goal-ref.png')

  // /goal declares `input.attachments` in the fixture catalog; the claim submit
  // serializes the pasted bytes and the fixture executor admits them.
  await pasteText(textarea, '/goal rebuild the cathedral')
  fireEvent.keyDown(textarea, { key: 'Enter' })

  await waitFor(() => {
    expect(textarea.textContent).toBe('')
    expect(document.querySelector('[role="group"][aria-label="Pending attachments"]')).toBeNull()
  }, { timeout: 5_000 })
})

it('submits a bare /plan with an image as an image-only plan request', async () => {
  mountAssembledApp()
  const textarea = await freshComposer()
  await pasteImage(textarea, 'plan-task.png')

  // Trailing separator: a bare '/plan' leaves the caret on the token, where
  // the re-track opens the menu and Enter would pick instead of submit.
  await pasteText(textarea, '/plan ')
  fireEvent.keyDown(textarea, { key: 'Enter' })

  await waitFor(() => {
    expect(textarea.textContent).toBe('')
    expect(document.querySelector('[role="group"][aria-label="Pending attachments"]')).toBeNull()
  }, { timeout: 5_000 })
  expect([...document.querySelectorAll('[role="alert"]')]
    .some(candidate => candidate.textContent?.includes('/plan') ?? false)).toBe(false)
})
