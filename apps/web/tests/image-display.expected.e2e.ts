// @vitest-environment jsdom
// Multimodal image surfaces over the BUILT client graph (the ptc-fixture
// idiom: real bundles via AppWebEntry, keyless fixture Connection RPC).
// Opens the fixture history session whose turn 73 carries an image in BOTH a
// user message and an assistant message, and pins the product surfaces: the
// history ImageGallery loading real fixture bytes through the authorized
// sessions.attachment route, the single-click ImageLightbox, and the composer
// intake chain (paste → ordered thumbnail rail → image-only send enablement → remove).
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'

installAssembledBootEnv()

/** Open the fixture history session (the alpha log carrying the turn-72 image pair) and wait for its gallery. */
async function openFixtureSession(): Promise<void> {
  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  const group = (await within(tree).findAllByText('fixture'))
    .map(el => el.closest<HTMLElement>('[role="treeitem"]'))
    .find(el => el?.getAttribute('aria-expanded') !== null)
  if (group === null || group === undefined) throw new Error('fixture Workspace group missing')
  if (group.getAttribute('aria-expanded') === 'false') {
    fireEvent.click(within(group).getByText('fixture'))
    await waitFor(() => {
      expect(group.getAttribute('aria-expanded')).toBe('true')
    })
  }
  const session = await within(tree).findByText('Fixture 历史会话')
  fireEvent.click(session)
  await waitFor(() => {
    expect(document.querySelectorAll('[data-align] img').length).toBeGreaterThan(0)
  }, { timeout: 10_000 })
}

it('renders the history image pair through the authorized attachment route and opens the lightbox', async () => {
  mountAssembledApp()
  await openFixtureSession()

  // Both the user-side (align=end) and assistant-side (align=start) galleries
  // load real fixture bytes over sessions.attachment. jsdom provides
  // createObjectURL, so this environment MUST take the object-URL path — a
  // data: src here would mean the fallback ran where it should not.
  await waitFor(() => {
    if (document.querySelector('[data-align="end"] img') === null
      || document.querySelector('[data-align="start"] img') === null) {
      throw new Error('history image galleries missing')
    }
  }, { timeout: 10_000 })
  const galleryShape = (align: string) => [...document.querySelectorAll(`[data-align="${align}"] img`)]
    .map(img => ({ alt: img.getAttribute('alt'), scheme: img.getAttribute('src')?.split(':')[0] }))
  expect({ user: galleryShape('end'), assistant: galleryShape('start') }).toMatchInlineSnapshot(`
    {
      "assistant": [
        {
          "alt": "fixture-image.png",
          "scheme": "blob",
        },
      ],
      "user": [
        {
          "alt": "fixture-image.png",
          "scheme": "blob",
        },
      ],
    }
  `)
  const userImage = document.querySelector<HTMLElement>('[data-align="end"] img')!

  // A single click opens the original-size lightbox; Escape/close dismisses it.
  const frame = userImage.closest('button')
  if (frame === null) throw new Error('image frame button missing')
  fireEvent.click(frame)
  const lightbox = await screen.findByRole('dialog')
  expect(within(lightbox).getByRole('img').getAttribute('src')?.split(':')[0]).toBe('blob')
  fireEvent.click(within(lightbox).getByRole('button', { name: /Close/ }))
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

it('accepts pasted images into the composer rail in order and removes them', async () => {
  mountAssembledApp()

  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  const start = tree.querySelector<HTMLButtonElement>('button[aria-label="New session in fixture"]')
  if (start === null) throw new Error('fixture Workspace new-session action missing')
  fireEvent.click(start)

  // Image-only send arming is pinned at package level (input-bar.spec.tsx);
  // this assembled lane pins the intake chain over the built graph.
  const textarea = await waitFor(() => {
    const surface = document.querySelector<HTMLElement>(
      '[data-composer-input][data-placeholder="Describe what you want to build... / commands, @ files or sessions"]',
    )
    if (surface === null) throw new Error('composer surface missing')
    return surface
  }, { timeout: 10_000 })
  const image = new File([new Uint8Array([137, 80, 78, 71])], 'pasted.png', { type: 'image/png' })
  fireEvent.paste(textarea, {
    clipboardData: {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
      getData: () => '',
    },
  })

  // The rail is an accessible group holding the draft thumbnail (queried via
  // DOM: jsdom's a11y-visibility computation hides the composer subtree).
  const rail = await waitFor(() => {
    const el = document.querySelector('[role="group"][aria-label="Pending attachments"]')
    if (el === null) throw new Error('attachment rail missing')
    return el
  }, { timeout: 5_000 })
  expect([...rail.querySelectorAll('img')].map(img => ({
    alt: img.getAttribute('alt'), scheme: img.getAttribute('src')?.split(':')[0],
  }))).toMatchInlineSnapshot(`
    [
      {
        "alt": "pasted.png",
        "scheme": "blob",
      },
    ]
  `)

  const second = new File([new Uint8Array([137, 80, 78, 71])], 'second.png', { type: 'image/png' })
  fireEvent.paste(textarea, {
    clipboardData: {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => second }],
      getData: () => '',
    },
  })
  await waitFor(() => {
    expect([...rail.querySelectorAll('img')].map(img => img.getAttribute('alt')))
      .toEqual(['pasted.png', 'second.png'])
  })

  const remove = [...rail.querySelectorAll('button[aria-label^="Remove image"]')]
  if (remove.length !== 2) throw new Error('remove buttons missing')
  for (const button of remove) fireEvent.click(button)
  await waitFor(() => {
    expect(document.querySelector('[role="group"][aria-label="Pending attachments"]')).toBeNull()
  })

  // A non-image paste follows the generic-file path and remains in the
  // composer as a file card.
  fireEvent.paste(textarea, {
    clipboardData: {
      items: [{ kind: 'file', type: 'text/plain', getAsFile: () => new File(['x'], 'notes.txt', { type: 'text/plain' }) }],
      getData: () => '',
    },
  })
  const files = await screen.findByRole('group', { name: 'Pending attachments' })
  expect(files.textContent).toContain('notes.txt')
})

it('accepts a whole-page drop under the limits-labeled overlay and refuses an over-limit batch at intake', async () => {
  mountAssembledApp()

  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  const start = tree.querySelector<HTMLButtonElement>('button[aria-label="New session in fixture"]')
  if (start === null) throw new Error('fixture Workspace new-session action missing')
  fireEvent.click(start)
  const textarea = await waitFor(() => {
    const surface = document.querySelector<HTMLElement>(
      '[data-composer-input][data-placeholder="Describe what you want to build... / commands, @ files or sessions"]',
    )
    if (surface === null) throw new Error('composer surface missing')
    return surface
  }, { timeout: 10_000 })

  // A file drag anywhere over the page raises the full-viewport overlay whose
  // desc line carries the projected limits — copy that can only render after
  // the imageLimits projection crossed the real fixture transport.
  const image = new File([new Uint8Array([137, 80, 78, 71])], 'dropped.png', { type: 'image/png' })
  const dataTransfer = { types: ['Files'], files: [image], dropEffect: 'none' }
  fireEvent.dragEnter(document.body, { dataTransfer })
  const overlay = await screen.findByRole('status')
  expect(overlay.textContent).toContain('Drag files or images here to add them')
  await waitFor(() => {
    expect(overlay.textContent).toContain('Image limit: up to 20 images, 5MB each')
  })

  // Dropping on the transcript area (not the composer card) lands in the rail.
  fireEvent.drop(document.body, { dataTransfer })
  await waitFor(() => {
    const rail = document.querySelector('[role="group"][aria-label="Pending attachments"]')
    if (rail === null) throw new Error('attachment rail missing after page drop')
    expect([...rail.querySelectorAll('img')].map(img => img.getAttribute('alt'))).toEqual(['dropped.png'])
  }, { timeout: 5_000 })
  expect(screen.queryByRole('status')).toBeNull()

  // An intake that would exceed the projected per-message count is refused as
  // a whole batch at add time: the banner names the limit and the rail keeps
  // only the previously accepted thumbnail — no submit-time rollback.
  const batch = Array.from({ length: 20 }, (_, i) =>
    new File([new Uint8Array([137, 80, 78, 71])], `bulk-${String(i)}.png`, { type: 'image/png' }))
  fireEvent.paste(textarea, {
    clipboardData: {
      items: batch.map(file => ({ kind: 'file', type: 'image/png', getAsFile: () => file })),
      getData: () => '',
    },
  })
  const limitMessage = 'A message can include up to 20 images'
  const banner = await screen.findByText(limitMessage)
  expect(banner.closest('[role="alert"]')).not.toBeNull()
  const rail = document.querySelector('[role="group"][aria-label="Pending attachments"]')
  expect([...(rail?.querySelectorAll('img') ?? [])]).toHaveLength(1)
})

it('renders a host dimension rejection with the projected 2000px limit', async () => {
  mountAssembledApp('?fixture&fixturePrompt=reject')

  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  const start = tree.querySelector<HTMLButtonElement>('button[aria-label="New session in fixture"]')
  if (start === null) throw new Error('fixture Workspace new-session action missing')
  fireEvent.click(start)

  const textarea = await waitFor(() => {
    const surface = document.querySelector<HTMLElement>(
      '[data-composer-input][data-placeholder="Describe what you want to build... / commands, @ files or sessions"]',
    )
    if (surface === null) throw new Error('composer surface missing')
    return surface
  }, { timeout: 10_000 })
  const image = new File([new Uint8Array([137, 80, 78, 71])], 'too-wide.png', { type: 'image/png' })
  fireEvent.paste(textarea, {
    clipboardData: {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
      getData: () => '',
    },
  })
  await waitFor(() => {
    expect(document.querySelector('[role="group"][aria-label="Pending attachments"]')).not.toBeNull()
  })
  fireEvent.keyDown(textarea, { key: 'Enter' })

  const message = 'Image sides must be at most 2000px; downscale it and try again'
  const toast = await screen.findByText(message)
  expect({ role: toast.closest('[role="alert"]')?.getAttribute('role'), text: toast.textContent }).toMatchInlineSnapshot(`
    {
      "role": "alert",
      "text": "Image sides must be at most 2000px; downscale it and try again",
    }
  `)
  expect(document.querySelector('[role="group"][aria-label="Pending attachments"]')).not.toBeNull()
})
